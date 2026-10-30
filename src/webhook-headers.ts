const excludedHeaders = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "host",
  "forwarded",
  "origin",
  "referer",
  "referrer",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-connector-timestamp",
  "x-connector-signature",
  "x-hub-signature-256",
]);

/** Keep useful input metadata while excluding routing and credential-bearing headers. */
export function safeWebhookHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const normalized = name.toLowerCase();
      return (
        !excludedHeaders.has(normalized) &&
        !normalized.startsWith("x-forwarded-") &&
        !normalized.startsWith("x-real-") &&
        !normalized.startsWith("proxy-") &&
        !/(?:^|[-_])(authorization|authentication|auth|cookie|credential|password|passwd|secret|token|api[-_]?key)(?:$|[-_])/.test(
          normalized,
        )
      );
    }),
  );
}
