import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_CATEGORIES,
  summarizeProfile,
} from "./profile-extension-host.mjs";

const frame = (functionName, category) => ({ functionName, category });

// Synthetic resolver: the call frame already carries its resolved category.
const resolveFrame = (callFrame) => ({
  key: callFrame.functionName,
  label: callFrame.functionName,
  category: callFrame.category,
});

/**
 * root ─┬─ (idle)
 *       └─ loadHistory ─── readRuns ─── JSON.parse (dependency)
 */
const profile = {
  startTime: 0,
  endTime: 1_000_000,
  nodes: [
    {
      id: 1,
      callFrame: frame("(root)", FRAME_CATEGORIES.program),
      children: [2, 3],
    },
    { id: 2, callFrame: frame("(idle)", FRAME_CATEGORIES.idle) },
    {
      id: 3,
      callFrame: frame("loadHistory", FRAME_CATEGORIES.ctrlyoke),
      children: [4],
    },
    {
      id: 4,
      callFrame: frame("readRuns", FRAME_CATEGORIES.ctrlyoke),
      children: [5],
    },
    { id: 5, callFrame: frame("parse", FRAME_CATEGORIES.dependency) },
  ],
  // 100ms idle, then 300ms busy in parse, 100ms readRuns self, 500ms idle.
  samples: [2, 5, 5, 5, 4, 2, 2, 2, 2, 2],
  timeDeltas: Array(10).fill(100_000),
};

test("attributes a busy stretch to its heaviest ctrlyoke frames", () => {
  const summary = summarizeProfile(profile, resolveFrame, { minStallMs: 200 });

  assert.equal(summary.stalls.length, 1);
  assert.equal(summary.stalls[0].durationMs, 400);
  assert.equal(summary.stalls[0].startMs, 200);
  assert.deepEqual(
    summary.stalls[0].heaviest.map(({ label, ms }) => [label, ms]),
    [
      ["readRuns", 400],
      ["loadHistory", 400],
    ]
  );
});

test("ranks self time without idle frames and totals by category", () => {
  const summary = summarizeProfile(profile, resolveFrame);

  assert.deepEqual(
    summary.topSelf.map(({ label, ms }) => [label, ms]),
    [
      ["parse", 300],
      ["readRuns", 100],
    ]
  );
  const byName = Object.fromEntries(
    summary.categories.map((c) => [c.name, c.ms])
  );
  assert.equal(byName[FRAME_CATEGORIES.dependency], 300);
  assert.equal(byName[FRAME_CATEGORIES.ctrlyoke], 100);
  // The last sample has no following delta, so it contributes no time.
  assert.equal(byName[FRAME_CATEGORIES.idle], 500);
});

test("drops busy stretches shorter than the threshold", () => {
  const summary = summarizeProfile(profile, resolveFrame, { minStallMs: 500 });
  assert.equal(summary.stalls.length, 0);
});
