import { DatabaseSync } from "node:sqlite";

const location = process.env.OIDC_TEST_DB_PATH;
if (!location) {
  throw new Error("OIDC_TEST_DB_PATH is required for the isolated OIDC test database");
}

const database = new DatabaseSync(location);
database.exec("PRAGMA foreign_keys = ON");

function execute(statement, values = []) {
  const method = statement.m || "run";
  const sql = statement.s;
  if (method === "exec") {
    database.exec(sql);
    return undefined;
  }
  const prepared = database.prepare(sql);
  if (method === "get") {
    return prepared.get(...values);
  }
  if (method === "all") {
    return prepared.all(...values);
  }
  if (method === "run") {
    return prepared.run(...values);
  }
  throw new Error(`Unsupported SQLite statement method: ${method}`);
}

export async function get(sql, values = []) {
  return database.prepare(sql).get(...values);
}

export async function all(sql, values = []) {
  return database.prepare(sql).all(...values);
}

export async function run(sql, values = []) {
  return database.prepare(sql).run(...values);
}

export async function exec(sql) {
  database.exec(sql);
}

export async function transaction(statements) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const results = statements.map((statement) => execute(statement, statement.d || []));
    database.exec("COMMIT");
    return results;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function pragma(statement) {
  return database.prepare(`PRAGMA ${statement}`).all();
}

export default { get, all, run, exec, transaction, pragma };
