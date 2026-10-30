import { describe, expect, it } from "vitest";
import { formatIncomingPayload } from "../ui/incoming-event-payload.mjs";

describe("incoming event payload display", () => {
  it("pretty-prints JSON and retains legacy plain text", () => {
    expect(formatIncomingPayload({ payload: '{"ok":true,"nested":{"count":2}}' })).toBe(
      '{\n  "ok": true,\n  "nested": {\n    "count": 2\n  }\n}',
    );
    expect(formatIncomingPayload({ payload: "not JSON <script>" })).toBe("not JSON <script>");
  });

  it("decodes base64 as bytes and renders safe hex without UTF-8 loss", () => {
    const payload = btoa(String.fromCharCode(0, 255, 195, 40));
    expect(formatIncomingPayload({ payloadEncoding: "base64", payloadBase64: payload, payload: "lossy" })).toBe(
      "Binary payload: 4 bytes\nHex: 00 ff c3 28",
    );
  });

  it("caps binary preview at 256 bytes and marks truncation", () => {
    const payload = btoa(String.fromCharCode(...new Array(257).fill(0xab)));
    const shown = formatIncomingPayload({ payloadEncoding: "base64", payloadBase64: payload });
    expect(shown).toContain("Binary payload: 257 bytes (first 256 bytes; truncated)");
    expect(shown.split("\nHex: ")[1].split(" ")).toHaveLength(256);
  });
});
