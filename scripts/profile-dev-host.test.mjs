import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  FRAME_CATEGORIES,
  PROFILE_TARGETS,
  localOutFileForUrl,
  summarizeHeapProfile,
  summarizeProfile,
} from "./profile-dev-host.mjs";

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

test("maps extension-host and webview script URLs to the same out/ tree", () => {
  const outDir = path.join("C:", "dev", "ctrlyoke", "out");
  assert.equal(
    localOutFileForUrl("file:///c:/dev/ctrlyoke/out/extension.js", outDir),
    path.join(outDir, "extension.js")
  );
  assert.equal(
    localOutFileForUrl(
      "https://file+.vscode-resource.vscode-cdn.net/c%3A/dev/ctrlyoke/out/ui/webview-react/assets/dashboard.js?v=1",
      outDir
    ),
    path.join(outDir, "ui", "webview-react", "assets", "dashboard.js")
  );
  assert.equal(
    localOutFileForUrl("file:///c:/other/out/extension.js", outDir),
    undefined
  );
});

test("attributes allocations to their function and its ctrlyoke callers", () => {
  const node = (functionName, category, selfSize, children = []) => ({
    callFrame: frame(functionName, category),
    selfSize,
    children,
  });
  const summary = summarizeHeapProfile(
    {
      head: node("(root)", FRAME_CATEGORIES.program, 0, [
        node("buildRows", FRAME_CATEGORIES.ctrlyoke, 1_000, [
          node("structuredClone", FRAME_CATEGORIES.other, 9_000),
        ]),
        node("(garbage collector)", FRAME_CATEGORIES.gc, 500),
      ]),
    },
    resolveFrame
  );

  assert.equal(summary.totalBytes, 10_500);
  assert.deepEqual(
    summary.topSelf.map(({ label, bytes }) => [label, bytes]),
    [
      ["structuredClone", 9_000],
      ["buildRows", 1_000],
    ]
  );
  assert.deepEqual(
    summary.topCtrlyokeTotal.map(({ label, bytes }) => [label, bytes]),
    [["buildRows", 10_000]]
  );
});

test("attaches to the dashboard view rather than another ctrlyoke webview", () => {
  const webview = (purpose, extensionId = "fuzzynova.ctrlyoke") => ({
    type: "iframe",
    webSocketDebuggerUrl: `ws://${purpose}`,
    url: `vscode-webview://x/index.html?extensionId=${extensionId}&purpose=${purpose}`,
  });

  const picked = PROFILE_TARGETS.dashboard.pick([
    { type: "page", url: "vscode-file://vscode-app/workbench.html" },
    webview("webviewView", "other.extension"),
    webview("webviewEditor"),
    webview("webviewView"),
  ]);

  assert.equal(picked.webSocketDebuggerUrl, "ws://webviewView");
});
