const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required');

const loaded = await import(databaseUrl);
const db = loaded.default || loaded;

if (!db || typeof db.get !== 'function' || typeof db.run !== 'function' || typeof db.all !== 'function' || typeof db.exec !== 'function') {
  throw new Error(`Database module ${databaseUrl} does not expose get, run, all, and exec`);
}

export const get = db.get.bind(db);
export const run = db.run.bind(db);
export const all = db.all.bind(db);
export const exec = db.exec.bind(db);
export const pragma = typeof db.pragma === 'function' ? db.pragma.bind(db) : () => undefined;
export const transaction = typeof db.transaction === 'function' ? db.transaction.bind(db) : undefined;
export const schema = typeof db.schema === 'function' ? db.schema.bind(db) : undefined;
export const clone = typeof db.clone === 'function' ? db.clone.bind(db) : undefined;

export default db;
