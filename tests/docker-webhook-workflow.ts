import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobRecord, Processable, WorkflowExecutionReport } from "../src/types.js";

process.env.DATABASE_URL = new URL("./docker-e2e-db.mjs", import.meta.url).href;
const [{ processJob }, { StandardProcessDriver }, { parseWorkflow }] = await Promise.all([
  import("../src/worker.js"),
  import("../src/drivers/standard-process.driver.js"),
  import("../src/workflows.js"),
]);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "on-webhook-workflow-"));
const repository = "octocat/hello-world";
const cloneUrl = "https://example.invalid/octocat/hello-world.git";
const commitSha = "0123456789abcdef0123456789abcdef01234567";
const ref = "refs/heads/main";
const rawRequest = Buffer.from(
  JSON.stringify({
    ref,
    after: commitSha,
    repository: { full_name: repository, clone_url: cloneUrl },
  }),
);
const [intakeWorkflow] = parseWorkflow(`
id: github-push-intake
name: GitHub push intake
on:
  webhook:
    events: [push]
steps:
  - id: normalize
    eval: "({ repository: JSON.parse(body.toString('utf8')).repository.full_name, clone_url: JSON.parse(body.toString('utf8')).repository.clone_url, commit_sha: JSON.parse(body.toString('utf8')).after, ref: JSON.parse(body.toString('utf8')).ref })"
  - id: dispatch-build
    dispatch: docker-build
    with: "({ repository: steps.normalize.outputs.repository, clone_url: steps.normalize.outputs.clone_url, commit_sha: steps.normalize.outputs.commit_sha, ref: steps.normalize.outputs.ref })"
`);
const [buildWorkflow] = parseWorkflow(`
id: docker-build
name: Docker build
on:
  events: [git.push]
steps:
  - id: verify-input
    image: node:22-alpine
    env:
      REPOSITORY: "${"${inputs.repository}"}"
      COMMIT_SHA: "${"${inputs.commit_sha}"}"
      REF: "${"${inputs.ref}"}"
    run: test "$REPOSITORY" = "${repository}" && test "$COMMIT_SHA" = "${commitSha}" && test "$REF" = "${ref}" && echo docker-build-input-ok
`);

function makeQueue() {
  let report: WorkflowExecutionReport | undefined;
  let dispatchedInputs: Record<string, unknown> | undefined;
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
    dispatch: async (_parentId: string | number, _stepId: string, target: string, inputs: Record<string, unknown>) => {
      if (target !== "docker-build") {
        throw new Error(`Unexpected workflow target: ${target}`);
      }
      dispatchedInputs = inputs;
      return { jobId: "local-build-job" };
    },
    get report() {
      return report;
    },
    get dispatchedInputs() {
      return dispatchedInputs;
    },
  };
}

function job(id: number, workflowId: string, inputs: Record<string, unknown>): JobRecord {
  return {
    id,
    workflow_id: workflowId,
    workflow_revision: 1,
    required_tags: "[]",
    concurrency_key: null,
    status: "running",
    worker_id: "local-docker-test",
    payload: JSON.stringify(inputs),
    created_at: new Date().toISOString(),
  } as JobRecord;
}

function processable(id: number, workflow: any, inputs: Record<string, unknown>, queue: any): Processable {
  return {
    workerId: "local-docker-test",
    job: job(id, workflow.id, inputs),
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
}

try {
  const intakeQueue = makeQueue();
  await processJob(
    processable(
      1,
      intakeWorkflow,
      {
        inputs: {},
        headers: { "x-github-event": "push" },
        body: rawRequest,
      },
      intakeQueue,
    ),
  );
  if (
    JSON.stringify(intakeQueue.dispatchedInputs) !==
    JSON.stringify({ repository, clone_url: cloneUrl, commit_sha: commitSha, ref })
  ) {
    throw new Error(`Unexpected normalized workflow inputs: ${JSON.stringify(intakeQueue.dispatchedInputs)}`);
  }

  const buildQueue = makeQueue();
  await processJob(processable(2, buildWorkflow, { inputs: intakeQueue.dispatchedInputs }, buildQueue));
  const buildResult = buildQueue.report?.steps.find((step) => step.id === "verify-input");
  if (buildQueue.report?.status !== "success" || buildResult?.status !== "success") {
    throw new Error(`Docker build workflow failed: ${buildResult?.error || buildQueue.report?.status}`);
  }
  console.log("Local webhook eval -> workflow dispatch -> Docker step passed.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
