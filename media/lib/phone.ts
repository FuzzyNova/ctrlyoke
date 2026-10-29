import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { checkShippedVideoColors } from "./colorCheck.ts";
import {
  encodeVideoOutputs,
  WEB_VIDEO_COLOR_FILTER,
  WEB_VIDEO_COLOR_TAGS,
  type VideoOutputs,
} from "./encode.ts";
import { run } from "./exec.ts";
import { PHONE_FRAME_FILE, PHONE_SHOTS_DIR, WORK_DIR } from "./paths.ts";
import { measurePhoneFrame, type Box, type PhoneFrame } from "./phoneFrame.ts";
import { checkSize } from "./stills.ts";

/**
 * A phone shot: what to cut from one screen recording, kept in
 * `phone/<id>.json`. Times are seconds into the recording as recorded, so
 * they can be read straight off `--sheet`. They are `null` until picked.
 */
export interface PhoneShot {
  description: string;
  /** The stretch the overview and the video play. */
  clip?: { from: number | null; to: number | null };
  /** Framed stills; a `-<w>x<h>` suffix sets the width and is checked. */
  stills?: { file: string; at: number | null }[];
  /** The clip as an animated WebP with alpha, for docs pages (like #7's overviews). */
  overview?: { file: string; fps: number };
  /** The clip as web video on a solid background, optionally beside a desktop recording. */
  video?: PhoneVideo;
}

export interface PhoneVideo {
  /** The canvas at 2×; outputs.h264.width sets the 1× fallback. */
  width: number;
  height: number;
  /** CSS colour behind the phone (the landing page's own background). */
  background: string;
  outputs: VideoOutputs;
  /**
   * The same moment in both recordings, which lines them up: the desktop
   * recording passed with `--desktop` then plays left of the phone. Without
   * it, the phone plays alone in the middle.
   */
  sync?: { phone: number | null; desktop: number | null };
  /** The part of the desktop recording to show, in its own pixels; all of it by default. */
  desktopCrop?: Box;
}

export interface PhoneOptions {
  recording: string;
  outDir: string;
  /** The mockup PNG; defaults to PHONE_FRAME_FILE. */
  frame?: string;
  desktop?: string;
  only?: string;
  /** Write a contact sheet of the recording instead of the outputs, at this many frames a second. */
  sheetFps?: number;
}

const FFMPEG_QUIET = ["-hide_banner", "-loglevel", "error", "-y"];
/** The phone footage's rate after conversion: iPhone recordings are variable frame rate. */
const FPS = 30;
const SHEET_COLUMNS = 8;
const SHEET_TILE_WIDTH = 220;

export function loadPhoneShot(id: string): PhoneShot {
  const file = path.join(PHONE_SHOTS_DIR, `${id}.json`);
  if (!existsSync(file)) {
    throw new Error(`no phone shot '${id}' (looked for ${file})`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as PhoneShot;
}

function picked(value: number | null | undefined, what: string): number {
  if (value === null || value === undefined) {
    throw new Error(
      `${what} has no time yet. Pick it from the contact sheet (--sheet) and put it in the shot's JSON.`
    );
  }
  return value;
}

function sizeFromName(
  file: string
): { width: number; height: number } | undefined {
  const match = /-(\d+)x(\d+)\.\w+$/.exec(file);
  return match
    ? { width: Number(match[1]), height: Number(match[2]) }
    : undefined;
}

function durationSeconds(file: string): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" }
  );
  const seconds = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(seconds)) {
    throw new Error(`ffprobe could not read the duration of ${file}`);
  }
  return seconds;
}

/** ffmpeg inputs 1 and 2: the mockup and its alpha, repeated for every frame. */
function frameInputs(frame: PhoneFrame): string[] {
  return ["-loop", "1", "-i", frame.file, "-loop", "1", "-i", frame.alpha];
}

/**
 * Filters that put recording input 0 into the mockup (inputs 1 and 2) and
 * label the result `[phone]`: RGBA, cropped to the device. The recording
 * covers the screen opening (iPhone recordings already have the screen's
 * shape, so little or nothing is cropped), the mockup is drawn over it on an
 * opaque canvas, and then the frame's alpha cuts out the device.
 */
function phoneFilters(frame: PhoneFrame): string[] {
  const { screen, device } = frame;
  return [
    `[0:v]fps=${FPS},scale=${screen.width}:${screen.height}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${screen.width}:${screen.height},format=rgb24,` +
      `pad=${frame.width}:${frame.height}:${screen.x}:${screen.y}:color=black[screen]`,
    "[screen][1:v]overlay=0:0:format=rgb,format=rgba[framed]",
    "[2:v]format=gray[alpha]",
    `[framed][alpha]alphamerge,crop=${device.width}:${device.height}:${device.x}:${device.y}[phone]`,
  ];
}

/** Scales `input` to `width` (height follows) and labels it `[out]`. */
function scaledTo(width: number | undefined, input = "[phone]"): string {
  return width
    ? `${input}scale=${width}:-2:flags=lanczos[out]`
    : `${input}null[out]`;
}

function writeStill(
  shot: PhoneShot,
  still: NonNullable<PhoneShot["stills"]>[number],
  frame: PhoneFrame,
  options: PhoneOptions
): void {
  const at = picked(still.at, still.file);
  const file = path.join(options.outDir, still.file);
  run(
    "ffmpeg",
    [
      ...FFMPEG_QUIET,
      "-ss",
      String(at),
      "-i",
      options.recording,
      ...frameInputs(frame),
      "-filter_complex",
      [...phoneFilters(frame), scaledTo(sizeFromName(still.file)?.width)].join(
        ";"
      ),
      "-map",
      "[out]",
      "-frames:v",
      "1",
      file,
    ],
    options.outDir
  );
  checkSize(still.file, file);
  console.log(`framed ${still.file} (${shot.description}, ${at}s)`);
}

function clipRange(shot: PhoneShot): { from: number; duration: number } {
  const from = picked(shot.clip?.from, "clip.from");
  const to = picked(shot.clip?.to, "clip.to");
  if (to <= from)
    throw new Error(`clip.to (${to}) must be after clip.from (${from})`);
  return { from, duration: to - from };
}

/** Animated WebP with alpha: GIF's 1-bit alpha would leave the rounded corners jagged. */
function writeOverview(
  shot: PhoneShot,
  overview: NonNullable<PhoneShot["overview"]>,
  frame: PhoneFrame,
  options: PhoneOptions
): void {
  const { from, duration } = clipRange(shot);
  const file = path.join(options.outDir, overview.file);
  run(
    "ffmpeg",
    [
      ...FFMPEG_QUIET,
      "-ss",
      String(from),
      "-t",
      String(duration),
      "-i",
      options.recording,
      ...frameInputs(frame),
      "-filter_complex",
      [
        ...phoneFilters(frame),
        `[phone]fps=${overview.fps}[slow]`,
        scaledTo(sizeFromName(overview.file)?.width, "[slow]"),
      ].join(";"),
      "-map",
      "[out]",
      "-t",
      String(duration),
      "-c:v",
      "libwebp_anim",
      "-pix_fmt",
      "yuva420p",
      "-quality",
      "75",
      "-loop",
      "0",
      file,
    ],
    options.outDir
  );
  const kb = Math.round(statSync(file).size / 1024);
  console.log(`encoded ${overview.file} (${kb} KB)`);
}

/**
 * Renders the clip on its background, the phone at 90% of the canvas height:
 * on the right with the desktop recording fitted into the space to its left,
 * or centred when there is no desktop recording.
 */
function renderVideoEdit(
  shot: PhoneShot,
  video: PhoneVideo,
  frame: PhoneFrame,
  options: PhoneOptions
): string {
  const { from, duration } = clipRange(shot);
  const phoneHeight = Math.round((video.height * 0.9) / 2) * 2;
  const phoneWidth =
    Math.round((frame.device.width * phoneHeight) / frame.device.height / 2) *
    2;
  const margin = Math.round((video.height - phoneHeight) / 2);
  const inputs = [
    "-ss",
    String(from),
    "-t",
    String(duration),
    "-i",
    options.recording,
    ...frameInputs(frame),
    "-f",
    "lavfi",
    "-i",
    `color=c=${video.background}:s=${video.width}x${video.height}:r=${FPS}`,
  ];
  const filters = [
    ...phoneFilters(frame),
    `[phone]scale=${phoneWidth}:${phoneHeight}:flags=lanczos[small]`,
  ];
  let phoneX = Math.round((video.width - phoneWidth) / 2);
  let base = "[3:v]";
  if (video.sync && options.desktop) {
    const desktopStart =
      from -
      picked(video.sync.phone, "video.sync.phone") +
      picked(video.sync.desktop, "video.sync.desktop");
    if (desktopStart < 0) {
      throw new Error(
        `the desktop recording starts ${(-desktopStart).toFixed(2)}s after the clip; start the clip later`
      );
    }
    inputs.push(
      "-ss",
      String(desktopStart),
      "-t",
      String(duration),
      "-i",
      options.desktop
    );
    phoneX = video.width - margin - phoneWidth;
    const boxWidth = phoneX - 2 * margin;
    const crop = video.desktopCrop;
    filters.push(
      `[4:v]fps=${FPS},${crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` : ""}scale=${boxWidth}:${video.height - 2 * margin}:force_original_aspect_ratio=decrease:flags=lanczos[desktop]`,
      `[3:v][desktop]overlay=x=${margin}+(${boxWidth}-overlay_w)/2:y=(main_h-overlay_h)/2[withdesktop]`
    );
    base = "[withdesktop]";
  } else if (video.sync) {
    throw new Error(
      "this shot plays beside a desktop recording: pass --desktop <file>"
    );
  }
  filters.push(
    `${base}[small]overlay=x=${phoneX}:y=${margin}:format=rgb,${WEB_VIDEO_COLOR_FILTER}[out]`
  );
  const edit = path.join(phoneWorkDir(options), "edit.mp4");
  run(
    "ffmpeg",
    [
      ...FFMPEG_QUIET,
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-t",
      String(duration),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "12",
      ...WEB_VIDEO_COLOR_TAGS,
      edit,
    ],
    options.outDir
  );
  return edit;
}

function phoneWorkDir(options: PhoneOptions): string {
  const dir = path.join(WORK_DIR, "phone", path.parse(options.recording).name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Tiles the whole recording `fps` frames a second, left to right and top to
 * bottom, so times can be read off by counting. Works on the desktop
 * recording too, to find its side of `video.sync`.
 */
function writeContactSheet(options: PhoneOptions, fps: number): void {
  const tiles = Math.ceil(durationSeconds(options.recording) * fps);
  const rows = Math.ceil(tiles / SHEET_COLUMNS);
  const sheet = path.join(phoneWorkDir(options), `sheet-${fps}fps.png`);
  run(
    "ffmpeg",
    [
      ...FFMPEG_QUIET,
      "-i",
      options.recording,
      "-vf",
      `fps=${fps},scale=${SHEET_TILE_WIDTH}:-2,tile=${SHEET_COLUMNS}x${rows}:padding=6:color=white`,
      "-frames:v",
      "1",
      sheet,
    ],
    options.outDir
  );
  console.log(
    `wrote ${sheet}\n${tiles} tiles, ${SHEET_COLUMNS} per row: tile n (from 0) is at n/${fps} s.`
  );
}

/** Cuts a phone shot's stills, overview and video from its recording. */
export async function capturePhoneShot(
  id: string,
  options: PhoneOptions
): Promise<void> {
  const shot = loadPhoneShot(id);
  if (!existsSync(options.recording)) {
    throw new Error(`no recording at ${options.recording}`);
  }
  if (options.sheetFps) return writeContactSheet(options, options.sheetFps);

  const frameFile = options.frame ?? PHONE_FRAME_FILE;
  if (!existsSync(frameFile)) {
    throw new Error(
      `no phone mockup at ${frameFile}. Copy the iPhone 13 mockup PNG there, or pass --frame <png>.`
    );
  }
  const frame = measurePhoneFrame(frameFile, path.join(WORK_DIR, "phone"));
  console.log(
    `mockup ${frame.width}x${frame.height}: screen ${frame.screen.width}x${frame.screen.height} at ${frame.screen.x},${frame.screen.y}; device ${frame.device.width}x${frame.device.height}`
  );
  mkdirSync(options.outDir, { recursive: true });
  const wanted = (file: string) => !options.only || options.only === file;

  for (const still of shot.stills ?? []) {
    if (wanted(still.file)) writeStill(shot, still, frame, options);
  }
  if (shot.overview && wanted(shot.overview.file)) {
    writeOverview(shot, shot.overview, frame, options);
  }
  if (shot.video && wanted(shot.video.outputs.av1)) {
    const edit = renderVideoEdit(shot, shot.video, frame, options);
    const at = encodeVideoOutputs(edit, options.outDir, shot.video.outputs);
    await checkShippedVideoColors(options.outDir, shot.video.outputs, at);
  }
}
