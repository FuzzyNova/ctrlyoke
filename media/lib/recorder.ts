import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { webVideoColorArgs } from "./encode.ts";
import { run } from "./exec.ts";

/**
 * Records a page at device resolution.
 *
 * Playwright's own `page.screencast` and `recordVideo` deliver frames at CSS
 * size whatever the context's `deviceScaleFactor`, so a 2× recording is an
 * upscaled 1× one (checked 2026-10-18 with Playwright 1.64). Chromium's
 * `Page.startScreencast` sends device-pixel frames only when the browser itself
 * runs at that scale, so video captures launch with
 * `--force-device-scale-factor` (see `RECORDING_LAUNCH_ARGS`) and read the
 * screencast over CDP. Frames arrive when the page repaints, each with its own
 * timestamp, and are laid onto a constant frame rate when encoded.
 */

export const RECORDING_SCALE = 2;
export const RECORDING_FPS = 30;
export const RECORDING_LAUNCH_ARGS = [
  `--force-device-scale-factor=${RECORDING_SCALE}`,
];
const JPEG_QUALITY = 92;

interface Frame {
  file: string;
  /** Wall-clock seconds. */
  timestamp: number;
}

export class Recorder {
  private readonly frames: Frame[] = [];
  private readonly writes: Promise<void>[] = [];
  private stopped = false;
  private readonly cdp: CDPSession;
  private readonly framesDir: string;

  private constructor(cdp: CDPSession, framesDir: string) {
    this.cdp = cdp;
    this.framesDir = framesDir;
  }

  static async start(
    context: BrowserContext,
    page: Page,
    framesDir: string
  ): Promise<Recorder> {
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
    const cdp = await context.newCDPSession(page);
    const recorder = new Recorder(cdp, framesDir);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("recording needs a fixed viewport");
    cdp.on("Page.screencastFrame", (frame) => recorder.onFrame(frame));
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: JPEG_QUALITY,
      maxWidth: viewport.width * RECORDING_SCALE,
      maxHeight: viewport.height * RECORDING_SCALE,
    });
    await recorder.firstFrame();
    return recorder;
  }

  private onFrame(frame: {
    data: string;
    sessionId: number;
    metadata: { timestamp?: number };
  }): void {
    if (this.stopped) return;
    const file = path.join(
      this.framesDir,
      `${String(this.frames.length).padStart(6, "0")}.jpg`
    );
    this.frames.push({
      file,
      timestamp: frame.metadata.timestamp ?? Date.now() / 1000,
    });
    // Ack after the write, so a slow disk slows the screencast instead of
    // piling frames up in memory.
    this.writes.push(
      writeFile(file, Buffer.from(frame.data, "base64")).then(async () => {
        await this.cdp
          .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
          .catch(() => {});
      })
    );
  }

  private async firstFrame(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!this.frames.length) {
      if (Date.now() > deadline)
        throw new Error("the screencast sent no frame");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Seconds since the first frame: the clock `Timeline` beats use. */
  now(): number {
    return Date.now() / 1000 - this.frames[0].timestamp;
  }

  /**
   * Stops recording and encodes the frames to `output` at a constant frame
   * rate, near-lossless, as the composition's source. Returns its duration.
   */
  async stop(output: string): Promise<number> {
    // The screencast only sends frames on repaint; a still page at the end
    // would otherwise lose its last seconds.
    const endedAt = Date.now() / 1000;
    this.stopped = true;
    await this.cdp.send("Page.stopScreencast");
    await Promise.all(this.writes);
    await this.cdp.detach();

    const start = this.frames[0].timestamp;
    const lines = ["ffconcat version 1.0"];
    this.frames.forEach((frame, index) => {
      const next = this.frames[index + 1]?.timestamp ?? endedAt;
      lines.push(`file '${path.basename(frame.file)}'`);
      lines.push(`duration ${Math.max(0, next - frame.timestamp).toFixed(4)}`);
    });
    // The concat demuxer drops the last entry's duration unless it repeats.
    lines.push(`file '${path.basename(this.frames.at(-1)!.file)}'`);
    const list = path.join(this.framesDir, "frames.ffconcat");
    writeFileSync(list, `${lines.join("\n")}\n`);
    run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-fps_mode",
        "cfr",
        "-r",
        String(RECORDING_FPS),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "12",
        ...webVideoColorArgs(),
        output,
      ],
      this.framesDir
    );
    console.log(
      `recorded ${this.frames.length} frames over ${(endedAt - start).toFixed(1)}s`
    );
    // A 2× take is a few gigabytes of JPEGs; raw.mp4 is all the edit reads.
    rmSync(this.framesDir, { recursive: true, force: true });
    return endedAt - start;
  }
}
