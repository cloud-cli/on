import { inflateSync } from "node:zlib";

export const MAX_WORKSPACE_LOGO_BYTES = 256 * 1024;
const MAX_WORKSPACE_LOGO_PIXELS = 1024 * 1024;

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width * height <= MAX_WORKSPACE_LOGO_PIXELS;
}

function pngIsValid(data: Buffer): boolean {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 45 || !data.subarray(0, 8).equals(signature) || data.readUInt32BE(8) !== 13) {
    return false;
  }
  const ihdr = data.subarray(12, 29);
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const bitDepth = data[24];
  const colorType = data[25];
  if (
    ihdr.toString("ascii", 0, 4) !== "IHDR" ||
    !validDimensions(width, height) ||
    data[26] !== 0 ||
    data[27] !== 0 ||
    data[28] !== 0
  ) {
    return false;
  }
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!channels[colorType] || !depths[colorType]?.includes(bitDepth)) {
    return false;
  }
  const expectedInflatedSize = Math.ceil((width * channels[colorType] * bitDepth) / 8 + 1) * height;
  if (expectedInflatedSize > MAX_WORKSPACE_LOGO_PIXELS * 8) {
    return false;
  }
  let offset = 8;
  let hasImageData = false;
  let hasEnd = false;
  const imageData: Buffer[] = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) {
      return false;
    }
    const kind = data.toString("ascii", offset + 4, offset + 8);
    if (offset === 8 && kind !== "IHDR") {
      return false;
    }
    if (data.readUInt32BE(offset + 8 + length) !== crc32(data.subarray(offset + 4, offset + 8 + length))) {
      return false;
    }
    if (kind === "IDAT") {
      hasImageData = true;
      imageData.push(data.subarray(offset + 8, offset + 8 + length));
    }
    if (kind === "IEND") {
      hasEnd = length === 0 && end === data.length;
      break;
    }
    offset = end;
  }
  if (!hasImageData || !hasEnd) {
    return false;
  }
  try {
    return (
      inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedInflatedSize }).length === expectedInflatedSize
    );
  } catch {
    return false;
  }
}

function jpegIsValid(data: Buffer): boolean {
  if (
    data.length < 12 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data.at(-1) !== 0xd9
  ) {
    return false;
  }
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < data.length - 2) {
    if (data[offset++] !== 0xff) {
      return false;
    }
    while (data[offset] === 0xff) {
      offset++;
    }
    const marker = data[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xda) {
      return false;
    }
    if ([0x01, 0xd8, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7].includes(marker)) {
      continue;
    }
    if (offset + 2 > data.length) {
      return false;
    }
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length) {
      return false;
    }
    if (frameMarkers.has(marker)) {
      if (segmentLength < 8) {
        return false;
      }
      return validDimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
    }
    offset += segmentLength;
  }
  return false;
}

function webpIsValid(data: Buffer): boolean {
  if (
    data.length < 30 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.readUInt32LE(4) !== data.length - 8 ||
    data.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return false;
  }
  const type = data.toString("ascii", 12, 16);
  const chunkLength = data.readUInt32LE(16);
  if (chunkLength + 20 > data.length) {
    return false;
  }
  if (type === "VP8X" && chunkLength >= 10) {
    return validDimensions(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3));
  }
  if (type === "VP8 " && chunkLength >= 10 && data.toString("hex", 23, 26) === "9d012a") {
    return validDimensions(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
  }
  if (type === "VP8L" && chunkLength >= 5 && data[20] === 0x2f) {
    const width = 1 + data[21] + ((data[22] & 0x3f) << 8);
    const height = 1 + (data[22] >> 6) + (data[23] << 2) + ((data[24] & 0x0f) << 10);
    return validDimensions(width, height);
  }
  return false;
}

export function isValidWorkspaceLogo(mimeType: string, data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_WORKSPACE_LOGO_BYTES) {
    return false;
  }
  switch (mimeType) {
    case "image/png":
      return pngIsValid(data);
    case "image/jpeg":
      return jpegIsValid(data);
    case "image/webp":
      return webpIsValid(data);
    default:
      return false;
  }
}
