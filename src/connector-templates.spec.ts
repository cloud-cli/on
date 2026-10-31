import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { ConnectorTemplateRepository, GITHUB_PUSH_TEMPLATE, GITMINI_TEMPLATE } from "./connector-templates.js";
import { parseConnectorDefinition, evaluateConnector } from "./connector-definition.js";

const sourceYaml = "run: |\n  emit('sample.received', inputs)";

describe("connector template registry", () => {
  let repository: ConnectorTemplateRepository;

  beforeEach(() => {
    vi.resetAllMocks();
    repository = new ConnectorTemplateRepository();
  });

  it("lists credential-free global templates and validates the GitHub push definition", async () => {
    database.all.mockResolvedValue([
      {
        namespace: "on",
        slug: "github-push",
        version: 1,
        name: GITHUB_PUSH_TEMPLATE.name,
        description: GITHUB_PUSH_TEMPLATE.description,
        source_yaml: GITHUB_PUSH_TEMPLATE.sourceYaml,
        publisher: "on",
      },
      {
        namespace: "on",
        slug: "gitmini",
        version: 1,
        name: GITMINI_TEMPLATE.name,
        description: GITMINI_TEMPLATE.description,
        source_yaml: GITMINI_TEMPLATE.sourceYaml,
        publisher: "on",
      },
    ]);
    const templates = await repository.list();
    expect(templates).toContainEqual(expect.objectContaining(GITHUB_PUSH_TEMPLATE));
    expect(templates).toContainEqual(expect.objectContaining(GITMINI_TEMPLATE));
    expect(JSON.stringify(templates)).not.toMatch(/(?:ingress[_ -]?token|signing[_ -]?secret|credential)\s*:/i);
    expect(() => parseConnectorDefinition(GITHUB_PUSH_TEMPLATE.sourceYaml)).not.toThrow();
    expect(() => parseConnectorDefinition(GITMINI_TEMPLATE.sourceYaml)).not.toThrow();
  });

  it("publishes immutable increasing versions and resolves only exact stored versions", async () => {
    database.get
      .mockResolvedValueOnce({
        namespace: "alice",
        slug: "normalize",
        version: 1,
        name: "Normalize",
        description: "Normalize payloads",
        source_yaml: sourceYaml,
        publisher: "alice",
      })
      .mockResolvedValueOnce({
        namespace: "alice",
        slug: "normalize",
        version: 2,
        name: "Normalize v2",
        description: "Normalize payloads",
        source_yaml: sourceYaml,
        publisher: "alice",
      });

    const first = await repository.publish(
      "alice",
      "subject-a",
      "normalize",
      "Normalize",
      "Normalize payloads",
      sourceYaml,
    );
    const second = await repository.publish(
      "alice",
      "subject-a",
      "normalize",
      "Normalize v2",
      "Normalize payloads",
      sourceYaml,
    );
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(database.get).toHaveBeenCalledTimes(2);
    expect(database.get.mock.calls[0][0]).toContain("COALESCE((SELECT MAX(version)");
    expect(database.get.mock.calls[0][0]).toContain("RETURNING namespace, slug, version");
    expect(database.get.mock.calls[0][1]).toContain("subject-a");
  });

  it("uses the preferred username namespace and rejects namespace collisions", async () => {
    database.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ namespace: "alice-team" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ namespace: "someone-else" });
    expect(await repository.namespaceForOwner("subject-a", "Alice Team")).toBe("alice-team");
    await expect(repository.namespaceForOwner("subject-b", "Alice Team")).rejects.toThrow("already owned");
  });

  it("rejects invalid connector source before any registry write", async () => {
    await expect(repository.publish("alice", "subject-a", "bad", "Bad", "Bad source", "run: [")).rejects.toThrow();
    expect(database.get).not.toHaveBeenCalled();
  });

  it("verifies GitHub signature and push payload semantics, rejecting non-push and deleted or zero-SHA events", async () => {
    const crypto = await import("node:crypto");
    const signingSecret = "workspace-secret";
    const payload = {
      ref: "refs/heads/main",
      after: "a".repeat(40),
      deleted: false,
      repository: {
        owner: { login: "octo" },
        name: "sample",
        full_name: "octo/sample",
        clone_url: "https://github.com/octo/sample.git",
        default_branch: "main",
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${crypto.createHmac("sha256", signingSecret).update(body).digest("hex")}`;
    const context = {
      inputs: payload,
      body,
      headers: { "x-hub-signature-256": signature, "x-github-event": "push" },
      secrets: { WEBHOOK_SECRET: signingSecret },
    };
    await expect(evaluateConnector(GITHUB_PUSH_TEMPLATE.sourceYaml, context)).resolves.toEqual([
      {
        type: "git.push",
        data: {
          owner: "octo",
          repo: "sample",
          branch: "main",
          ref: "refs/heads/main",
          repository: "octo/sample",
          clone_url: "https://github.com/octo/sample.git",
          commit_sha: "a".repeat(40),
          default_branch: "main",
          source: "github",
        },
      },
    ]);
    await expect(
      evaluateConnector(GITHUB_PUSH_TEMPLATE.sourceYaml, {
        ...context,
        headers: { ...context.headers, "x-github-event": "issues" },
      }),
    ).rejects.toThrow("Only GitHub push");
    for (const invalid of [
      { ...payload, deleted: true },
      { ...payload, after: "0".repeat(40) },
    ]) {
      const invalidBody = Buffer.from(JSON.stringify(invalid));
      const invalidSignature = `sha256=${crypto.createHmac("sha256", signingSecret).update(invalidBody).digest("hex")}`;
      await expect(
        evaluateConnector(GITHUB_PUSH_TEMPLATE.sourceYaml, {
          ...context,
          inputs: invalid,
          body: invalidBody,
          headers: { ...context.headers, "x-hub-signature-256": invalidSignature },
        }),
      ).rejects.toThrow();
    }
  });

  it("normalizes signed GitMini branch pushes for the shared Docker recipe", async () => {
    const crypto = await import("node:crypto");
    const secret = "gitmini-test-secret";
    const payload = {
      id: "delivery-1",
      org: "team",
      event: "git.push",
      action: "pushed",
      occurredAt: "2026-10-31T00:00:00.000Z",
      object: "team/service",
      details: {
        changes: [
          {
            ref: "refs/heads/release",
            before: "a".repeat(40),
            after: "b".repeat(40),
            action: "updated",
          },
          { ref: "refs/heads/feature", before: "c".repeat(40), after: "d".repeat(40), action: "updated" },
          { ref: "refs/tags/v1", before: null, after: "e".repeat(40), action: "created" },
        ],
      },
    };
    const body = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
    const context = {
      inputs: payload,
      body,
      headers: { "x-gitmini-signature": signature, "x-gitmini-event": "git.push" },
      secrets: { WEBHOOK_SECRET: secret },
    };
    expect(() => parseConnectorDefinition(GITMINI_TEMPLATE.sourceYaml)).not.toThrow();
    await expect(evaluateConnector(GITMINI_TEMPLATE.sourceYaml, context)).resolves.toEqual([
      {
        type: "git.push",
        data: {
          owner: "team",
          repo: "service",
          branch: "release",
          ref: "refs/heads/release",
          repository: "team/service",
          clone_url: "https://git.api.apphor.de/git/team/service.git",
          commitSha: "b".repeat(40),
          commit_sha: "b".repeat(40),
          source: "gitmini",
          event_id: "delivery-1",
        },
      },
      {
        type: "git.push",
        data: {
          owner: "team",
          repo: "service",
          branch: "feature",
          ref: "refs/heads/feature",
          repository: "team/service",
          clone_url: "https://git.api.apphor.de/git/team/service.git",
          commitSha: "d".repeat(40),
          commit_sha: "d".repeat(40),
          source: "gitmini",
          event_id: "delivery-1",
        },
      },
    ]);
  });

  it("fails closed for GitMini invalid signatures and malformed/deleted push refs", async () => {
    const crypto = await import("node:crypto");
    const secret = "gitmini-test-secret";
    const payload = {
      id: "delivery-2",
      event: "git.push",
      action: "pushed",
      object: "team/service",
      details: { changes: [{ ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40) }] },
    };
    const sign = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value));
      return {
        inputs: value,
        body,
        headers: {
          "x-gitmini-signature": `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`,
          "x-gitmini-event": "git.push",
        },
        secrets: { WEBHOOK_SECRET: secret },
      };
    };
    const valid = sign(payload);
    await expect(
      evaluateConnector(GITMINI_TEMPLATE.sourceYaml, {
        ...valid,
        headers: { ...valid.headers, "x-gitmini-signature": "sha256=invalid" },
      }),
    ).rejects.toThrow("Invalid GitMini webhook signature");
    for (const value of [
      { ...payload, details: { changes: [] } },
      { ...payload, details: { changes: [{ ref: "refs/heads/main", after: null, action: "deleted" }] } },
      {
        ...payload,
        details: {
          changes: [{ ref: "refs/heads/main", after: "0000000000000000000000000000000000000000", action: "created" }],
        },
      },
      { ...payload, object: "invalid-repository" },
      { ...payload, object: "../service" },
      { ...payload, object: "team/../service" },
      { ...payload, action: "created" },
      { ...payload, details: { changes: [{ ref: "refs/heads/main", after: "b".repeat(39), action: "updated" }] } },
      {
        ...payload,
        details: { changes: [{ ref: "refs/heads/main", after: "g" + "b".repeat(39), action: "updated" }] },
      },
    ]) {
      await expect(evaluateConnector(GITMINI_TEMPLATE.sourceYaml, sign(value))).rejects.toThrow();
    }
    await expect(
      evaluateConnector(
        GITMINI_TEMPLATE.sourceYaml,
        sign({ ...payload, details: { changes: [{ ref: "refs/tags/v1", after: "b".repeat(40), action: "created" }] } }),
      ),
    ).resolves.toEqual([]);
  });

  it("uses one signed GitMini connector for supported non-push event types without treating them as builds", async () => {
    const crypto = await import("node:crypto");
    const secret = "gitmini-test-secret";
    for (const [event, expected] of [
      ["git.branch", "gitmini.git.branch"],
      ["git.tag", "gitmini.git.tag"],
      ["repo", "gitmini.repo"],
    ]) {
      const payload = {
        id: "delivery-3",
        object: "team/service",
        event,
        action: "created",
        details: { ref: "refs/x" },
      };
      const body = Buffer.from(JSON.stringify(payload));
      const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
      await expect(
        evaluateConnector(GITMINI_TEMPLATE.sourceYaml, {
          inputs: payload,
          body,
          headers: { "x-gitmini-signature": signature, "x-gitmini-event": event },
          secrets: { WEBHOOK_SECRET: secret },
        }),
      ).resolves.toEqual([
        {
          type: expected,
          data: {
            object: "team/service",
            action: "created",
            details: { ref: "refs/x" },
            event_id: "delivery-3",
            source: "gitmini",
          },
        },
      ]);
    }
    const payload = { id: "delivery-4", object: "team/service" };
    const body = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
    await expect(
      evaluateConnector(GITMINI_TEMPLATE.sourceYaml, {
        inputs: payload,
        body,
        headers: { "x-gitmini-signature": signature, "x-gitmini-event": "thread" },
        secrets: { WEBHOOK_SECRET: secret },
      }),
    ).rejects.toThrow("Unsupported GitMini event");
  });
});
