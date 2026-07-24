import * as fs from "fs/promises";
import { Log } from "./Log";

/**
 * Image token estimation.
 *
 * Vision models bill an image by its pixel area, not by the byte size of the
 * encoded file — so tokenizing the raw file bytes (as text) wildly over-counts
 * (a small PNG icon reads as ~14K "tokens" of binary garbage). This helper
 * approximates the real cost using Anthropic's documented rule of thumb:
 *
 *   tokens ≈ (width × height) / 750
 *
 * Anthropic also resizes images so the long edge is ≤ 1568px and the total
 * area is ≤ ~1.15 megapixels, which caps a single image at roughly 1590 tokens.
 * We apply the same ceiling so oversized source images estimate realistically.
 */

const TOKENS_PER_PIXEL_DIVISOR = 750;

/** ~1.15 megapixels / 750 — Anthropic's effective per-image token ceiling. */
const MAX_IMAGE_TOKENS = Math.ceil(1_150_000 / TOKENS_PER_PIXEL_DIVISOR);

/** Estimate used when dimensions can't be parsed (rare — the 4 supported formats). */
const FALLBACK_IMAGE_TOKENS = 1024;

interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Estimate the token cost of attaching an image file to a prompt.
 *
 * @param absolutePath Absolute path to an image file (png/jpeg/gif/webp).
 * @returns Estimated token count, clamped to [1, MAX_IMAGE_TOKENS].
 */
export async function estimateImageTokens(
  absolutePath: string
): Promise<number> {
  try {
    const buffer = await fs.readFile(absolutePath);
    const dimensions = readImageDimensions(buffer);
    if (!dimensions) {
      return FALLBACK_IMAGE_TOKENS;
    }
    const tokens = Math.ceil(
      (dimensions.width * dimensions.height) / TOKENS_PER_PIXEL_DIVISOR
    );
    return Math.max(1, Math.min(tokens, MAX_IMAGE_TOKENS));
  } catch (error) {
    Log.debug(`[ImageTokenEstimator] Failed to size ${absolutePath}:`, error);
    return FALLBACK_IMAGE_TOKENS;
  }
}

/**
 * Read pixel dimensions from an image file's header bytes without decoding it.
 * Supports the four formats ctrlyoke accepts (PNG, JPEG, GIF, WebP); returns
 * null for anything else or a malformed header.
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  return (
    readPngDimensions(buffer) ??
    readGifDimensions(buffer) ??
    readWebpDimensions(buffer) ??
    readJpegDimensions(buffer)
  );
}

/** PNG: 8-byte signature, then an IHDR chunk with big-endian width/height. */
function readPngDimensions(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.length < 24 ||
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 || // 'P'
    buffer[2] !== 0x4e || // 'N'
    buffer[3] !== 0x47 // 'G'
  ) {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

/** GIF: 'GIF' magic, then little-endian width/height at bytes 6..10. */
function readGifDimensions(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.length < 10 ||
    buffer[0] !== 0x47 || // 'G'
    buffer[1] !== 0x49 || // 'I'
    buffer[2] !== 0x46 // 'F'
  ) {
    return null;
  }
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

/** WebP: 'RIFF'....'WEBP', then a VP8 / VP8L / VP8X chunk carrying the size. */
function readWebpDimensions(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  const format = buffer.toString("ascii", 12, 16);

  if (format === "VP8 ") {
    // Lossy: dimensions are 14-bit values after the 3-byte start code.
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }

  if (format === "VP8L") {
    // Lossless: 14-bit width/height packed into 4 bytes after the 0x2f marker.
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }

  if (format === "VP8X") {
    // Extended: 24-bit (value + 1) dimensions at bytes 24..30.
    const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
    const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
    return { width, height };
  }

  return null;
}

/** JPEG: scan segment markers for a Start-Of-Frame carrying height/width. */
function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null; // not a JPEG (no SOI marker)
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++; // skip padding until the next marker
      continue;
    }
    const marker = buffer[offset + 1];

    // SOF0..SOF15 carry the frame size, excluding the non-SOF markers
    // 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC).
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isSof) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    // Standalone markers (no length payload): SOI/EOI and RST0..RST7.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }

    // Every other marker is followed by a 2-byte segment length.
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) {
      return null; // malformed
    }
    offset += 2 + segmentLength;
  }

  return null;
}
