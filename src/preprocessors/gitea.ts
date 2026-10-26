import crypto from "node:crypto";
import type { PreprocessedWebhook, WebhookPreprocessor, WorkflowTrigger } from "../types.js";
import { GitHubPreprocessor } from "./github.js";
import { createGitPushEvent } from "./git-push-event.js";

/** Verifies and normalizes Gitea webhooks to the same provider-neutral Git event contract as GitHub. */
export class GiteaPreprocessor implements WebhookPreprocessor {
  name = "gitea";
  private readonly triggerFilter = new GitHubPreprocessor();

  parse(headers: Record<string, string>, rawBodyBuffer: Buffer, secret?: string): PreprocessedWebhook {
    const signature = headers["x-gitea-signature"] || "";
    const normalizedSignature = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
    if (!secret || !/^[0-9a-f]{64}$/i.test(normalizedSignature)) {
      return { isValid: false, inputs: null as any };
    }
    const expected = crypto.createHmac("sha256", secret).update(rawBodyBuffer).digest();
    const received = Buffer.from(normalizedSignature, "hex");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return { isValid: false, inputs: null as any };
    }
    let body: any;
    try {
      body = JSON.parse(rawBodyBuffer.toString("utf8"));
    } catch {
      return { isValid: false, inputs: null as any };
    }
    const ref = typeof body.ref === "string" ? body.ref : "";
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
    const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
    const fullName =
      typeof body.repository?.full_name === "string"
        ? body.repository.full_name
        : [body.repository?.owner?.login, body.repository?.name].filter(Boolean).join("/");
    const [owner, repo] = fullName.split("/", 2);
    const commits = Array.isArray(body.commits) ? body.commits : body.head_commit ? [body.head_commit] : [];
    return {
      isValid: true,
      inputs: {
        event: headers["x-gitea-event"] || "unknown",
        branch,
        tag,
        owner,
        repo,
        ref: branch || tag,
        full_name: fullName,
        clone_url: body.repository?.clone_url,
        commit_sha: body.after || body.head_commit?.id,
        author: body.pusher?.name || body.sender?.login,
        action: body.action,
        raw: body,
        changes: Array.from(
          new Set(
            commits.flatMap((commit: any) => [
              ...(Array.isArray(commit.added) ? commit.added : []),
              ...(Array.isArray(commit.removed) ? commit.removed : []),
              ...(Array.isArray(commit.modified) ? commit.modified : []),
            ]),
          ),
        ),
      },
    };
  }

  filter(inputs: Record<string, any>, trigger: WorkflowTrigger): PreprocessedWebhook {
    return this.triggerFilter.filter!(inputs, trigger);
  }

  toDomainEvent(headers: Record<string, string>, inputs: Record<string, any>, receivedAt: string) {
    if (inputs.event !== "push" || typeof inputs.commit_sha !== "string" || !inputs.commit_sha || !inputs.full_name) {
      return null;
    }
    return createGitPushEvent({
      provider: "gitea",
      deliveryId: headers["x-gitea-delivery"],
      occurredAt: inputs.raw?.head_commit?.timestamp,
      receivedAt,
      repository: inputs.full_name,
      owner: inputs.owner,
      name: inputs.repo,
      ref: inputs.raw?.ref || "",
      commit: inputs.commit_sha,
      deleted: inputs.raw?.deleted,
    });
  }
}
