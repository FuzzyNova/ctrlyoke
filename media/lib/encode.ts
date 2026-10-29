import { spawnSync } from "node:child_process";
import { renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { run } from "./exec.ts";

const FFMPEG_QUIET = ["-hide_banner", "-loglevel", "error", "-y"];

/**
 * ffmpeg output options for video a browser will play: `filters` first, then
 * conversion to limited-range BT.709 4:2:0, tagged as such.
 *
 * Screencast JPEGs are full-range BT.601, and ffmpeg carries that through
 * untouched (`yuvj420p`, `bt470bg`) unless told otherwise. ffmpeg itself reads
 * those tags back correctly, so stills extracted with it look right, but
 * browsers treat web video as limited-range BT.709 and showed the 2026-10-18
 * hero with crushed, shifted colours. Every video stage uses this.
 */
export function webVideoColorArgs(filters: readonly string[] = []): string[] {
  return [
    "-vf",
    [...filters, WEB_VIDEO_COLOR_FILTER].join(","),
    ...WEB_VIDEO_COLOR_TAGS,
  ];
}

/**
 * The conversion half of `webVideoColorArgs`, to end a `-filter_complex`
 * chain with (ffmpeg takes `-vf` or `-filter_complex`, not both); add
 * `WEB_VIDEO_COLOR_TAGS` to the output options.
 */
export const WEB_VIDEO_COLOR_FILTER =
  "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";

export const WEB_VIDEO_COLOR_TAGS: readonly string[] = [
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-color_range",
  "tv",
];

/** The files a video shot ships, all from one edit. */
export interface VideoOutputs {
  /** AV1 in MP4 at the edit's full (2×) size: the first `<source>`. */
  av1: string;
  /**
   * H.264 fallback for browsers without AV1 decode (older Safari), scaled to
   * `width`: at 2× it would be about twice the AV1 file for a few visitors.
   */
  h264: { file: string; width: number };
  /**
   * WebP still at full size, shown while the video loads or when autoplay is
   * blocked. A negative `atSeconds` counts back from the end, for a poster of
   * the finished state when the take's length varies.
   */
  poster: { file: string; atSeconds: number };
  /**
   * An animated GIF of the edit's opening `seconds`, for places that can't
   * play video (the Marketplace README). See `encodeGif`.
   */
  gif?: { file: string; width: number; seconds: number; fps: number };
}

/**
 * The UI GIF recipe from SCREENSHOTS_AND_MEDIA_PLAN.md "GIF encoding": 128
 * colours so accent colours survive, no dithering on flat UI, and gifsicle's
 * lossy pass, which roughly halves the file.
 */
function encodeGif(
  edit: string,
  output: string,
  gif: NonNullable<VideoOutputs["gif"]>
): void {
  const raw = `${output}.raw.gif`;
  run(
    "ffmpeg",
    [
      ...FFMPEG_QUIET,
      "-t",
      String(gif.seconds),
      "-i",
      edit,
      "-vf",
      `fps=${gif.fps},scale=${gif.width}:-1:flags=lanczos,split[a][b];` +
        "[a]palettegen=max_colors=128:stats_mode=diff[p];" +
        "[b][p]paletteuse=dither=none:diff_mode=rectangle",
      raw,
    ],
    path.dirname(output)
  );
  run(
    "npx",
    ["-y", "gifsicle@7.0.1", "-O3", "--lossy=20", "-o", output, raw],
    path.dirname(output)
  );
  rmSync(raw);
}

/** Shipped frame rate: smooth enough for the camera moves, a fifth smaller than 30. */
const SHIPPED_FPS = "24";

/** The edit's duration in seconds, from ffprobe. */
function durationSeconds(file: string): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" }
  );
  if (result.error) throw result.error;
  const seconds = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(seconds)) {
    throw new Error(`ffprobe could not read the duration of ${file}`);
  }
  return seconds;
}

/**
 * Resolves the poster's `atSeconds` against the edit's length. ffmpeg writes
 * an empty file, without an error, for a time past the end, which takes
 * change length enough to reach.
 */
function posterSeconds(edit: string, atSeconds: number): number {
  const duration = durationSeconds(edit);
  const at = atSeconds < 0 ? duration + atSeconds : atSeconds;
  if (at < 0 || at >= duration) {
    throw new Error(
      `poster time ${atSeconds}s is outside the ${duration.toFixed(2)}s edit`
    );
  }
  return at;
}

/**
 * Encodes a rendered edit into the shipped formats and returns the poster's
 * time in seconds. Dashboard footage is flat
 * colour and mostly static between deliveries, which AV1 compresses far
 * better than H.264 at the same look. The CRFs were picked on the 2026-10-18
 * hero: at AV1 CRF 48 its 2× text is still sharp when paused, at about a third
 * of CRF 36's size. `+faststart` lets playback start before the file loads.
 */
export function encodeVideoOutputs(
  edit: string,
  outDir: string,
  outputs: VideoOutputs
): number {
  const posterAt = posterSeconds(edit, outputs.poster.atSeconds);
  const av1 = path.join(outDir, outputs.av1);
  run(
    "ffmpeg",
    [
      ...FFMPEG_QUIET,
      "-i",
      edit,
      "-an",
      "-r",
      SHIPPED_FPS,
      "-c:v",
      "libsvtav1",
      "-preset",
      "4",
      "-crf",
      "48",
      ...webVideoColorArgs(),
      "-movflags",
      "+faststart",
      av1,
    ],
    outDir
  );
  const h264 = path.join(outDir, outputs.h264.file);
  run(
    "ffmpeg",
    [
      ...FFMPEG_QUIET,
      "-i",
      edit,
      "-an",
      "-r",
      SHIPPED_FPS,
      ...webVideoColorArgs([`scale=${outputs.h264.width}:-2:flags=lanczos`]),
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "28",
      "-tune",
      "stillimage",
      "-movflags",
      "+faststart",
      h264,
    ],
    outDir
  );
  const poster = path.join(outDir, outputs.poster.file);
  run(
    "ffmpeg",
    [
      ...FFMPEG_QUIET,
      "-ss",
      String(posterAt),
      "-i",
      edit,
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-quality",
      "82",
      poster,
    ],
    outDir
  );
  const written = [av1, h264, poster];
  if (outputs.gif) {
    const gif = path.join(outDir, outputs.gif.file);
    encodeGif(edit, gif, outputs.gif);
    written.push(gif);
  }
  for (const file of written) {
    const kb = Math.round(statSync(file).size / 1024);
    console.log(`encoded ${path.basename(file)} (${kb} KB)`);
  }
  return posterAt;
}

/**
 * Reduces a PNG to a 256-color palette in place, with no dithering, as the
 * walkthrough stills that ship in the VSIX were compressed on 2026-10-16
 * (dev/backlog/SCREENSHOTS_AND_MEDIA_PLAN.md #13). Flat UI loses about half
 * its bytes with no visible change. Needs ffmpeg on PATH.
 */
export function quantizePng(file: string): void {
  const temporary = `${file}.quantized.png`;
  run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      file,
      "-vf",
      "split[a][b];[a]palettegen=max_colors=256:reserve_transparent=0[p];[b][p]paletteuse=dither=none",
      temporary,
    ],
    process.cwd()
  );
  renameSync(temporary, file);
}
