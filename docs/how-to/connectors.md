# Create and manage an HTTP connector

A connector accepts an HTTP request at a private tokenized URL, evaluates a restricted YAML program, and publishes the
events emitted by that program as workspace domain events. Event subscriptions determine whether any workflow receives
an event. A receipt is not a workflow run. A program may emit multiple events; emitting none is valid.

## Connector definition

```yaml
run: |
  if (inputs.status === "complete") {
    emit("deployment.completed", {
      environment: String(inputs.environment),
      revision: String(inputs.revision),
      requestId: headers["x-request-id"]
    });
  }
```

The YAML source has a single top-level `run: |` program. Connector ID and name are metadata supplied separately by the
management UI/API; they do not belong in the YAML. At runtime, `inputs` is a parsed JSON object, `body` is the raw
request body as a Buffer, `headers` contains request headers except host/origin and proxy-routing metadata,
`secrets.WEBHOOK_SECRET` is the configured webhook
secret, `verifyBody(body, signature)` is available for checking a signature, and `emit(type, data)` emits a normalized
domain event. Other headers, including authorization/cookie headers, remain available to the connector program. Event
`data` should contain only suitable domain data; avoid forwarding credentials or other secrets.

Programs are interpreted by a restricted AST interpreter. It supports block, `if`, expression, `throw`, and bounded
`for...of` statements (at most 64 array items); it does not execute `Function` or arbitrary JavaScript. Use the
runtime-provided verification and emission helpers rather than assuming general-purpose APIs are available.

Previously published step-based connector definitions remain executable for compatibility if they have no webhook
secret. New saves and publishes require the `run` format. Legacy connectors with a configured webhook secret fail
closed and must be rewritten to the `run` format to use `verifyBody`; their saved receipt replays require that update as
well.

A ready-to-install **GitHub push** template is available in **Recipes → Connector templates**. Install an exact template
version into each workspace that needs it, then use that install's one-time signing secret as the GitHub webhook secret
and configure the repository/org webhook to send push events to that connector's one-time URL. No organization or
repository is embedded in the global template. It verifies `X-Hub-Signature-256` against the raw body, requires the
`X-GitHub-Event: push` header, rejects deleted refs and zero commit SHAs, and emits a normalized `git.push` event with
owner, repository, branch/ref, clone URL, commit SHA, default branch, and `source: github`.

Connector authors can publish their own immutable global template versions in the same catalog. A fork copies the
selected version's source into the editor; publishing creates a new version under the publisher's identity-derived
namespace. Templates must not contain credentials. Every installation receives its own connector identity and fresh
ingress/signing credentials.

Subscribe a workflow to `git.push` to receive the emitted event data in `inputs.data`:

```yaml
id: deploy-push
name: Deploy push
on:
  events: [git.push]
steps:
  - id: deploy
    env:
      REVISION: ${inputs.data.commitSha}
      REPOSITORY: ${inputs.data.owner}/${inputs.data.repo}
    run: ./deploy "$REPOSITORY" "$REVISION"
```

GitMini signs the exact JSON body with HMAC-SHA-256 in `X-GitMini-Signature` (`sha256=<hex>`) and identifies each
delivery with `X-GitMini-Event` and `X-GitMini-Delivery`. The shared **GitMini webhook** template verifies the raw-body
signature and accepts the service's supported `git.push`, `git.branch`, `git.tag`, and `repo` deliveries. Pushes emit
one `git.push` per changed branch (at most 64 refs per payload) with `owner`, `repo`, `branch`, `ref`, `repository`,
`clone_url`, `commitSha`, `commit_sha`, and `source`;
branch, tag, and repository changes emit distinct `gitmini.git.branch`, `gitmini.git.tag`, and `gitmini.repo` events.
Deleted/non-branch pushes and zero/missing commit IDs fail closed. The template does not hard-code an organization or
branch. GitMini's `thread` subscription is currently selectable by the service but has no event source and therefore is
not part of the connector contract.

Use the installed connector URL and one-time signing secret when creating a GitMini organization webhook subscription;
subscribe to `git` and `repo`. Each workspace install has fresh credentials. The normalized push includes the clone URL
`https://git.api.apphor.de/git/<org>/<repo>.git` and the exact changed branch commit SHA, which can be passed to the
shared Docker recipe. GitMini Smart HTTP requires a scoped GitMini token for private clones; do not embed that token in a
clone URL or event data. Supply it through a workflow secret and a credential helper that does not persist it in event
history. Registry credentials for GHCR remain a separate recipe secret.

Subscribe a workflow to `git.push` and explicitly map the normalized data to the same Docker recipe used for other Git
providers, for example `cloneUrl: ${inputs.data.clone_url}` and `commitSha: ${inputs.data.commitSha}`. Restrict
organization hooks and workflow event filters to the repositories/branches intended for builds. GitMini delivers
webhooks best-effort (up to three attempts); event consumers should use the delivery ID for deduplication where needed.

Example recipe call (replace the GHCR owner/namespace mapping for your organization):

```yaml
id: gitmini-docker-build
name: Build GitMini push
on:
  events: [git.push]
tags: [alpha]
using: on/docker-build@v3
with:
  image: "ghcr.io/${inputs.data.owner}/${inputs.data.repo}"
  imageTag: "${inputs.data.branch === 'main' ? 'latest' : inputs.data.commitSha}"
  registryUsername: "${inputs.data.owner}"
  cloneUrl: "${inputs.data.clone_url}"
  commitSha: "${inputs.data.commitSha}"
secrets:
  registryToken: "${secrets.GITHUB_TOKEN}"
  gitMiniToken: "${secrets.GITMINI_TOKEN}"
```

This publishes default-branch builds as `latest` so services configured with that exact image can be refreshed; other
branches get unique commit-SHA tags and do not collide with production `latest`. GitMini's Basic Smart HTTP requires a
PAT with repository read access for clones. GHCR requires a separate package-write token. Store both as workspace
secrets, and confirm the chosen GHCR namespace is writable by the registry identity before enabling the workflow.

## Manage and receive requests

Create and manage connectors through the workspace connector UI/API. The connector ID and name are outer metadata, and
the YAML source is stored as the connector definition. Treat the tokenized ingress URL as a credential.

Send requests to the connector's ingress URL. A successful ingress is accepted for processing; event fanout is
asynchronous. Do not put credentials or other secrets in event data: normalized domain-event data is not encrypted at
rest.

### Optional webhook secret

The tokenized webhook URL and webhook secret are separate credentials. The URL routes a request to the connector; the
secret can be used by the connector program to verify request signatures. The secret is generated or rotated through
the connector management UI and is shown only once. Store it securely. Rotating it invalidates the previous secret.

For example, a sender might provide a signature in a vendor-neutral header:

```text
X-Webhook-Signature: <signature computed over the exact raw request body>
```

Pass the raw `body` and the selected header's signature value to `verifyBody(body, signature)`. The generic helper
checks HMAC-SHA-256 over the exact body bytes in the `sha256=<hex>` format using `secrets.WEBHOOK_SECRET`; it does not
apply a timestamp window or deduplicate deliveries. The connector YAML chooses the signature header and maps any
vendor-specific payload. The runtime does not automatically impose vendor-specific signature or delivery behavior.
