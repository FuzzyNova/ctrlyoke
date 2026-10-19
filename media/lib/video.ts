import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { prepareDemoApp } from "./demoApp.ts";
import { startHost, stopHost, type ReplayOptions } from "./devHost.ts";
import { checkBrowserColors } from "./colorCheck.ts";
import { encodeVideoOutputs, type VideoOutputs } from "./encode.ts";
import { MEDIA_DIR, WORK_DIR } from "./paths.ts";
import {
  RECORDING_FPS,
  RECORDING_LAUNCH_ARGS,
  RECORDING_SCALE,
  Recorder,
} from "./recorder.ts";
import { findRunFixture } from "./runs.ts";
import type { CaptureOptions } from "./shot.ts";
import { Timeline, type TimelineFile } from "./timeline.ts";
import { THEMES, DEFAULT_THEME } from "./themes.ts";

/**
 * A video asset: one recorded take of the hosted dashboard, replaying a
 * recorded run, then cut by a Remotion composition and encoded
 * (MEDIA_CAPTURE_AUTOMATION_PLAN.md §3-4).
 */
export interface VideoShot {
  id: string;
  description: string;
  /** The run fixture replayed during the take (fixtures/runs/fixtures.json). */
  run: string;
  replay?: Omit<ReplayOptions, "bundleDir">;
  /** CSS viewport; the take records at `RECORDING_SCALE` times this. */
  viewport: { width: number; height: number };
  /** Gets the dashboard to the opening frame. Not recorded. */
  prepare(page: Page): Promise<void>;
  /** Performs the take, recording each beat through `timeline`. */
  record(page: Page, timeline: Timeline): Promise<void>;
  /** Remotion composition id in compositions/Root.tsx. */
  composition: string;
  outputs: VideoOutputs;
}

const RAW_VIDEO = "raw.mp4";
const TIMELINE_FILE = "timeline.json";
const EDIT_FILE = "edit.mp4";
const COMPOSITIONS_ENTRY = path.join(MEDIA_DIR, "compositions", "index.ts");

function takeDir(shot: VideoShot): string {
  return path.join(WORK_DIR, "video", shot.id);
}

/** Records a take into the work folder: raw.mp4 plus timeline.json. */
async function recordTake(shot: VideoShot): Promise<void> {
  const fixture = findRunFixture(shot.run);
  const dir = takeDir(shot);
  mkdirSync(dir, { recursive: true });
  prepareDemoApp([], fixture.startTag);
  const url = await startHost({
    replay: { bundleDir: fixture.bundleDir, ...shot.replay },
  });
  const browser = await chromium.launch({ args: RECORDING_LAUNCH_ARGS });
  try {
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: RECORDING_SCALE,
      colorScheme: THEMES[DEFAULT_THEME].colorScheme,
    });
    const page = await context.newPage();
    await page.goto(url);
    await shot.prepare(page);
    await page.mouse.move(0, 0);
    // Beats record boxes at take time; a scrolled document would put every
    // later click somewhere the edit doesn't expect (see lib/stills.ts).
    const bodyScroll = await page.evaluate(
      () => document.body.scrollTop + document.documentElement.scrollTop
    );
    if (bodyScroll) {
      throw new Error(
        `${shot.id}: the page body is scrolled by ${bodyScroll}px`
      );
    }
    const recorder = await Recorder.start(
      context,
      page,
      path.join(dir, "frames")
    );
    const timeline = new Timeline(page, () => recorder.now());
    try {
      await shot.record(page, timeline);
    } finally {
      const duration = await recorder.stop(path.join(dir, RAW_VIDEO));
      const file: TimelineFile = {
        video: RAW_VIDEO,
        viewport: shot.viewport,
        scale: RECORDING_SCALE,
        fps: RECORDING_FPS,
        duration,
        beats: timeline.beats,
      };
      writeFileSync(
        path.join(dir, TIMELINE_FILE),
        `${JSON.stringify(file, null, 2)}\n`
      );
    }
  } finally {
    await browser.close();
    stopHost();
  }
}

/** Renders the shot's composition from the last take. */
async function renderEdit(shot: VideoShot): Promise<string> {
  const dir = takeDir(shot);
  const timelinePath = path.join(dir, TIMELINE_FILE);
  if (!existsSync(timelinePath)) {
    throw new Error(
      `${shot.id} has no take yet. Run \`npm run media -- ${shot.id}\` without --edit-only.`
    );
  }
  const timeline = JSON.parse(
    readFileSync(timelinePath, "utf8")
  ) as TimelineFile;
  // Loaded lazily: only video shots need Remotion.
  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  console.log(`bundling compositions...`);
  const serveUrl = await bundle({
    entryPoint: COMPOSITIONS_ENTRY,
    publicDir: dir,
  });
  const inputProps = { timeline };
  const composition = await selectComposition({
    serveUrl,
    id: shot.composition,
    inputProps,
  });
  const output = path.join(dir, EDIT_FILE);
  let reported = -1;
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: "h264",
    // Tagged limited-range BT.709, like every other stage (lib/encode.ts).
    colorSpace: "bt709",
    crf: 12,
    x264Preset: "fast",
    outputLocation: output,
    muted: true,
    onProgress: ({ progress }) => {
      const percent = Math.floor(progress * 10) * 10;
      if (percent !== reported) {
        reported = percent;
        console.log(`rendering ${shot.id}: ${percent}%`);
      }
    },
  });
  return output;
}

/**
 * Takes (unless `editOnly`), edits and encodes a video shot into the output
 * folder.
 */
export async function captureVideo(
  shot: VideoShot,
  { outDir, editOnly }: CaptureOptions
): Promise<void> {
  if (!editOnly) await recordTake(shot);
  const edit = await renderEdit(shot);
  mkdirSync(outDir, { recursive: true });
  encodeVideoOutputs(edit, outDir, shot.outputs);
  const at = shot.outputs.poster.atSeconds;
  for (const [file, mimeType] of [
    [shot.outputs.av1, 'video/mp4; codecs="av01.0.08M.08"'],
    [shot.outputs.h264.file, 'video/mp4; codecs="avc1.640028"'],
  ]) {
    const difference = await checkBrowserColors(
      path.join(outDir, file),
      mimeType,
      at
    );
    console.log(
      `colour check ${file}: browser and ffmpeg agree (mean difference ${difference.toFixed(1)}/255)`
    );
  }
}
