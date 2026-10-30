import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobRecord, Processable, WorkflowExecutionReport } from "../src/types.js";

process.env.DATABASE_URL = new URL("./docker-e2e-db.mjs", import.meta.url).href;
const [{ processJob }, { StandardProcessDriver }, { parseWorkflow }, { evaluateConnector }] = await Promise.all([
  import("../src/worker.js"),
  import("../src/drivers/standard-process.driver.js"),
  import("../src/workflows.js"),
  import("../src/connector-definition.js"),
]);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "on-connector-workflow-"));
const connectorYaml = `kind: connector
id: normalize
name: Normalize input
steps:
  - id: map
    eval: "({ type: 'sample.received', data: { value: body.value } })"
`;
const rawInput = Buffer.from(JSON.stringify({ value: "transformed" }));
const normalizedEvent = await evaluateConnector(connectorYaml, {
  input: { contentType: "application/json", body: JSON.parse(rawInput.toString("utf8")) },
  headers: { "content-type": "application/json" },
});
const [workflow] = parseWorkflow(`
id: consume-sample
name: Consume sample
on:
  events: [sample.received]
steps:
  - id: verify-input
    image: node:22-alpine
    env:
      VALUE: "${"${inputs.value}"}"
    run: test "$VALUE" = "transformed" && echo connector-input-ok
`);

function queueFor() {
  let report: WorkflowExecutionReport | undefined;
  return {
    saveReport: async (_id: number, nextReport: WorkflowExecutionReport) => {
      report = nextReport;
    },
    saveStepLog: async () => {},
    saveStepAttemptStart: async () => {},
    saveStepAttempt: async () => {},
    completeJob: async (_id: number, _status: string, finalReport: WorkflowExecutionReport) => {
      report = finalReport;
    },
    isCancelled: async () => false,
    get report() {
      return report;
    },
  };
}

function job(id: number): JobRecord {
  return {
    id,
    workflow_id: workflow.id,
    workflow_revision: 1,
    required_tags: "[]",
    concurrency_key: null,
    status: "running",
    worker_id: "local-connector-test",
    payload: JSON.stringify({ inputs: normalizedEvent.data }),
    created_at: new Date().toISOString(),
  } as JobRecord;
}

try {
  const queue = queueFor();
  const processable: Processable = {
    workerId: "local-connector-test",
    job: job(1),
    queue,
    secrets: { getAll: () => ({}), redactText: (value: string) => value },
    config: {
      storagePath: path.join(root, "jobs"),
      serverUrl: "http://localhost",
      env: {},
      plugins: [],
    },
    driver: new StandardProcessDriver(),
    workflow,
  } as Processable;
  await processJob(processable);
  const result = queue.report?.steps.find((step) => step.id === "verify-input");
  if (queue.report?.status !== "success" || result?.status !== "success") {
    throw new Error(`Connector-driven workflow failed: ${result?.error || queue.report?.status}`);
  }
  console.log("Local JSON connector transformation -> normalized event -> workflow run passed.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
