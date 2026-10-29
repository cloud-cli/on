# Manage workspace secrets

Workspace secrets are encrypted in the database and are write-only in the UI. Only authorized workspace admins
can manage them. The control plane's master key is needed to decrypt them for authorized execution.

## Store a text secret

Open **Workspace settings → Task Runner Secrets**, enter an uppercase name such as `NPM_TOKEN`, enter the value,
and save it. The saved value cannot be read back through the UI.

Reference it through a step environment variable:

```yaml
steps:
  - id: publish
    env:
      NPM_TOKEN: ${secrets.NPM_TOKEN}
    run: npm publish
```

`run` is passed to the shell unchanged. Do not interpolate secret values into shell source, print them, or write
them to artifacts or caches.

## Store a binary file secret

Choose **Binary file secret** and upload the file. Map it to a workspace-relative path with `secretFiles`:

```yaml
secretFiles:
  .config/signing.key: SIGNING_KEY
```

The file is written into the job workspace with owner-only permissions. Avoid including secret files in artifacts
or caches; clean workspace storage according to your runner's retention policy.

## Protect the master key

Set `RUNNER_MASTER_KEY` only on the control plane, or use the provided systemd credential at
`/etc/on/credentials/on-master-key`. Keep the key stable across restarts and deployments: losing it makes existing
encrypted secrets unavailable, while replacing it without a planned re-encryption leaves the database encrypted
under the old key. Never copy it to API-only workers.

When a secret is replaced or deleted, On attempts to scrub its previous value from stored job logs and reports.
This is defense in depth, not a reason to log secret material.
