// Run with `npm test` in media/ (node:test under Node's type stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimelineFile } from "../lib/timeline.ts";
import {
  cameraAt,
  frameBox,
  planEdit,
  pointerAt,
  recordedTimeAt,
  resolveAt,
  sequencePanes,
  typingCuts,
} from "./edit.ts";

const FPS = 30;
const VIEWPORT = { width: 1000, height: 500 };

const timeline: TimelineFile = {
  video: "raw.mp4",
  viewport: VIEWPORT,
  scale: 2,
  fps: FPS,
  duration: 60,
  beats: [
    {
      t: 2,
      kind: "click",
      label: "run",
      box: { x: 900, y: 10, w: 40, h: 20 },
      point: { x: 920, y: 20 },
    },
    {
      t: 10,
      kind: "focus",
      label: "output",
      box: { x: 100, y: 50, w: 400, h: 200 },
    },
    { t: 40, kind: "mark", label: "done" },
    {
      t: 50,
      kind: "hover",
      label: "marker",
      box: { x: 980, y: 300, w: 10, h: 10 },
      point: { x: 985, y: 305 },
    },
  ],
};

test("resolves beats, offsets and the ends of the take", () => {
  assert.equal(resolveAt("start", timeline), 0);
  assert.equal(resolveAt("end", timeline), 60);
  assert.equal(resolveAt("done", timeline), 40);
  assert.equal(resolveAt({ beat: "done", offset: 2.5 }, timeline), 42.5);
  assert.equal(resolveAt({ beat: "done", offset: 99 }, timeline), 60);
  assert.throws(() => resolveAt("missing", timeline), /no beat 'missing'/);
});

test("lays cuts end to end, sped up by their rate", () => {
  const plan = planEdit(
    {
      cuts: [
        { from: "start", to: "run", rate: 1 },
        { from: "run", to: "done", rate: 4 },
        { hold: "end", seconds: 1 },
      ],
    },
    timeline,
    FPS
  );
  assert.deepEqual(
    plan.segments.map((segment) => [segment.startFrame, segment.frames]),
    [
      [0, 60],
      [60, 285],
      [345, 30],
    ]
  );
  assert.equal(plan.frames, 375);
  // Half-way through the 4x cut shows recorded 2 + 19 s.
  assert.equal(recordedTimeAt(plan, 60 + 142.5, FPS), 21);
  assert.equal(recordedTimeAt(plan, 360, FPS), 60);
});

test("rejects a cut that runs backwards", () => {
  assert.throws(
    () => planEdit({ cuts: [{ from: "done", to: "run" }] }, timeline, FPS),
    /forward/
  );
});

test("frames a box with a margin, inside the frame and within the zoom cap", () => {
  const camera = frameBox({ x: 100, y: 50, w: 400, h: 200 }, VIEWPORT);
  assert.equal(camera.zoom, 1.8);
  assert.equal(camera.cx, 300);
  assert.equal(camera.cy, 150);
  // A box at the edge is framed with the frame's edge, not past it.
  const edge = frameBox({ x: 980, y: 0, w: 20, h: 20 }, VIEWPORT, 2);
  assert.equal(edge.cx, 1000 - 1000 / 2 / 2);
  assert.equal(edge.cy, 500 / 2 / 2);
  assert.deepEqual(frameBox(undefined, VIEWPORT), {
    zoom: 1,
    cx: 500,
    cy: 250,
  });
});

test("eases the camera from the previous cut's framing", () => {
  const plan = planEdit(
    {
      cuts: [
        { from: "start", to: "run" },
        { from: "run", to: "done", focus: "output", maxZoom: 1.5 },
      ],
      cameraMove: 1,
    },
    timeline,
    FPS
  );
  assert.equal(cameraAt(plan, 59).zoom, 1);
  assert.equal(cameraAt(plan, 60).zoom, 1);
  assert.equal(cameraAt(plan, 75).zoom, 1.25);
  assert.equal(cameraAt(plan, 90).zoom, 1.5);
});

test("draws the pointer gliding between beats and fading when idle", () => {
  assert.deepEqual(pointerAt(timeline, 2), {
    x: 920,
    y: 20,
    opacity: 1,
    ripple: 0,
  });
  assert.ok(Math.abs((pointerAt(timeline, 2.2)?.ripple ?? 0) - 0.5) < 1e-9);
  assert.equal(pointerAt(timeline, 20)?.opacity, 0);
  const gliding = pointerAt(timeline, 50 - 0.45 / 2);
  assert.ok(gliding && gliding.x > 920 && gliding.x < 985);
  assert.equal(gliding?.opacity, 1);
});

test("crops to a frame narrower than the page, never past its edges", () => {
  const frame = { width: 400, height: 500 };
  // No box: the least zoom that fills the frame, centred on the page.
  assert.deepEqual(frameBox(undefined, VIEWPORT, 1.8, frame), {
    zoom: 1,
    cx: 500,
    cy: 250,
  });
  // A box at the right edge: the frame's right edge meets the page's.
  const right = frameBox(
    { x: 700, y: 0, w: 300, h: 500 },
    VIEWPORT,
    1.8,
    frame
  );
  assert.equal(right.zoom, 1);
  assert.equal(right.cx, 1000 - 200);
});

test("plays side-by-side panes in turn, holding the others", () => {
  const short = { cuts: [{ from: "start", to: "run" }] };
  const { specs, active, frames } = sequencePanes(
    [
      { spec: short, timeline },
      { spec: { cuts: [{ from: "run", to: "done", rate: 2 }] }, timeline },
    ],
    FPS
  );
  assert.deepEqual(active, [
    { from: 0, to: 60 },
    { from: 60, to: 630 },
  ]);
  assert.equal(frames, 630);
  // Each padded edit lasts the whole side-by-side.
  for (const spec of specs) {
    assert.equal(planEdit(spec, timeline, FPS).frames, frames);
  }
  assert.deepEqual(specs[1].cuts[0], { hold: "start", seconds: 2 });
});

test("plays typing fast and each completion list at real speed", () => {
  const cuts = typingCuts("start", [{ open: "run", pick: "output" }], "done", {
    rate: 2,
  });
  assert.deepEqual(cuts, [
    { from: "start", to: "run:typed", rate: 2 },
    { from: "run:listed", to: { beat: "output", offset: 0.35 }, rate: 1 },
    { from: { beat: "output", offset: 0.35 }, to: "done", rate: 2 },
  ]);
});

test("glides the pointer over a drag's own travel time", () => {
  const drag: TimelineFile = {
    ...timeline,
    beats: [
      { t: 1, kind: "click", label: "grab", point: { x: 0, y: 0 } },
      {
        t: 3,
        kind: "hover",
        label: "drop",
        point: { x: 100, y: 0 },
        travel: 2,
      },
    ],
  };
  assert.equal(pointerAt(drag, 2)?.x, 50);
});
