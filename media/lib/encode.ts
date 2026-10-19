import { renameSync } from "node:fs";
import { run } from "./exec.ts";

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
