import { describe, expect, it } from 'vitest';
import db, { all, clone, exec, get, run, schema, transaction } from './db-client.js';

describe('database client adapter', () => {
  it('preserves the database module API while keeping existing method exports', () => {
    expect(typeof db.get).toBe('function');
    expect(typeof db.run).toBe('function');
    expect(typeof db.all).toBe('function');
    expect(typeof db.exec).toBe('function');
    expect(typeof db.transaction).toBe('function');
    expect(typeof db.schema).toBe('function');
    expect(typeof db.clone).toBe('function');
    expect([get, run, all, exec, transaction, schema, clone].every((method) => typeof method === 'function')).toBe(true);
  });
});
