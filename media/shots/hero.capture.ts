import type { Page } from "playwright";
import { resetPageScroll, WORKFLOWS_DIR } from "../lib/dashboard.ts";
import type { VideoShot } from "../lib/video.ts";
import type { Timeline } from "../lib/timeline.ts";
import {
  HERO_BEATS,
  HERO_JUMPS,
  HERO_STEP_COUNT,
  HERO_TAKE,
} from "./hero.beats.ts";

/** Written by replay from the bundle's workflow name (RunReplaySession). */
const HERO_WORKFLOW = `${WORKFLOWS_DIR}/notes-tagging-and-search-api.ctrlyoke.json`;
const HERO_WORKFLOW_NAME = "Notes Tagging and Search API";
/** Startup can stall for a while once a workflow is loaded (see lib/dashboard.ts). */
const STARTUP_TIMEOUT_MS = 120_000;
/** The replayed run takes about three minutes at a 1.2 s idle-gap cap. */
const RUN_TIMEOUT_MS = 10 * 60_000;

async function loadHeroWorkflow(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: "Open workflow menu" });
  await menu.waitFor();
  await page
    .getByLabel("Loading ctrlyoke…")
    .waitFor({ state: "hidden", timeout: STARTUP_TIMEOUT_MS });
  await menu.click();
  await page.getByRole("option", { name: "Load from File..." }).click();
  await page
    .getByPlaceholder("path/to/workflow.ctrlyoke.yaml")
    .fill(HERO_WORKFLOW);
  await page.getByRole("button", { name: "Load File" }).click();
  await page.getByText("Load Workflow File").waitFor({ state: "hidden" });
  await stepCount(page)
    .getByText(`${HERO_STEP_COUNT} steps`, { exact: true })
    .waitFor();
  // Replay writes the recorded workflow's name into the file's root `name`.
  await page
    .getByRole("button", { name: "Edit workflow name" })
    .getByText(HERO_WORKFLOW_NAME, { exact: true })
    .waitFor();
  await resetPageScroll(page);
}

/**
 * The steps panel header's counter: "6 steps" when idle, "Completed 2 of 6"
 * while running. The recent-workflows list repeats "6 steps", so scope to it.
 */
function stepCount(page: Page) {
  return page.getByRole("button", { name: "Collapse steps" });
}

/** The take: run the workflow, then jump back through the minimap. */
async function recordHero(page: Page, timeline: Timeline): Promise<void> {
  const output = page.getByRole("region", { name: "Output" });
  await timeline.hold(1.5);
  await timeline.click(
    // The heading row's Run, not the editor footer's (which queues a prompt).
    page.getByRole("button", { name: "Run", description: "Run draft" }),
    HERO_BEATS.RUN
  );
  // Diffs start collapsed, a persisted per-tab preference the page can't be
  // seeded with. The button appears with the first output; one click opens
  // every diff that follows. Not a beat, so the edit draws no pointer for it.
  await page.getByRole("button", { name: "Expand all diffs" }).click();
  await page.mouse.move(0, 0);
  await timeline.focus(output, HERO_BEATS.OUTPUT);
  for (let step = 2; step <= HERO_STEP_COUNT; step++) {
    await stepCount(page)
      .getByText(`Completed ${step - 1} of ${HERO_STEP_COUNT}`, {
        exact: true,
      })
      .waitFor({ timeout: RUN_TIMEOUT_MS });
    timeline.mark(HERO_BEATS.step(step));
  }
  await stepCount(page)
    .getByText(`${HERO_STEP_COUNT} steps`, { exact: true })
    .waitFor({ timeout: RUN_TIMEOUT_MS });
  timeline.mark(HERO_BEATS.DONE);
  await timeline.hold(2);

  // The output's right side, minimap included: where the jumps happen.
  const area = await output.boundingBox();
  if (!area) throw new Error("the output pane is not visible");
  const width = area.width * 0.55;
  timeline.focusArea(
    { x: area.x + area.width - width, y: area.y, w: width, h: area.height },
    HERO_BEATS.MINIMAP
  );
  for (const step of HERO_JUMPS) {
    const marker = page.getByRole("group", {
      name: `Step ${step}`,
      exact: true,
    });
    await timeline.hover(marker, HERO_BEATS.peek(step));
    await timeline.hold(1.2);
    await timeline.click(
      marker.getByRole("button", { name: step, exact: true }),
      HERO_BEATS.jump(step)
    );
    await timeline.hold(2.5);
  }
  await timeline.hold(1);
}

/**
 * The landing hero (SCREENSHOTS_AND_MEDIA_PLAN.md #6): the six-harness hero
 * workflow runs start to finish from a replay, then the output minimap jumps
 * back through it. The edit is `compositions/Hero.tsx`.
 */
export const hero: VideoShot = {
  id: "hero",
  description:
    "Landing hero: a six-harness workflow runs, then the minimap jumps back",
  run: "hero",
  // Long thinking pauses play as 1.2 s, so the 18-minute run records in
  // about three; the edit speeds the stretches up further.
  replay: { maxGapMs: 1200 },
  composition: "Hero",
  outputs: {
    av1: "hero-av1-2700x1800.mp4",
    h264: { file: "hero-h264-1350x900.mp4", width: 1350 },
    // Mid-run, with output streaming, so the poster alone says what it is.
    poster: { file: "hero-poster-2700x1800.webp", atSeconds: 14 },
    // The Marketplace README can't play video: the opening as a GIF.
    gif: { file: "readme-demo-900x600.gif", width: 900, seconds: 10, fps: 6 },
  },
  takes: [
    {
      id: HERO_TAKE,
      viewport: { width: 1350, height: 900 },
      prepare: loadHeroWorkflow,
      record: recordHero,
    },
  ],
};
