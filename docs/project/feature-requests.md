# Feature requests

This document records proposed capabilities that are not yet implemented. These requests are provider-neutral and must preserve the runner's security boundaries.

## Request capture, validation context, and traceable debugging

**Status:** Proposed

Make connector ingestion and validation observable and composable without adding connector-specific verification logic to the runner.

### Requested behavior

- Capture requests that fail validation as well as requests that pass. A rejected request should have a traceable ingress record with its validation outcome and reason, rather than disappearing without useful diagnostics.
- Make safe request context available to workflows alongside `inputs`: normalized, filtered headers and the exact raw request-body bytes. Keep raw bytes distinct from parsed or re-serialized JSON so cryptographic checks use the bytes that were actually signed.
- Provide general-purpose workflow evaluation primitives for common verification operations, including HMAC calculation and constant-time comparison. A connector should be able to express its authentication convention using these primitives and a secret reference, without a provider-specific verifier in core ingress code.
- Keep secrets out of workflow logs and ingress traces. Header filtering should omit common sensitive or infrastructure-controlled headers by default, including authorization, cookies, host, and proxy-related headers. Allow teams to explicitly configure additional headers to retain, with clear safeguards against forwarding credentials unintentionally.
- Show ingress records, filtered headers, bounded request content, validation results, and related run/log links in the interface so users can diagnose and reproduce failures.

### Security and operational constraints

- Recording a failed or unverified request must not make it trusted or dispatch it as an authenticated event. Ingress records should clearly distinguish received, verified, rejected, and dispatched states.
- Keep authentication policy explicit: connectors may implement their checks from generic primitives, but the runner must not silently treat an unchecked request as verified. Any dispatch based on a connector's validation result must be deliberate and auditable.
- Apply request-size, header-count, and retention limits. Redact secrets and sensitive values from logs and traces, and ensure diagnostic access follows workspace authorization.
- Preserve the exact raw bytes only as long as needed for configured verification and debugging; define retention and deletion behavior before enabling durable body capture.

### Acceptance criteria

- A valid signed request and an invalid signature both produce traceable ingress outcomes; only a workflow that explicitly accepts the request can proceed to trusted downstream dispatch.
- A workflow can validate an HMAC over the exact received body using a workspace secret, with constant-time comparison and no provider-specific verification branch in generic ingress.
- Default context excludes blocked headers, while explicitly configured additional headers are available to authorized workflows and are not exposed in unauthorized views.
- The interface links ingress diagnostics to any resulting workflow run and explains rejected requests without logging secret material.
- Automated tests cover raw-byte preservation, filtering and opt-in headers, signature success/failure, constant-time comparison use, authorization, resource limits, and rejection/idempotency behavior.
