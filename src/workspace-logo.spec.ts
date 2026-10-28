import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isValidWorkspaceLogo, MAX_WORKSPACE_LOGO_BYTES } from "./workspace-logo.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, content: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(content.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head.subarray(4), content]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, content, crc]);
}

function tinyPng(width = 1, height = 1): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("workspace logo validation", () => {
  it("accepts a small, structurally valid PNG", () => {
    expect(isValidWorkspaceLogo("image/png", tinyPng())).toBe(true);
  });

  it("rejects signature-only data, excessive dimensions, unsupported formats, and oversize files", () => {
    expect(isValidWorkspaceLogo("image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(false);
    expect(isValidWorkspaceLogo("image/png", tinyPng(2048, 2048))).toBe(false);
    expect(isValidWorkspaceLogo("image/svg+xml", tinyPng())).toBe(false);
    expect(isValidWorkspaceLogo("image/png", Buffer.alloc(MAX_WORKSPACE_LOGO_BYTES + 1))).toBe(false);
  });
});
