import { describe, expect, it } from 'vitest';
import { cronMatches } from './scheduler.js';

describe('cronMatches', () => {
  it('matches a five-field cron expression in its timezone', () => {
    expect(cronMatches('0 2 * * *', new Date('2026-01-01T02:00:00Z'), 'UTC')).toBe(true);
    expect(cronMatches('0 2 * * *', new Date('2026-01-01T02:01:00Z'), 'UTC')).toBe(false);
  });

  it('uses cron day-of-month and day-of-week OR semantics', () => {
    expect(cronMatches('0 0 2 * 1', new Date('2026-01-05T00:00:00Z'))).toBe(true);
    expect(cronMatches('0 0 2 * 1', new Date('2026-01-02T00:00:00Z'))).toBe(true);
  });
});
