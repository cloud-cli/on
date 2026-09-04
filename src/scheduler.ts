import { QueueManager } from './queue.js';
import type { JobPayload, RunnerConfig, ScheduleTrigger, WorkflowDefinition } from './types.js';
import { WorkflowRepository } from './workflows.js';

function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some((part) => {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    const [startText, endText] = range === '*' ? [String(min), String(max)] : range.split('-');
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    return Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end && (value - start) % step === 0;
  });
}

/** Five-field cron matching with an IANA timezone. Day-of-month and day-of-week follow cron OR semantics. */
export function cronMatches(cron: string, time: Date, timezone = 'UTC'): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(time).reduce((result, part) => ({ ...result, [part.type]: part.value }), {} as Record<string, string>);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday);
  const dayOfMonthMatches = cronFieldMatches(fields[2], Number(values.day), 1, 31);
  const dayOfWeekMatches = cronFieldMatches(fields[4].replace(/7/g, '0'), weekday, 0, 6);
  return cronFieldMatches(fields[0], Number(values.minute), 0, 59)
    && cronFieldMatches(fields[1], Number(values.hour), 0, 23)
    && cronFieldMatches(fields[3], Number(values.month), 1, 12)
    && (fields[2] === '*' || fields[4] === '*' ? dayOfMonthMatches && dayOfWeekMatches : dayOfMonthMatches || dayOfWeekMatches);
}

function offsetMilliseconds(value?: string): number {
  if (!value) return 0;
  const match = value.match(/^([+-]?)(\d+)(m|h)$/);
  if (!match) throw new Error(`Invalid solar offset: ${value}`);
  return (match[1] === '-' ? -1 : 1) * Number(match[2]) * (match[3] === 'h' ? 3_600_000 : 60_000);
}

// NOAA's public-domain sunrise equation. It is accurate enough for minute-level CI triggers.
function solarEvent(date: Date, trigger: ScheduleTrigger): Date | null {
  const latitude = trigger.latitude!;
  const longitude = trigger.longitude!;
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = Math.floor((start - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86_400_000);
  const lngHour = longitude / 15;
  const approx = day + ((trigger.event === 'sunrise' ? 6 : 18) - lngHour) / 24;
  const meanAnomaly = 0.9856 * approx - 3.289;
  let longitudeSun = meanAnomaly + 1.916 * Math.sin(meanAnomaly * Math.PI / 180) + 0.02 * Math.sin(2 * meanAnomaly * Math.PI / 180) + 282.634;
  longitudeSun = (longitudeSun + 360) % 360;
  let rightAscension = Math.atan(0.91764 * Math.tan(longitudeSun * Math.PI / 180)) * 180 / Math.PI;
  rightAscension = (rightAscension + 360) % 360;
  rightAscension += (Math.floor(longitudeSun / 90) * 90) - (Math.floor(rightAscension / 90) * 90);
  rightAscension /= 15;
  const sinDeclination = 0.39782 * Math.sin(longitudeSun * Math.PI / 180);
  const cosDeclination = Math.cos(Math.asin(sinDeclination));
  const cosineHour = (Math.cos(90.833 * Math.PI / 180) - sinDeclination * Math.sin(latitude * Math.PI / 180)) / (cosDeclination * Math.cos(latitude * Math.PI / 180));
  if (cosineHour > 1 || cosineHour < -1) return null;
  let hour = (trigger.event === 'sunrise' ? 360 - Math.acos(cosineHour) * 180 / Math.PI : Math.acos(cosineHour) * 180 / Math.PI) / 15;
  const localMean = hour + rightAscension - 0.06571 * approx - 6.622;
  hour = (localMean - lngHour + 24) % 24;
  return new Date(start + hour * 3_600_000 + offsetMilliseconds(trigger.offset));
}

export class WorkflowScheduler {
  private timer?: NodeJS.Timeout;

  constructor(private queue: QueueManager, private workflows: WorkflowRepository, private config: RunnerConfig) {}

  start(intervalMs = 15_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    console.log(`Scheduler started with ${intervalMs}ms polling`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    for (const workflow of await this.workflows.published()) {
      for (const [index, trigger] of (workflow.schedule || []).entries()) {
        if (cronMatches(trigger.cron!, minute, trigger.timezone || 'UTC')) await this.enqueue(workflow, trigger, `cron-${index}`, minute);
      }
      for (const [index, trigger] of (workflow.solar || []).entries()) {
        const event = solarEvent(minute, trigger);
        if (event && Math.floor(event.getTime() / 60_000) === minute.getTime() / 60_000) await this.enqueue(workflow, trigger, `solar-${index}`, minute);
      }
    }
  }

  private async enqueue(workflow: WorkflowDefinition, trigger: ScheduleTrigger, defaultId: string, scheduledFor: Date): Promise<void> {
    const triggerId = trigger.id || defaultId;
    if (!await this.workflows.claimScheduledRun(workflow.id, triggerId, scheduledFor.toISOString())) return;
    const payload: JobPayload = {
      workflowId: workflow.id,
      steps: workflow.steps,
      env: workflow.env,
      tags: workflow.tags,
      inputs: { trigger: { type: trigger.cron ? 'schedule' : 'solar', id: triggerId, scheduledFor: scheduledFor.toISOString(), ...trigger } },
    };
    await this.queue.enqueue(workflow.id, payload);
    console.log(`Scheduled ${workflow.id} via ${triggerId}`);
  }
}
