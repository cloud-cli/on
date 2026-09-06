import { describe, expect, it } from 'vitest';
import { timestampLogLines } from './timestamped-log.js';

describe('timestampLogLines', () => {
  it('timestamps each line and preserves existing timestamps', () => {
    const timestamped = '[2026-09-06T14:00:00.000Z] existing\n';
    const output = timestampLogLines(`${timestamped}new\nlast`);

    expect(output).toMatch(/^\[2026-09-06T14:00:00\.000Z\] existing\n/);
    expect(output).toMatch(/\n\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] new\n/);
    expect(output).toMatch(/\n\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] last$/);
  });
});
