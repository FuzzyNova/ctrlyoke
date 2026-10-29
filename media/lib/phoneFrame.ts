import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** A pixel rectangle in the frame image. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a recording goes in a phone mockup, measured from the PNG itself so
 * any mockup with a transparent screen works (the iPhone 13 one is 2500x2500).
 */
export interface PhoneFrame {
  /** The mockup PNG, drawn over the recording. */
  file: string;
  width: number;
  height: number;
  /** The screen opening's bounding box; the recording is scaled to cover it. */
  screen: Box;
  /** The device's bounding box, to which every output is cropped. */
  device: Box;
  /**
   * Gray PNG, frame-sized: the output's alpha. Opaque over the screen opening
   * and the device, transparent around it, the mockup's own alpha at its edge.
   */
  alpha: string;
}

/** Below this, a mockup pixel counts as see-through: part of the screen or the outside. */
const OPAQUE_THRESHOLD = 128;

function probeSize(file: string): { width: number; height: number } {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ],
    { encoding: "utf8" }
  );
  if (result.error) throw result.error;
  const [width, height] = result.stdout.trim().split(",").map(Number);
  if (result.status !== 0 || !width || !height) {
    throw new Error(`ffprobe could not read the size of ${file}`);
  }
  return { width, height };
}

/** The PNG's alpha channel, one byte per pixel, row by row. */
function readAlpha(file: string): Buffer {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-vf",
      "alphaextract",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { maxBuffer: 256 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg could not read the alpha of ${file}. Is it a PNG with transparency? ${result.stderr}`
    );
  }
  return result.stdout;
}

function writeGrayPng(
  pixels: Buffer,
  width: number,
  height: number,
  file: string
): void {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-s",
      `${width}x${height}`,
      "-i",
      "-",
      file,
    ],
    { input: pixels }
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg could not write ${file}: ${result.stderr}`);
  }
}

/** Bounding box of the pixels `inside` accepts; even-sized, so video encoders take it. */
function boundingBox(
  width: number,
  height: number,
  inside: (index: number) => boolean
): Box {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(y * width + x)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) throw new Error("the frame has no pixels of that kind");
  const even = (n: number) => n + (n % 2);
  return {
    x: left,
    y: top,
    width: Math.min(even(right - left + 1), width - left),
    height: Math.min(even(bottom - top + 1), height - top),
  };
}

/**
 * Measures a phone mockup and writes its alpha into `workDir`.
 *
 * The screen opening is the see-through region connected to the middle of the
 * device: the outside is see-through too, but the bezel separates the two.
 * Its anti-aliased inner edge counts as screen, so the output is opaque there
 * and the bezel's soft edge blends over the recording rather than over nothing.
 */
export function measurePhoneFrame(file: string, workDir: string): PhoneFrame {
  const { width, height } = probeSize(file);
  const alpha = readAlpha(file);
  const device = boundingBox(
    width,
    height,
    (i) => alpha[i] >= OPAQUE_THRESHOLD
  );

  const screen = new Uint8Array(width * height);
  const start =
    Math.floor(device.y + device.height / 2) * width +
    Math.floor(device.x + device.width / 2);
  if (alpha[start] >= OPAQUE_THRESHOLD) {
    throw new Error(
      `${file}: the middle of the device is opaque. The mockup needs a transparent screen.`
    );
  }
  const stack = [start];
  screen[start] = 1;
  while (stack.length) {
    const index = stack.pop()!;
    const x = index % width;
    for (const next of [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      index - width,
      index + width,
    ]) {
      if (next < 0 || next >= screen.length || screen[next]) continue;
      if (alpha[next] >= OPAQUE_THRESHOLD) continue;
      screen[next] = 1;
      stack.push(next);
    }
  }
  const screenBox = boundingBox(width, height, (i) => screen[i] === 1);
  if (
    screenBox.x <= device.x ||
    screenBox.y <= device.y ||
    screenBox.width >= device.width
  ) {
    throw new Error(
      `${file}: the screen opening reaches the edge of the image, so the bezel isn't closed.`
    );
  }

  const output = Buffer.alloc(width * height);
  for (let i = 0; i < output.length; i++) {
    output[i] = screen[i] ? 255 : alpha[i];
  }
  mkdirSync(workDir, { recursive: true });
  const alphaFile = path.join(workDir, "frame-alpha.png");
  writeGrayPng(output, width, height, alphaFile);
  return { file, width, height, screen: screenBox, device, alpha: alphaFile };
}
