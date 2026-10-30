const MAX_PREVIEW_BYTES = 256;

export function formatIncomingPayload(event) {
  if (!event) {
    return "";
  }
  if (event.payloadEncoding === "base64" && typeof event.payloadBase64 === "string") {
    try {
      const binary = atob(event.payloadBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const preview = [...bytes.subarray(0, MAX_PREVIEW_BYTES)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(" ");
      const truncated = bytes.length > MAX_PREVIEW_BYTES ? ` (first ${MAX_PREVIEW_BYTES} bytes; truncated)` : "";
      return `Binary payload: ${bytes.length} bytes${truncated}\nHex: ${preview || "(empty)"}`;
    } catch {
      return "Binary payload: invalid base64 data";
    }
  }
  const value = event.payload;
  if (typeof value !== "string") {
    return value == null ? "" : JSON.stringify(value, null, 2);
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
