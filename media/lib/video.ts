import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { installWorkflowFixture, prepareDemoApp } from "./demoApp.ts";
import { startHost, stopHost, type ReplayOptions } from "./devHost.ts";
import { checkShippedVideoColors } from "./colorCheck.ts";
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
 * One recording of the hosted dashboard in a fresh page. A video shot has one
 * take, or several that its composition shows together (side by side).
 */
export interface Take {
  /** Names the take's files and its timeline in the composition's props. */
  id: string;
  /** CSS viewport; the take records at `RECORDING_SCALE` times this. */
  viewport: { width: number; height: number };
  /**
   * fixtures/workflows/ files installed into demo-app's .ctrlyoke/workflows/
   * just before this take, keyed by the name they get there. Lets takes on
   * one host start the same workflow file from different states.
   */
  workflows?: Record<string, string>;
  /** Gets the dashboard to the opening frame. Not recorded. */
  prepare(page: Page): Promise<void>;
  /** Performs the take, recording each beat through `timeline`. */
  record(page: Page, timeline: Timeline): Promise<void>;
}

/**
 * A video asset: takes of the hosted dashboard, cut by a Remotion composition
 * and encoded (MEDIA_CAPTURE_AUTOMATION_PLAN.md §3-4). Shots that show a run
 * replay a recorded one; the rest drive the dashboard directly.
 */
export interface VideoShot {
  id: string;
  description: string;
  /**
   * The run fixture replayed during the takes (fixtures/runs/fixtures.json);
   * demo-app then starts at the run's start tag.
   */
  run?: string;
  replay?: Omit<ReplayOptions, "bundleDir">;
  /** Files from fixtures/workflows/ installed for every take. */
  workflows?: string[];
  /** Extra environment variables for the host. */
  env?: Record<string, string>;
  /** Recorded in order on one host. */
  takes: Take[];
  /** Remotion composition id in compositions/Root.tsx. */
  composition: string;
  outputs: VideoOutputs;
}

const EDIT_FILE = "edit.mp4";
const COMPOSITIONS_ENTRY = path.join(MEDIA_DIR, "compositions", "index.ts");

function shotDir(shot: VideoShot): string {
  return path.join(WORK_DIR, "video", shot.id);
}

/** A take's raw recording, relative to the shot's folder (Remotion's public dir). */
function rawVideoFile(take: Take): string {
  return `${take.id}.raw.mp4`;
}

function timelineFile(take: Take): string {
  return `${take.id}.timeline.json`;
}

/** Starts the host the shot needs and returns the dashboard URL. */
async function startShotHost(shot: VideoShot): Promise<string> {
  if (!shot.run) {
    prepareDemoApp(shot.workflows ?? []);
    return startHost({ env: shot.env });
  }
  const fixture = findRunFixture(shot.run);
  prepareDemoApp(shot.workflows ?? [], fixture.startTag);
  return startHost({
    env: shot.env,
    replay: { bundleDir: fixture.bundleDir, ...shot.replay },
  });
}

/** Records one take into the shot's folder: its raw video and timeline. */
async function recordTake(
  shot: VideoShot,
  take: Take,
  browser: Browser,
  url: string
): Promise<void> {
  const dir = shotDir(shot);
  for (const [as, fixture] of Object.entries(take.workflows ?? {})) {
    installWorkflowFixture(fixture, as);
  }
  const context = await browser.newContext({
    viewport: take.viewport,
    deviceScaleFactor: RECORDING_SCALE,
    colorScheme: THEMES[DEFAULT_THEME].colorScheme,
  });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await take.prepare(page);
    await page.mouse.move(0, 0);
    // Beats record boxes at take time; a scrolled document would put every
    // later click somewhere the edit doesn't expect (see lib/stills.ts).
    const bodyScroll = await page.evaluate(
      () => document.body.scrollTop + document.documentElement.scrollTop
    );
    if (bodyScroll) {
      throw new Error(
        `${shot.id}/${take.id}: the page body is scrolled by ${bodyScroll}px`
      );
    }
    const recorder = await Recorder.start(
      context,
      page,
      path.join(dir, `${take.id}-frames`)
    );
    const timeline = new Timeline(page, () => recorder.now());
    try {
      await take.record(page, timeline);
    } finally {
      const duration = await recorder.stop(path.join(dir, rawVideoFile(take)));
      const file: TimelineFile = {
        video: rawVideoFile(take),
        viewport: take.viewport,
        scale: RECORDING_SCALE,
        fps: RECORDING_FPS,
        duration,
        beats: timeline.beats,
      };
      writeFileSync(
        path.join(dir, timelineFile(take)),
        `${JSON.stringify(file, null, 2)}\n`
      );
    }
  } finally {
    await context.close();
  }
}

/** Records every take of the shot on one host. */
async function recordTakes(shot: VideoShot): Promise<void> {
  mkdirSync(shotDir(shot), { recursive: true });
  const url = await startShotHost(shot);
  try {
    const browser = await chromium.launch({ args: RECORDING_LAUNCH_ARGS });
    try {
      for (const take of shot.takes) {
        await recordTake(shot, take, browser, url);
      }
    } finally {
      await browser.close();
    }
  } finally {
    stopHost();
  }
}

/** Reads the last recording of every take. */
function readTakes(shot: VideoShot): Record<string, TimelineFile> {
  const takes: Record<string, TimelineFile> = {};
  for (const take of shot.takes) {
    const timelinePath = path.join(shotDir(shot), timelineFile(take));
    if (!existsSync(timelinePath)) {
      throw new Error(
        `${shot.id} has no '${take.id}' take yet. Run \`npm run media -- ${shot.id}\` without --edit-only.`
      );
    }
    takes[take.id] = JSON.parse(
      readFileSync(timelinePath, "utf8")
    ) as TimelineFile;
  }
  return takes;
}

/** Renders the shot's composition from the last takes. */
async function renderEdit(shot: VideoShot): Promise<string> {
  const dir = shotDir(shot);
  const takes = readTakes(shot);
  // Loaded lazily: only video shots need Remotion.
  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  console.log(`bundling compositions...`);
  const serveUrl = await bundle({
    entryPoint: COMPOSITIONS_ENTRY,
    publicDir: dir,
  });
  const inputProps = { takes };
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
  if (!editOnly) await recordTakes(shot);
  const edit = await renderEdit(shot);
  mkdirSync(outDir, { recursive: true });
  const at = encodeVideoOutputs(edit, outDir, shot.outputs);
  await checkShippedVideoColors(outDir, shot.outputs, at);
}
