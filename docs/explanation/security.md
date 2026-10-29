# Security boundaries

On is designed around separate identities and explicit trust boundaries. It is not safe to treat workflow YAML,
runner labels, or a network boundary as a sandbox for untrusted code.

## Identity and workspace access

OIDC identifies people. Workspace membership and capabilities authorize access to workflows, logs, secrets,
webhooks, and runners. A user or token must still be a member of the requested workspace; an identifier or
`X-Team-ID` header does not grant access. Shared runners receive a workspace's jobs only after an explicit grant.

Runner labels are scheduling metadata, not authorization. Do not assign a sensitive workload to a broad shared
runner without granting and isolation policy appropriate to that workspace.

## Workflow execution

`run:` is raw shell code. It is intentionally not interpolated by the workflow evaluator, and values should be
passed through `env` then consumed with quoted shell variables. This reduces accidental code/data mixing; it does
not make a malicious shell script safe.

Workflows can execute commands with the runner's operating-system permissions. `image`, `volumes`, and
`dockerArgs` can further expose host data or change container isolation. The supplied systemd worker unit runs as
root to create transient units. Only run trusted workflows on such a host, and keep runner workspaces and host
credentials separate from untrusted workloads.

Execution is at least once across interruptions and lease recovery. A command may have completed an external side
effect even if its acknowledgement was lost. Make deployment steps idempotent and do not assume retries or
recovery provide exactly-once effects.

## Credentials and secrets

- Workspace secret values are encrypted in the database with AES-256-GCM. The master key belongs only on the
  control plane and must be backed up and kept stable.
- A runner receives a unique bearer credential after a single-use enrollment code is redeemed. The credential
  file is owner-only; protect its persistent volume and revoke a runner if the credential is lost or exposed.
- A runner fetches secrets only for a claimed, authorized job. Never copy the database URL, OIDC client secret, or
  master key to API-only workers.
- Webhook signatures are checked against the original request bytes. Webhook URLs and signing secrets are
  workspace-specific; treat both as credentials and rotate by revoking and recreating a registration.
- Event payloads and workflow reports are not a secret store. Keep credentials and unrelated personal data out of
  event bodies, outputs, logs, and artifacts.

## Network and operations

Use HTTPS for public ingress and runner-to-control-plane traffic. Configure a reverse proxy to replace forwarded
host/protocol headers before they reach the application. Keep database and secret-key access restricted to the
control plane, back up data and encryption keys together, and test restore procedures before relying on them.
