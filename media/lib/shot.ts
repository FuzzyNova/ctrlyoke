import type { Locator, Page } from "playwright";
import type { HostOptions } from "./devHost.ts";
import type { ThemeName } from "./themes.ts";

/** A page region in CSS pixels. */
export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Still {
  /**
   * Output file in images/screenshots/. Its `-<w>x<h>` suffix is checked
   * against the captured PNG, so a layout change can't silently resize it.
   */
  file: string;
  /** CSS viewport; the PNG is captured at 2× this. */
  viewport: { width: number; height: number };
  /** VS Code color theme the dashboard mirrors; the host's default (Dark 2026) when omitted. */
  theme?: ThemeName;
  /**
   * Only an input to a composite: written to the work folder, not to
   * images/screenshots/, and not size-checked on its own.
   */
  part?: boolean;
  /**
   * Drives the open dashboard to the shot's state. Returns the element or
   * region to capture, or nothing for the whole viewport.
   */
  setup(page: Page): Promise<Locator | Clip | void>;
}

/** One dev host start and the stills captured from it. */
export interface Stage {
  host?: HostOptions;
  /** Files from fixtures/workflows/ installed into demo-app's .ctrlyoke/workflows/. */
  workflows?: string[];
  stills: Still[];
}

/** Part stills (by file name) joined left to right into one image. */
export interface Composite {
  file: string;
  parts: string[];
}

export interface Shot {
  id: string;
  description: string;
  stages: Stage[];
  composites?: Composite[];
  /** Quantize every output PNG to a 256-color palette (for media that ships in the VSIX). */
  quantize?: boolean;
}

export interface CaptureOptions {
  /** Capture only the still or composite with this file name. */
  only?: string;
  /** Where the PNGs go; images/screenshots/ unless previewing elsewhere. */
  outDir: string;
  /** Video shots: re-render and re-encode the last take instead of recording a new one. */
  editOnly?: boolean;
}

/** Every file a shot writes to the output folder. */
export function outputFiles(shot: Shot): string[] {
  const stills = shot.stages
    .flatMap((stage) => stage.stills)
    .filter((still) => !still.part)
    .map((still) => still.file);
  return [
    ...stills,
    ...(shot.composites ?? []).map((composite) => composite.file),
  ];
}

/**
 * The still files to capture for `only` (a still or a composite, whose parts
 * it then means), or every still when `only` is unset.
 */
export function selectStills(
  shot: Shot,
  only: string | undefined
): Set<string> {
  const all = shot.stages.flatMap((stage) =>
    stage.stills.map((still) => still.file)
  );
  if (!only) return new Set(all);
  const composite = shot.composites?.find(
    (candidate) => candidate.file === only
  );
  if (composite) return new Set(composite.parts);
  if (all.includes(only)) return new Set([only]);
  throw new Error(
    `shot '${shot.id}' has no still or composite named '${only}'`
  );
}
