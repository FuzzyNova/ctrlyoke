import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { VideoOutputs } from "./encode.ts";

/**
 * Checks that a browser shows an encoded video with the colours ffmpeg
 * decodes. ffmpeg honours a file's colour tags; browsers assume web video is
 * limited-range BT.709 and ignore a lot of what disagrees. The 2026-10-18 hero
 * shipped full-range BT.601 and looked right in every ffmpeg-made still but
 * dark and shifted in the browser, so the encode now verifies the browser's
 * view of one frame (see `webVideoColorArgs`).
 */

/** Mean per-channel difference (0-255) above which colours are wrong, not just lossy. */
const MAX_MEAN_DIFFERENCE = 6;
const SAMPLE_WIDTH = 320;

/** One frame at `atSeconds` as RGB bytes, `SAMPLE_WIDTH` wide, decoded by ffmpeg. */
function ffmpegFrame(file: string, atSeconds: number, height: number): Buffer {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(atSeconds),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${SAMPLE_WIDTH}:${height}:flags=area`,
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg could not decode ${file}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Decodes the frame at `atSeconds` in Chromium and in ffmpeg and throws if
 * they differ by more than compression noise. Returns the mean difference.
 */
export async function checkBrowserColors(
  file: string,
  mimeType: string,
  atSeconds: number
): Promise<number> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const data = readFileSync(file).toString("base64");
    const result = await page.evaluate(
      async ({ data, mimeType, atSeconds, width }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const video = document.createElement("video");
        if (!video.canPlayType(mimeType)) return { unsupported: true as const };
        video.muted = true;
        video.src = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        await new Promise((resolve, reject) => {
          video.onloadeddata = resolve;
          video.onerror = () =>
            reject(new Error("the browser could not load the video"));
        });
        video.currentTime = atSeconds;
        await new Promise((resolve) => (video.onseeked = resolve));
        const height = Math.round(
          (video.videoHeight / video.videoWidth) * width
        );
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d")!;
        context.drawImage(video, 0, 0, width, height);
        const rgba = context.getImageData(0, 0, width, height).data;
        return { height, rgba: Array.from(rgba) };
      },
      { data, mimeType, atSeconds, width: SAMPLE_WIDTH }
    );
    if ("unsupported" in result) {
      console.log(`colour check skipped: Chromium can't play ${mimeType}`);
      return 0;
    }
    const reference = ffmpegFrame(file, atSeconds, result.height);
    let total = 0;
    const pixels = SAMPLE_WIDTH * result.height;
    for (let pixel = 0; pixel < pixels; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        total += Math.abs(
          result.rgba[pixel * 4 + channel] - reference[pixel * 3 + channel]
        );
      }
    }
    const mean = total / (pixels * 3);
    if (mean > MAX_MEAN_DIFFERENCE) {
      throw new Error(
        `${file}: the browser shows different colours from ffmpeg (mean difference ${mean.toFixed(1)}/255). Check its colour tags.`
      );
    }
    return mean;
  } finally {
    await browser.close();
  }
}

/** Runs `checkBrowserColors` on a video shot's AV1 and H.264 files at the poster's time. */
export async function checkShippedVideoColors(
  outDir: string,
  outputs: VideoOutputs,
  atSeconds: number
): Promise<void> {
  for (const [file, mimeType] of [
    [outputs.av1, 'video/mp4; codecs="av01.0.08M.08"'],
    [outputs.h264.file, 'video/mp4; codecs="avc1.640028"'],
  ]) {
    const difference = await checkBrowserColors(
      path.join(outDir, file),
      mimeType,
      atSeconds
    );
    console.log(
      `colour check ${file}: browser and ffmpeg agree (mean difference ${difference.toFixed(1)}/255)`
    );
  }
}
