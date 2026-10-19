import {
  BEAT_KINDS,
  easeInOut,
  type Beat,
  type Box,
  type TimelineFile,
} from "../lib/timeline.ts";
import { completionWaitLabels } from "../lib/typing.ts";

/**
 * Edit-as-code (MEDIA_CAPTURE_AUTOMATION_PLAN.md §4): a video's edit is a list
 * of cuts over its raw recording, named by the beats the capture recorded.
 * This file turns that list into frames, a camera and a pointer; `Edit.tsx`
 * draws them. Kept free of React so the arithmetic stays easy to check.
 */

/**
 * A moment in the raw recording: a beat label (`"start"` and `"end"` always
 * exist), a beat plus an offset in recorded seconds, or recorded seconds.
 */
export type At = string | number | { beat: string; offset: number };

export interface Play {
  from: At;
  to: At;
  /** Playback speed; 4 plays four recorded seconds per second. Defaults to 1. */
  rate?: number;
  /** A beat whose box the camera frames, or a box in CSS pixels. Full frame when omitted. */
  focus?: string | Box;
  /** Caps how far `focus` zooms in (default `MAX_ZOOM`). */
  maxZoom?: number;
}

/** Holds a single recorded frame on screen. */
export interface Hold {
  hold: At;
  seconds: number;
  focus?: string | Box;
  maxZoom?: number;
}

export type Cut = Play | Hold;

/** A width and height in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

export interface EditSpec {
  cuts: Cut[];
  /** Seconds the camera takes to move between cuts' framings. */
  cameraMove?: number;
  /**
   * The window the edit shows the page through, in CSS pixels. Defaults to
   * the take's viewport; a narrower frame crops it, e.g. one pane of a
   * side-by-side, and the camera never shows past the page's edges.
   */
  frame?: Size;
}

/** What the camera shows: zoom factor and the centre point, in CSS pixels. */
export interface Camera {
  zoom: number;
  cx: number;
  cy: number;
}

export interface Segment {
  /** Recorded seconds this segment starts and ends at (equal for a hold). */
  from: number;
  to: number;
  rate: number;
  hold: boolean;
  startFrame: number;
  frames: number;
  camera: Camera;
}

export interface EditPlan {
  segments: Segment[];
  frames: number;
  cameraMoveFrames: number;
}

const MAX_ZOOM = 1.8;
/** Room left around a focused box, as a fraction of its size. */
const FOCUS_MARGIN = 0.12;
const DEFAULT_CAMERA_MOVE = 0.6;

function findBeat(timeline: TimelineFile, label: string): Beat {
  const beat = timeline.beats.find((candidate) => candidate.label === label);
  if (!beat) {
    throw new Error(
      `the recording has no beat '${label}' (it has: ${timeline.beats.map((b) => b.label).join(", ")})`
    );
  }
  return beat;
}

export function resolveAt(at: At, timeline: TimelineFile): number {
  const seconds =
    typeof at === "number"
      ? at
      : typeof at === "string"
        ? at === "start"
          ? 0
          : at === "end"
            ? timeline.duration
            : findBeat(timeline, at).t
        : resolveAt(at.beat, timeline) + at.offset;
  return Math.min(Math.max(seconds, 0), timeline.duration);
}

/**
 * The camera that frames `box` as large as `maxZoom` allows in a `frame`-sized
 * window (the viewport when omitted), never showing past the page's edges.
 */
export function frameBox(
  box: Box | undefined,
  viewport: Size,
  maxZoom = MAX_ZOOM,
  frame: Size = viewport
): Camera {
  const { width, height } = viewport;
  // The least zoom at which the page still fills the frame.
  const minZoom = Math.max(frame.width / width, frame.height / height);
  if (!box) return { zoom: minZoom, cx: width / 2, cy: height / 2 };
  const margin = 1 + FOCUS_MARGIN * 2;
  const zoom = Math.min(
    Math.max(
      Math.min(frame.width / (box.w * margin), frame.height / (box.h * margin)),
      minZoom
    ),
    Math.max(maxZoom, minZoom)
  );
  const halfW = frame.width / zoom / 2;
  const halfH = frame.height / zoom / 2;
  const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), high);
  return {
    zoom,
    cx: clamp(box.x + box.w / 2, halfW, width - halfW),
    cy: clamp(box.y + box.h / 2, halfH, height - halfH),
  };
}

function focusBox(
  focus: string | Box | undefined,
  timeline: TimelineFile
): Box | undefined {
  if (focus === undefined) return undefined;
  if (typeof focus !== "string") return focus;
  const box = findBeat(timeline, focus).box;
  if (!box) throw new Error(`beat '${focus}' has no box to focus on`);
  return box;
}

export function planEdit(
  spec: EditSpec,
  timeline: TimelineFile,
  fps: number
): EditPlan {
  let startFrame = 0;
  const segments = spec.cuts.map((cut): Segment => {
    const camera = frameBox(
      focusBox(cut.focus, timeline),
      timeline.viewport,
      cut.maxZoom,
      spec.frame
    );
    if ("hold" in cut) {
      const at = resolveAt(cut.hold, timeline);
      const frames = Math.max(1, Math.round(cut.seconds * fps));
      const segment = {
        from: at,
        to: at,
        rate: 0,
        hold: true,
        startFrame,
        frames,
        camera,
      };
      startFrame += frames;
      return segment;
    }
    const from = resolveAt(cut.from, timeline);
    const to = resolveAt(cut.to, timeline);
    const rate = cut.rate ?? 1;
    if (!(to > from) || !(rate > 0)) {
      throw new Error(
        `a cut must run forward at a positive rate (from ${from}s to ${to}s at ${rate}x)`
      );
    }
    const frames = Math.max(1, Math.round(((to - from) * fps) / rate));
    const segment = {
      from,
      to,
      rate,
      hold: false,
      startFrame,
      frames,
      camera,
    };
    startFrame += frames;
    return segment;
  });
  return {
    segments,
    frames: startFrame,
    cameraMoveFrames: Math.round(
      (spec.cameraMove ?? DEFAULT_CAMERA_MOVE) * fps
    ),
  };
}

/** Recorded seconds a picked completion stays at real speed, to see what it inserted. */
const PICK_SETTLE = 0.35;

/**
 * Cuts over a stretch of typing with completions (lib/typing.ts): the typing
 * plays at `rate`, the wait for each completion list is cut out, and each
 * list from opening to just after its pick plays at real speed.
 */
export function typingCuts(
  from: At,
  completions: readonly { open: string; pick: string }[],
  to: At,
  camera: { rate: number; focus?: string | Box; maxZoom?: number }
): Cut[] {
  const { rate, ...framing } = camera;
  const cuts: Cut[] = [];
  let typingFrom = from;
  for (const { open, pick } of completions) {
    const settled = { beat: pick, offset: PICK_SETTLE };
    const wait = completionWaitLabels(open);
    cuts.push({ from: typingFrom, to: wait.typed, rate, ...framing });
    cuts.push({ from: wait.listed, to: settled, rate: 1, ...framing });
    typingFrom = settled;
  }
  cuts.push({ from: typingFrom, to, rate, ...framing });
  return cuts;
}

export interface Pane {
  spec: EditSpec;
  timeline: TimelineFile;
}

/**
 * Lays panes shown side by side out one after another: each pane plays its
 * own edit in turn and holds its first frame before its turn and its last
 * frame after. Returns the padded specs and the frames each pane is active.
 */
export function sequencePanes(
  panes: readonly Pane[],
  fps: number
): {
  specs: EditSpec[];
  active: { from: number; to: number }[];
  frames: number;
} {
  const lengths = panes.map(
    ({ spec, timeline }) => planEdit(spec, timeline, fps).frames
  );
  const frames = lengths.reduce((sum, length) => sum + length, 0);
  let from = 0;
  const active = lengths.map((length) => {
    const range = { from, to: from + length };
    from += length;
    return range;
  });
  const specs = panes.map(({ spec }, index): EditSpec => {
    const before = active[index].from;
    const after = frames - active[index].to;
    const first = spec.cuts[0];
    const last = spec.cuts[spec.cuts.length - 1];
    return {
      ...spec,
      cuts: [
        ...(before
          ? [{ ...framing(first), hold: "start", seconds: before / fps }]
          : []),
        ...spec.cuts,
        ...(after
          ? [{ ...framing(last), hold: "end", seconds: after / fps }]
          : []),
      ],
    };
  });
  return { specs, active, frames };
}

/** A cut's camera settings, so a padding hold frames what its neighbour does. */
function framing(cut: Cut): Pick<Cut, "focus" | "maxZoom"> {
  return {
    ...(cut.focus !== undefined ? { focus: cut.focus } : {}),
    ...(cut.maxZoom !== undefined ? { maxZoom: cut.maxZoom } : {}),
  };
}

export function segmentAt(plan: EditPlan, frame: number): Segment {
  return (
    plan.segments.find(
      (segment) => frame < segment.startFrame + segment.frames
    ) ?? plan.segments[plan.segments.length - 1]
  );
}

/** Recorded seconds shown at output `frame`. */
export function recordedTimeAt(
  plan: EditPlan,
  frame: number,
  fps: number
): number {
  const segment = segmentAt(plan, frame);
  if (segment.hold) return segment.from;
  return segment.from + ((frame - segment.startFrame) / fps) * segment.rate;
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

/**
 * The camera at output `frame`: each segment's framing, reached by an eased
 * move that starts as the segment does.
 */
export function cameraAt(plan: EditPlan, frame: number): Camera {
  const index = plan.segments.indexOf(segmentAt(plan, frame));
  const segment = plan.segments[index];
  const previous = plan.segments[index - 1]?.camera ?? segment.camera;
  const moveFrames = Math.min(plan.cameraMoveFrames, segment.frames);
  const progress =
    moveFrames > 0
      ? easeInOut(Math.min((frame - segment.startFrame) / moveFrames, 1))
      : 1;
  return {
    zoom: mix(previous.zoom, segment.camera.zoom, progress),
    cx: mix(previous.cx, segment.camera.cx, progress),
    cy: mix(previous.cy, segment.camera.cy, progress),
  };
}

export interface Pointer {
  x: number;
  y: number;
  opacity: number;
  /** 0..1 through a click's ripple, or undefined between clicks. */
  ripple?: number;
}

/** Recorded seconds the pointer takes to travel to its next beat. */
const POINTER_TRAVEL = 0.45;
/** The pointer shows this long before its first beat in a run of beats, and after its last. */
const POINTER_LEAD = 1.0;
const POINTER_LINGER = 1.6;
const POINTER_FADE = 0.25;
const RIPPLE = 0.4;

/**
 * Where the drawn pointer is at recorded time `t`. Headless Chromium draws no
 * cursor, so the edit draws one from the click and hover beats: it glides to
 * each beat's point, ripples on a click, and fades out when idle.
 */
export function pointerAt(
  timeline: TimelineFile,
  t: number
): Pointer | undefined {
  const beats = timeline.beats.filter((beat) => beat.point);
  if (!beats.length) return undefined;
  const nextIndex = beats.findIndex((beat) => beat.t > t);
  const last = beats[(nextIndex === -1 ? beats.length : nextIndex) - 1];
  const next = nextIndex === -1 ? undefined : beats[nextIndex];

  let position = (last ?? next!).point!;
  const travel = next?.travel ?? POINTER_TRAVEL;
  if (last && next && t > next.t - travel) {
    const amount = easeInOut((t - (next.t - travel)) / travel);
    position = {
      x: mix(last.point!.x, next.point!.x, amount),
      y: mix(last.point!.y, next.point!.y, amount),
    };
  }
  const sinceLast = last ? t - last.t : Number.POSITIVE_INFINITY;
  const untilNext = next ? next.t - t : Number.POSITIVE_INFINITY;
  const visibleFor = Math.max(
    POINTER_LINGER - sinceLast,
    POINTER_LEAD - untilNext
  );
  const opacity = Math.min(Math.max(visibleFor / POINTER_FADE, 0), 1);
  const ripple =
    last && last.kind === BEAT_KINDS.CLICK && sinceLast < RIPPLE
      ? sinceLast / RIPPLE
      : undefined;
  return { ...position, opacity, ...(ripple !== undefined ? { ripple } : {}) };
}
