import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { setTheme } from "./devHost.ts";
import { WORK_DIR } from "./paths.ts";
import type { CaptureOptions, Composite, Stage, Still } from "./shot.ts";
import { DEFAULT_THEME, THEMES } from "./themes.ts";

const DEVICE_SCALE_FACTOR = 2;
/** Part stills wait here until their composite is built. */
const PARTS_DIR = path.join(WORK_DIR, "parts");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(file).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

export function checkSize(name: string, file: string): void {
  const match = /-(\d+)x(\d+)\.png$/.exec(name);
  if (!match) return;
  const { width, height } = pngSize(file);
  if (width !== Number(match[1]) || height !== Number(match[2])) {
    throw new Error(
      `${name} came out ${width}x${height}. Fix the shot, or rename the file and its references if the new size is intended.`
    );
  }
}

async function captureStill(
  browser: Browser,
  url: string,
  still: Still,
  outDir: string,
  now: string | undefined
): Promise<void> {
  const context = await browser.newContext({
    viewport: still.viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: THEMES[still.theme ?? DEFAULT_THEME].colorScheme,
  });
  try {
    // Fixes Date.now() only; timers keep running, so the dashboard does too.
    if (now) await context.clock.setFixedTime(now);
    const page = await context.newPage();
    await page.goto(url);
    const target = await still.setup(page);
    // Park the pointer so no hover state or high-contrast hover outline shows.
    await page.mouse.move(0, 0);
    // The dashboard never scrolls its document; a scrolled body means the
    // automation pushed the layout somewhere a user can't reach.
    const bodyScroll = await page.evaluate(
      () => document.body.scrollTop + document.documentElement.scrollTop
    );
    if (bodyScroll) {
      throw new Error(
        `${still.file}: the page body is scrolled by ${bodyScroll}px`
      );
    }
    const file = path.join(still.part ? PARTS_DIR : outDir, still.file);
    const options = {
      path: file,
      animations: "disabled",
      caret: "hide",
    } as const;
    if (!target) await page.screenshot(options);
    else if ("screenshot" in target) await target.screenshot(options);
    else await page.screenshot({ ...options, clip: target });
    if (!still.part) checkSize(still.file, file);
    console.log(`captured ${still.file}${still.part ? " (part)" : ""}`);
  } catch (error) {
    throw new Error(
      `${still.file} failed: ${error instanceof Error ? error.message : error}`
    );
  } finally {
    await context.close();
  }
}

/** Captures a stage's stills named in `files` from the hosted dashboard at `url`. */
export async function captureStage(
  stage: Stage,
  url: string,
  files: Set<string>,
  { outDir }: CaptureOptions
): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(PARTS_DIR, { recursive: true });
  const browser = await chromium.launch();
  let theme = DEFAULT_THEME;
  try {
    for (const still of stage.stills.filter((candidate) =>
      files.has(candidate.file)
    )) {
      const wanted = still.theme ?? DEFAULT_THEME;
      if (wanted !== theme) {
        await setTheme(url, wanted);
        theme = wanted;
      }
      await captureStill(browser, url, still, outDir, stage.now);
    }
  } finally {
    await browser.close();
  }
}

/** Joins a composite's part stills left to right, top-aligned, at their pixel size. */
export async function compose(
  composite: Composite,
  { outDir }: CaptureOptions
): Promise<void> {
  const parts = composite.parts.map((part) => {
    const file = path.join(PARTS_DIR, part);
    return { ...pngSize(file), data: readFileSync(file).toString("base64") };
  });
  const width = parts.reduce((sum, part) => sum + part.width, 0);
  const height = Math.max(...parts.map((part) => part.height));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    const images = parts
      .map(
        (part) =>
          `<img src="data:image/png;base64,${part.data}" width="${part.width}" height="${part.height}">`
      )
      .join("");
    await page.setContent(
      `<body style="margin:0;display:flex;align-items:flex-start;background:transparent">${images}</body>`
    );
    const file = path.join(outDir, composite.file);
    await page.screenshot({ path: file, omitBackground: true });
    checkSize(composite.file, file);
    console.log(`composed ${composite.file}`);
  } finally {
    await browser.close();
  }
}
