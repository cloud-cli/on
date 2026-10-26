import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const database = vi.hoisted(() => ({
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("./db-client.js", () => ({ default: database }));

import { WorkflowRunAdmissionRepository, type WorkflowRunVariant } from "./workflow-run-admission-repository.js";

const repository = new WorkflowRunAdmissionRepository();
let connection: DatabaseSync;
let directory: string;
let failAfterFirstAdmissionInsert: boolean;

function parameters(values: unknown[] = []): SQLInputValue[] {
  return values as SQLInputValue[];
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "workflow-run-plan-"));
  connection = new DatabaseSync(path.join(directory, "admissions.sqlite"));
  connection.exec(`
    CREATE TABLE workflow_run_admissions (
      event_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      variant_index INTEGER NOT NULL,
      matrix_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      admission_outcome TEXT,
      job_id INTEGER,
      error_code TEXT,
      lease_token TEXT,
      lease_until TEXT,
      retry_after TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, variant_index)
    );
    CREATE TABLE workflow_run_admission_plans (
      event_id TEXT PRIMARY KEY,
      variant_count INTEGER NOT NULL,
      plan_hash TEXT NOT NULL
    );
  `);
  failAfterFirstAdmissionInsert = false;

  database.all.mockImplementation(async (sql: string, values: unknown[] = []) =>
    connection.prepare(sql).all(...parameters(values)),
  );
  database.get.mockImplementation(async (sql: string, values: unknown[] = []) =>
    connection.prepare(sql).get(...parameters(values)),
  );
  database.run.mockImplementation(async (sql: string, values: unknown[] = []) =>
    connection.prepare(sql).run(...parameters(values)),
  );
  database.transaction.mockImplementation(async (statements: Array<{ s: string; d: unknown[]; m: string }>) => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        connection.prepare(statement.s).run(...parameters(statement.d));
        if (failAfterFirstAdmissionInsert && statement.s.includes("INSERT OR IGNORE INTO workflow_run_admissions")) {
          failAfterFirstAdmissionInsert = false;
          throw new Error("injected failure after first plan insert");
        }
      }
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  });
});

afterEach(() => {
  connection.close();
  rmSync(directory, { recursive: true, force: true });
  vi.resetAllMocks();
});

const plan = (eventId = "evt-plan", values = ["one", "two"]): WorkflowRunVariant[] =>
  values.map((value, index) => ({
    eventId,
    teamId: "team-1",
    workflowId: "workflow-1",
    revision: 3,
    index,
    matrix: { axis: value },
    tags: [value],
  }));

describe("workflow-run admission plan SQLite integration", () => {
  it("rolls back a failed plan, recovers after reopen, and only then claims every variant", async () => {
    const variants = plan();
    failAfterFirstAdmissionInsert = true;
    await expect(repository.persistPlan(variants)).rejects.toThrow("injected failure");
    expect(connection.prepare("SELECT COUNT(*) AS count FROM workflow_run_admissions").get()?.count).toBe(0);
    expect(connection.prepare("SELECT COUNT(*) AS count FROM workflow_run_admission_plans").get()?.count).toBe(0);
    await expect(repository.claimNext()).resolves.toBeNull();

    connection.close();
    connection = new DatabaseSync(path.join(directory, "admissions.sqlite"));
    await expect(repository.claimNext()).resolves.toBeNull();

    await repository.persistPlan(variants);
    expect(
      connection.prepare("SELECT variant_count FROM workflow_run_admission_plans WHERE event_id = ?").get("evt-plan")
        ?.variant_count,
    ).toBe(2);
    const claims = [await repository.claimNext(), await repository.claimNext()];
    expect(claims.map((claim) => claim?.index).sort()).toEqual([0, 1]);
    expect(claims.map((claim) => claim?.matrix.axis).sort()).toEqual(["one", "two"]);
    await expect(repository.getPlan("evt-plan")).resolves.toEqual(variants);
    await expect(repository.claimNext()).resolves.toBeNull();
  });

  it("does not make a conflicting plan partially or inconsistently claimable", async () => {
    const original = plan();
    await repository.persistPlan(original);
    await expect(repository.persistPlan(plan("evt-plan", ["one", "conflict"]))).rejects.toThrow(
      "incomplete or conflicts",
    );

    const rows = connection
      .prepare(
        "SELECT variant_index, matrix_json FROM workflow_run_admissions WHERE event_id = ? ORDER BY variant_index",
      )
      .all("evt-plan") as Array<{ variant_index: number; matrix_json: string }>;
    expect(rows.map((row) => [row.variant_index, JSON.parse(row.matrix_json)])).toEqual([
      [0, { axis: "one" }],
      [1, { axis: "two" }],
    ]);
    expect(
      connection.prepare("SELECT variant_count FROM workflow_run_admission_plans WHERE event_id = ?").get("evt-plan")
        ?.variant_count,
    ).toBe(2);

    const claims = [await repository.claimNext(), await repository.claimNext()];
    expect(
      claims
        .map((claim) => [claim?.index, claim?.matrix.axis])
        .sort((left, right) => Number(left[0]) - Number(right[0])),
    ).toEqual([
      [0, "one"],
      [1, "two"],
    ]);
    await expect(repository.claimNext()).resolves.toBeNull();
  });

  it("retains terminal admission decisions and accepted job linkage after SQLite reopen", async () => {
    const rejected = {
      eventId: "evt-rejected",
      teamId: "team-1",
      workflowId: "workflow-1",
      revision: 3,
      index: -1,
      matrix: {},
      tags: [],
    };
    await repository.persistTerminal(rejected, "failed", "invalid_inputs", "rejected");
    await repository.persistPlan(plan("evt-accepted", ["one"]));
    const claim = await repository.claimVariant("evt-accepted", 0);
    expect(claim).not.toBeNull();
    expect(await repository.finish(claim!, "admitted", 123)).toBe(true);

    connection.close();
    connection = new DatabaseSync(path.join(directory, "admissions.sqlite"));

    await expect(repository.get("evt-rejected", -1)).resolves.toMatchObject({
      status: "failed",
      admissionOutcome: "rejected",
      errorCode: "invalid_inputs",
      jobId: null,
    });
    await expect(repository.get("evt-accepted", 0)).resolves.toMatchObject({
      status: "admitted",
      admissionOutcome: "accepted",
      jobId: 123,
    });
    await expect(repository.claimVariant("evt-accepted", 0)).resolves.toBeNull();
  });
});
