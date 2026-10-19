import type { Page } from "playwright";
import type { Timeline } from "./timeline.ts";

/**
 * Typing a person would do into a CodeMirror editor, at a pace a viewer can
 * follow. Prose goes quickly (an edit can speed it up further); the
 * characters that open a completion go slowly, and the list stays open long
 * enough to read before the pick.
 */
const PROSE_DELAY_MS = 35;
const TRIGGER_DELAY_MS = 110;
const COMPLETION_DWELL_SECONDS = 0.9;
/** ArrowDown presses allowed while looking for the wanted option. */
const MAX_OPTION_MOVES = 12;

export async function typeProse(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: PROSE_DELAY_MS });
}

export interface Completion {
  /**
   * What to type to open and narrow the list. Several parts are typed in
   * turn, waiting for the list after the first: needed when the text is only
   * valid once complete, like `$step:` at the end of a YAML value, where the
   * colon would otherwise close the list.
   */
  typed: string | readonly string[];
  /** Text in the wanted option's accessible name; arrows down to it if needed. */
  option: string;
  /** Beat labels: a focus on the open list, and a mark at the pick. */
  labels: { open: string; pick: string };
}

/**
 * Marks complete() records around the wait for a completion list, which can
 * take seconds the first time (the secret registry, for one). An edit plays
 * up to `typed`, then resumes at `listed`, so the wait never shows.
 */
export function completionWaitLabels(open: string): {
  typed: string;
  listed: string;
} {
  return { typed: `${open}:typed`, listed: `${open}:listed` };
}

/** Types a trigger, waits for its completion list, and picks `option` with Enter. */
export async function complete(
  page: Page,
  timeline: Timeline,
  { typed, option, labels }: Completion
): Promise<void> {
  const [first, ...rest] = typeof typed === "string" ? [typed] : typed;
  const list = page.getByRole("listbox", { name: "Completions" });
  const wait = completionWaitLabels(labels.open);
  await page.keyboard.type(first, { delay: TRIGGER_DELAY_MS });
  timeline.mark(wait.typed);
  await list.waitFor();
  timeline.mark(wait.listed);
  for (const part of rest) {
    await page.keyboard.type(part, { delay: TRIGGER_DELAY_MS });
  }
  const wanted = list.getByRole("option", { name: option }).first();
  await wanted.waitFor();
  for (
    let moves = 0;
    (await wanted.getAttribute("aria-selected")) !== "true";
    moves++
  ) {
    if (moves === MAX_OPTION_MOVES) {
      throw new Error(`completion '${option}' never got selected`);
    }
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
  }
  await timeline.focus(list, labels.open);
  await timeline.hold(COMPLETION_DWELL_SECONDS);
  timeline.mark(labels.pick);
  await page.keyboard.press("Enter");
  await list.waitFor({ state: "hidden" });
}
