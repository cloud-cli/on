import crypto from 'node:crypto';
import YAML from 'yaml';
import db from './db-client.js';
import { expandMatrix } from './parser/matrix-expander.js';
import type { WorkflowDefinition, WorkflowRevision } from './types.js';

export interface StoredWorkflow {
  id: string;
  name: string;
  sourceYaml: string;
  revision: number;
  status: 'draft' | 'published' | 'archived';
}

function workflowId(value: unknown): string {
  const id = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '');
  if (!id) throw new Error('Workflow requires a name or id');
  return id;
}

/** Parses the portable, DB-stored YAML format. Includes are deliberately unsupported. */
export function parseWorkflow(sourceYaml: string): WorkflowDefinition[] {
  const parsed = YAML.parse(sourceYaml);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Workflow must be a YAML object');
  if (parsed.includes) throw new Error('includes is not supported for database workflows');
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error('Workflow name is required');
  if (!Array.isArray(parsed.steps) || !parsed.steps.length) throw new Error('Workflow requires at least one step');
  if (!parsed.on || typeof parsed.on !== 'object') throw new Error('Workflow requires an on block');

  return expandMatrix(parsed).map((workflow: any) => {
    const webhook = Object.entries(workflow.on).find(([name]) => name !== 'schedule' && name !== 'solar');
    const [provider, trigger] = webhook || ['generic', {}];
    return {
      id: workflowId(workflow.id || workflow.name),
      name: workflow.name,
      on: { ...(trigger as object), provider },
      schedule: Array.isArray(workflow.on.schedule) ? workflow.on.schedule : undefined,
      solar: Array.isArray(workflow.on.solar) ? workflow.on.solar : undefined,
      concurrency: workflow.concurrency,
      steps: workflow.steps,
      env: workflow.env,
      tags: Array.isArray(workflow.tags) ? [...new Set((workflow.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))] : undefined,
    };
  });
}

export class WorkflowRepository {
  async init(): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, source_yaml TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', active_revision INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS workflow_revisions (
        workflow_id TEXT NOT NULL, revision INTEGER NOT NULL, source_yaml TEXT NOT NULL,
        normalized_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workflow_id, revision)
      );
      CREATE TABLE IF NOT EXISTS scheduled_runs (
        workflow_id TEXT NOT NULL, trigger_id TEXT NOT NULL, scheduled_for TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workflow_id, trigger_id, scheduled_for)
      );
    `);
  }

  validate(sourceYaml: string): WorkflowDefinition[] {
    const workflows = parseWorkflow(sourceYaml);
    for (const workflow of workflows) {
      for (const schedule of workflow.schedule || []) {
        if (typeof schedule.cron !== 'string' || schedule.cron.trim().split(/\s+/).length !== 5) throw new Error('schedule.cron must have five fields');
      }
      for (const solar of workflow.solar || []) {
        if (!solar.event || !Number.isFinite(solar.latitude) || !Number.isFinite(solar.longitude)) throw new Error('solar triggers require event, latitude, and longitude');
      }
    }
    return workflows;
  }

  async saveDraft(id: string, sourceYaml: string): Promise<StoredWorkflow> {
    const workflows = this.validate(sourceYaml);
    if (workflows.length !== 1 || workflows[0].id !== id) throw new Error('Workflow id must match the YAML name or id');
    const previous = await db.get('SELECT COALESCE(MAX(revision), 0) AS revision FROM workflow_revisions WHERE workflow_id = ?', [id]);
    const revision = Number(previous?.revision || 0) + 1;
    await db.run(`INSERT INTO workflows (id, name, source_yaml, status) VALUES (?, ?, ?, 'draft')
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, source_yaml = excluded.source_yaml, status = 'draft', updated_at = CURRENT_TIMESTAMP`, [id, workflows[0].name, sourceYaml]);
    await db.run('INSERT INTO workflow_revisions (workflow_id, revision, source_yaml, normalized_json) VALUES (?, ?, ?, ?)', [id, revision, sourceYaml, JSON.stringify(workflows[0])]);
    return { id, name: workflows[0].name, sourceYaml, revision, status: 'draft' };
  }

  async publish(id: string): Promise<StoredWorkflow | null> {
    const workflow = await db.get('SELECT * FROM workflows WHERE id = ?', [id]);
    if (!workflow) return null;
    this.validate(workflow.source_yaml);
    const revision = await db.get('SELECT MAX(revision) AS revision FROM workflow_revisions WHERE workflow_id = ?', [id]);
    await db.run("UPDATE workflows SET status = 'published', active_revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [revision.revision, id]);
    return { id, name: workflow.name, sourceYaml: workflow.source_yaml, revision: Number(revision.revision), status: 'published' };
  }

  async list(): Promise<StoredWorkflow[]> {
    const rows = await db.all('SELECT id, name, source_yaml, COALESCE(active_revision, 0) AS revision, status FROM workflows ORDER BY name');
    return rows.map((row: any) => ({ id: row.id, name: row.name, sourceYaml: row.source_yaml, revision: Number(row.revision), status: row.status }));
  }

  async get(id: string): Promise<StoredWorkflow | null> {
    const row = await db.get('SELECT id, name, source_yaml, COALESCE(active_revision, 0) AS revision, status FROM workflows WHERE id = ?', [id]);
    return row ? { id: row.id, name: row.name, sourceYaml: row.source_yaml, revision: Number(row.revision), status: row.status } : null;
  }

  async published(): Promise<WorkflowRevision[]> {
    const rows = await db.all(`SELECT w.id AS workflow_id, r.revision, r.normalized_json FROM workflows w JOIN workflow_revisions r
      ON r.workflow_id = w.id AND r.revision = w.active_revision WHERE w.status = 'published'`);
    return rows.map((row: any) => ({ workflowId: row.workflow_id, revision: Number(row.revision), definition: JSON.parse(row.normalized_json) }));
  }

  async getRevision(workflowId: string, revision: number): Promise<WorkflowDefinition | null> {
    const row = await db.get('SELECT normalized_json FROM workflow_revisions WHERE workflow_id = ? AND revision = ?', [workflowId, revision]);
    return row ? JSON.parse(row.normalized_json) : null;
  }

  async claimScheduledRun(workflowId: string, triggerId: string, scheduledFor: string): Promise<boolean> {
    const row = await db.get(`INSERT INTO scheduled_runs (workflow_id, trigger_id, scheduled_for) VALUES (?, ?, ?)
      ON CONFLICT(workflow_id, trigger_id, scheduled_for) DO NOTHING RETURNING workflow_id`, [workflowId, triggerId, scheduledFor]);
    return Boolean(row);
  }
}
