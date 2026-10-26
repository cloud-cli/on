import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { GiteaPreprocessor } from "./gitea.js";
import { GitHubPreprocessor } from "./github.js";

const secret = "fixture-webhook-secret";
const bodyObject = {
  ref: "refs/heads/main",
  after: "immutable-commit-sha",
  repository: {
    full_name: "octocat/example",
    name: "example",
    owner: { login: "octocat" },
    clone_url: "https://git.example.test/octocat/example.git",
  },
  head_commit: { id: "immutable-commit-sha", timestamp: "2026-01-02T03:04:05Z" },
  commits: [{ added: ["new.txt"], modified: ["README.md"], removed: [] }],
  token: "must-not-leak",
};

function signedRequest(body: unknown, provider: "github" | "gitea", delivery = "delivery-1") {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return {
    raw,
    headers:
      provider === "github"
        ? {
            "x-github-event": "push",
            "x-github-delivery": delivery,
            "x-hub-signature-256": `sha256=${signature}`,
          }
        : {
            "x-gitea-event": "push",
            "x-gitea-delivery": delivery,
            "x-gitea-signature": signature,
          },
  };
}

describe("GiteaPreprocessor", () => {
  const gitea = new GiteaPreprocessor();

  it("verifies Gitea's raw-body signature and rejects missing or invalid signatures", () => {
    const request = signedRequest(bodyObject, "gitea");
    expect(gitea.parse(request.headers, request.raw, secret).isValid).toBe(true);
    expect(gitea.parse({}, request.raw, secret).isValid).toBe(false);
    expect(gitea.parse({ "x-gitea-signature": "0".repeat(64) }, request.raw, secret).isValid).toBe(false);
    expect(gitea.parse(request.headers, request.raw, "wrong-secret").isValid).toBe(false);
  });

  it("normalizes equivalent GitHub and Gitea pushes to the same immutable event data", () => {
    const githubRequest = signedRequest(bodyObject, "github");
    const giteaRequest = signedRequest(bodyObject, "gitea");
    const githubParsed = new GitHubPreprocessor().parse(githubRequest.headers, githubRequest.raw, secret);
    const giteaParsed = gitea.parse(giteaRequest.headers, giteaRequest.raw, secret);
    const receivedAt = "2026-01-03T00:00:00.000Z";
    const githubEvent = new GitHubPreprocessor().toDomainEvent(githubRequest.headers, githubParsed.inputs, receivedAt);
    const giteaEvent = gitea.toDomainEvent(giteaRequest.headers, giteaParsed.inputs, receivedAt);

    expect(giteaParsed.inputs).toMatchObject({ owner: "octocat", repo: "example", ref: "main", commit_sha: "immutable-commit-sha" });
    expect(giteaEvent).toMatchObject({
      type: "git.push",
      schemaVersion: 1,
      source: "connector/gitea",
      occurredAt: "2026-01-02T03:04:05.000Z",
      causationId: "delivery-1",
      idempotencyKey: "gitea:delivery:delivery-1",
    });
    expect(giteaEvent?.data).toEqual(githubEvent?.data);
    expect(JSON.stringify(giteaEvent)).not.toContain("must-not-leak");
    expect(gitea.filter(giteaParsed.inputs, { provider: "gitea", branches: "main" }).isValid).toBe(true);
    expect(gitea.toDomainEvent(giteaRequest.headers, { ...giteaParsed.inputs, event: "issues" }, receivedAt)).toBeNull();
  });
});
