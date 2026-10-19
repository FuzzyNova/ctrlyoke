import type { Locator, Page } from "playwright";

/**
 * The edit list a video capture writes beside its raw recording
 * (MEDIA_CAPTURE_AUTOMATION_PLAN.md §3). The capture script performs each
 * action through `Timeline`, so every beat carries the moment it happened and
 * where its element was. A composition then cuts, zooms and draws the pointer
 * from these beats, and nobody scrubs for timestamps.
 *
 * Compositions import these types, so this file must stay free of runtime
 * Playwright use outside the `Timeline` class.
 */

/** A page region in CSS pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const BEAT_KINDS = {
  /** A pointer click on `box`, at `point`. */
  CLICK: "click",
  /** The pointer moved over `box` and rests at `point`. */
  HOVER: "hover",
  /** A region worth looking at; nothing was done to it. */
  FOCUS: "focus",
  /** A named moment with no region, e.g. "the run finished". */
  MARK: "mark",
} as const;
export type BeatKind = (typeof BEAT_KINDS)[keyof typeof BEAT_KINDS];

export interface Beat {
  /** Seconds since the recording's first frame. */
  t: number;
  kind: BeatKind;
  /** Unique within a timeline; compositions refer to beats by it. */
  label: string;
  box?: Box;
  point?: { x: number; y: number };
  /**
   * Seconds the pointer took to get here from the previous beat, when the page
   * saw it move (a drag); the edit draws the pointer gliding over the same
   * stretch, so it stays on the dragged element.
   */
  travel?: number;
}

export interface TimelineFile {
  /** The raw recording, relative to this file. */
  video: string;
  /** CSS viewport; the video is `scale` times this. */
  viewport: { width: number; height: number };
  scale: number;
  fps: number;
  /** Length of the raw recording in seconds. */
  duration: number;
  beats: Beat[];
}

/** The cubic ease the edit moves its camera and pointer with, and drags move by. */
export function easeInOut(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

/** A point on the page in CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

/** Updates per second while a drag moves the real pointer. */
const DRAG_STEPS_PER_SECOND = 30;

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} is not visible`);
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

function centre(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Records beats against a recording clock while driving the page. */
export class Timeline {
  readonly beats: Beat[] = [];
  private readonly page: Page;
  private readonly clock: () => number;

  /** `clock` returns seconds since the recording's first frame. */
  constructor(page: Page, clock: () => number) {
    this.page = page;
    this.clock = clock;
  }

  private add(beat: Omit<Beat, "t">): void {
    if (this.beats.some((existing) => existing.label === beat.label)) {
      throw new Error(`timeline already has a beat named '${beat.label}'`);
    }
    this.beats.push({ t: this.clock(), ...beat });
  }

  /** Clicks the element's centre, with the pointer travelling there first. */
  async click(locator: Locator, label: string): Promise<void> {
    const box = await boxOf(locator);
    const point = centre(box);
    await this.page.mouse.move(point.x, point.y, { steps: 8 });
    this.add({ kind: BEAT_KINDS.CLICK, label, box, point });
    await this.page.mouse.click(point.x, point.y);
  }

  /**
   * Clicks a point that isn't one element's centre, e.g. a text position in
   * an editor. `shift` extends a selection; `button: "right"` opens a context
   * menu.
   */
  async clickAt(
    point: Point,
    label: string,
    options: { button?: "left" | "right"; shift?: boolean } = {}
  ): Promise<void> {
    await this.page.mouse.move(point.x, point.y, { steps: 8 });
    this.add({
      kind: BEAT_KINDS.CLICK,
      label,
      box: { x: point.x, y: point.y, w: 1, h: 1 },
      point,
    });
    if (options.shift) await this.page.keyboard.down("Shift");
    await this.page.mouse.click(point.x, point.y, { button: options.button });
    if (options.shift) await this.page.keyboard.up("Shift");
  }

  /**
   * Presses on `handle`, moves to `to` over `seconds` on the edit's own ease,
   * and releases: a pointer drag (dnd-kit ignores the HTML5 drag events
   * Playwright's `dragTo` sends). Records a click beat `grab` and a hover
   * beat `drop` whose `travel` is the drag, so the drawn pointer moves with
   * the dragged element.
   */
  async drag(
    handle: Locator,
    to: Point,
    labels: { grab: string; drop: string },
    seconds = 1.2
  ): Promise<void> {
    const box = await boxOf(handle);
    const from = centre(box);
    const mouse = this.page.mouse;
    await mouse.move(from.x, from.y, { steps: 8 });
    this.add({ kind: BEAT_KINDS.CLICK, label: labels.grab, box, point: from });
    await mouse.down();
    const start = this.clock();
    const steps = Math.max(2, Math.round(seconds * DRAG_STEPS_PER_SECOND));
    for (let step = 1; step <= steps; step++) {
      const amount = easeInOut(step / steps);
      await mouse.move(
        from.x + (to.x - from.x) * amount,
        from.y + (to.y - from.y) * amount
      );
      await this.page.waitForTimeout((seconds * 1000) / steps);
    }
    this.add({
      kind: BEAT_KINDS.HOVER,
      label: labels.drop,
      box: { x: to.x, y: to.y, w: 1, h: 1 },
      point: to,
      travel: this.clock() - start,
    });
    // Let the drop target settle under the pointer before letting go.
    await this.page.waitForTimeout(250);
    await mouse.up();
  }

  /** Moves the pointer over the element and leaves it there. */
  async hover(locator: Locator, label: string): Promise<void> {
    const box = await boxOf(locator);
    const point = centre(box);
    await this.page.mouse.move(point.x, point.y, { steps: 8 });
    this.add({ kind: BEAT_KINDS.HOVER, label, box, point });
  }

  /** Marks the element's current box as worth a look. */
  async focus(locator: Locator, label: string): Promise<void> {
    this.add({ kind: BEAT_KINDS.FOCUS, label, box: await boxOf(locator) });
  }

  /** Marks a region that isn't one element, e.g. part of a panel. */
  focusArea(box: Box, label: string): void {
    this.add({ kind: BEAT_KINDS.FOCUS, label, box });
  }

  mark(label: string): void {
    this.add({ kind: BEAT_KINDS.MARK, label });
  }

  /** Lets the recording run for `seconds` of wall time. */
  async hold(seconds: number): Promise<void> {
    await this.page.waitForTimeout(seconds * 1000);
  }
}
