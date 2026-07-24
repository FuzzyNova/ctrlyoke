import * as assert from "assert";
import { suite, test } from "mocha";
import { readImageDimensions } from "../../utils/ImageTokenEstimator";

/** Build a minimal PNG header with the given 32-bit big-endian dimensions. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  // 8-byte PNG signature (only the first four bytes are checked).
  buf[0] = 0x89;
  buf[1] = 0x50; // P
  buf[2] = 0x4e; // N
  buf[3] = 0x47; // G
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** Build a minimal GIF header with little-endian dimensions. */
function gifHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  buf[0] = 0x47; // G
  buf[1] = 0x49; // I
  buf[2] = 0x46; // F
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** Build a minimal baseline JPEG with a single SOF0 segment. */
function jpegHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(20);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0
  buf.writeUInt16BE(11, 4); // segment length
  buf[6] = 8; // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

suite("ImageTokenEstimator.readImageDimensions", () => {
  test("reads PNG dimensions", () => {
    assert.deepStrictEqual(readImageDimensions(pngHeader(180, 180)), {
      width: 180,
      height: 180,
    });
  });

  test("reads GIF dimensions", () => {
    assert.deepStrictEqual(readImageDimensions(gifHeader(640, 480)), {
      width: 640,
      height: 480,
    });
  });

  test("reads baseline JPEG dimensions", () => {
    assert.deepStrictEqual(readImageDimensions(jpegHeader(1024, 768)), {
      width: 1024,
      height: 768,
    });
  });

  test("returns null for non-image bytes", () => {
    assert.strictEqual(
      readImageDimensions(Buffer.from("not an image at all", "utf8")),
      null
    );
  });

  test("returns null for a truncated header", () => {
    assert.strictEqual(
      readImageDimensions(pngHeader(180, 180).subarray(0, 10)),
      null
    );
  });
});
