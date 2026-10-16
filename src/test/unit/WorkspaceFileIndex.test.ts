import * as assert from "assert";
import * as path from "path";
import { suite, test } from "mocha";
import {
  WorkspaceFileIndex,
  type WorkspaceFileIndexDependencies,
  type WorkspaceFileIndexRoot,
} from "../../completions/WorkspaceFileIndex";
import type { SearchWalkResult } from "../../utils/WorkspaceSearchFileWalker";
import {
  WORKSPACE_FILE_CHANGE_KINDS,
  WORKSPACE_FILE_INDEX_STATES,
} from "../../types/DashboardConstants";

interface FakeTimer { callback: () => void; delay: number; }

function makeHarness(overrides: Partial<WorkspaceFileIndexDependencies> = {}) {
  let now = 1_000;
  const timers: FakeTimer[] = [];
  const roots: WorkspaceFileIndexRoot[] = [{ path: "/workspace", name: "workspace" }];
  const calls: string[] = [];
  const dependencies: WorkspaceFileIndexDependencies = {
    getGitTrackedFiles: async () => ["src/tracked file.ts"],
    getGitIgnoredPaths: async (_root, files) => new Set(files.filter((file) => file.includes("ignored"))),
    walkSearchFiles: async (root, _startedAt, maxFiles, maxDurationMs, skip) => {
      calls.push(`walk:${root}:${maxFiles}:${maxDurationMs}:${[...skip].join(",")}`);
      return { files: ["deep/ignored-target.ts"], truncated: false };
    },
    stat: async () => ({ isFile: () => true, isDirectory: () => false }),
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      const index = timers.indexOf(timer as unknown as FakeTimer);
      if (index >= 0) timers.splice(index, 1);
    },
    ...overrides,
  };
  return {
    roots,
    calls,
    dependencies,
    timers,
    advance(ms: number) { now += ms; },
    async flushTimers() {
      const queued = timers.splice(0);
      for (const timer of queued) timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const root = "/workspace";

suite("WorkspaceFileIndex", () => {
  test("makes Git paths queryable before an uncapped walk adds deep ignored files", async () => {
    let releaseWalk!: (result: SearchWalkResult) => void;
    const files = Array.from({ length: 100_001 }, (_, index) => `bulk/file-${index}.ts`);
    files.push("very/deep/ignored-target.ts");
    const harness = makeHarness({
      walkSearchFiles: async () => new Promise((resolve) => { releaseWalk = resolve; }),
    });
    const index = new WorkspaceFileIndex(harness.roots, false, harness.dependencies);
    await index.build();
    assert.deepStrictEqual((await index.queryFiles("tracked file")).map((item) => item.relativePath), ["src/tracked file.ts"]);
    assert.ok(harness.calls.length === 0);
    releaseWalk({ files, truncated: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok((await index.queryFiles("ignored target")).some((item) => item.relativePath === "very/deep/ignored-target.ts"));
    assert.equal(index.getStatus().state, "ready");
    index.dispose();
  });

  test("uses infinite walk bounds, respects multi-root prefixes, and has a Git fallback", async () => {
    const harness = makeHarness({
      walkSearchFiles: async (_path, _time, maxFiles, maxDuration) => {
        assert.equal(maxFiles, Number.POSITIVE_INFINITY);
        assert.equal(maxDuration, Number.POSITIVE_INFINITY);
        return { files: ["sub/deep-target.ts"], truncated: false };
      },
    });
    const multi = new WorkspaceFileIndex([
      { path: root, name: "first" },
      { path: "/second", name: "second" },
    ], false, harness.dependencies);
    await multi.build();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok((await multi.queryFiles("second deep target")).some((item) => item.relativePath === "second/sub/deep-target.ts"));
    multi.dispose();

    const fallbackHarness = makeHarness({ getGitTrackedFiles: async () => { throw new Error("git unavailable"); } });
    const fallback = new WorkspaceFileIndex(fallbackHarness.roots, true, fallbackHarness.dependencies);
    await fallback.build();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fallback.getStatus().state, "degraded");
    assert.ok((await fallback.queryFiles("ignored target")).length > 0);
    fallback.dispose();
  });

  test("batches create, delete, and directory-create changes without rebuilding", async () => {
    let rebuilds = 0;
    const harness = makeHarness({
      getGitTrackedFiles: async () => { rebuilds++; return ["src/original.ts"]; },
      stat: async (file) => ({ isFile: () => !/[\\/]new-dir$/.test(file), isDirectory: () => /[\\/]new-dir$/.test(file) }),
      walkSearchFiles: async () => ({ files: ["nested.ts"], truncated: false }),
    });
    const index = new WorkspaceFileIndex(harness.roots, false, harness.dependencies);
    await index.build();
    await new Promise((resolve) => setImmediate(resolve));
    await index.applyChanges([
      { root, path: "src/created.ts", kind: WORKSPACE_FILE_CHANGE_KINDS.CREATE },
      { root, path: "src/original.ts", kind: WORKSPACE_FILE_CHANGE_KINDS.DELETE },
      { root, path: "new-dir", kind: WORKSPACE_FILE_CHANGE_KINDS.CREATE },
    ]);
    assert.equal(harness.timers[0].delay, 200);
    await harness.flushTimers();
    const files = (await index.queryFiles("")).map((item) => item.relativePath);
    assert.ok(files.includes("src/created.ts"));
    assert.ok(!files.includes("src/original.ts"));
    assert.ok(files.includes("new-dir/nested.ts"));
    assert.equal(rebuilds, 1);
    index.dispose();
  });

  test("drops ignored creates and rebuilds on ignore changes and stale queries", async () => {
    let gitCalls = 0;
    const harness = makeHarness({
      getGitTrackedFiles: async () => { gitCalls++; return ["kept.ts"]; },
      getGitIgnoredPaths: async (_root, files) => new Set(files.filter((file) => file.includes("ignored"))),
      stat: async () => ({ isFile: () => true, isDirectory: () => false }),
      walkSearchFiles: async () => ({ files: [], truncated: false }),
    });
    const index = new WorkspaceFileIndex(harness.roots, true, harness.dependencies);
    await index.build();
    await index.applyChanges([{ root, path: "new-ignored.ts", kind: WORKSPACE_FILE_CHANGE_KINDS.CREATE }]);
    await harness.flushTimers();
    assert.ok(!(await index.queryFiles("new ignored")).length);
    await index.applyChanges([{ root, path: ".gitignore", kind: WORKSPACE_FILE_CHANGE_KINDS.CHANGE }]);
    await harness.flushTimers();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(gitCalls >= 2);
    harness.advance(5 * 60_000 + 1);
    await index.queryFiles("kept");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(gitCalls >= 3);
    index.dispose();
  });

  test("keeps the active store available until a rebuild is complete", async () => {
    let releaseSecond!: (result: SearchWalkResult) => void;
    let walks = 0;
    let walkCalls = 0;
    const harness = makeHarness({
      getGitTrackedFiles: async () => [walks++ === 0 ? "old.ts" : "new.ts"],
      walkSearchFiles: async () => {
        if (++walkCalls === 2) return new Promise((resolve) => { releaseSecond = resolve; });
        return { files: [], truncated: false };
      },
    });
    const index = new WorkspaceFileIndex(harness.roots, false, harness.dependencies);
    await index.build();
    await new Promise((resolve) => setImmediate(resolve));
    const previous = (await index.queryFiles("old")).map((item) => item.relativePath);
    await index.build();
    assert.deepStrictEqual((await index.queryFiles("old")).map((item) => item.relativePath), previous);
    releaseSecond({ files: [], truncated: false });
    for (let attempt = 0; attempt < 20 && index.getStatus().state !== WORKSPACE_FILE_INDEX_STATES.READY; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok((await index.queryFiles("new")).length);
    await index.build({ roots: [
      { path: "/replacement", name: "replacement" },
      { path: "/other", name: "other" },
    ] });
    let replacementReady = false;
    for (let attempt = 0; attempt < 20 && !replacementReady; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
      replacementReady = index.getStatus().state === WORKSPACE_FILE_INDEX_STATES.READY &&
        (await index.queryFiles("replacement/new")).some((item) => item.relativePath === "replacement/new.ts");
    }
    assert.ok(replacementReady, `replacement build did not finish; status=${JSON.stringify(index.getStatus())}`);
    index.dispose();
  });

  test("real worker starts on the first query and cancellation stops a scan", async function () {
    const workspaceRoot = path.resolve(__dirname, "../../..");
    const index = new WorkspaceFileIndex([{ path: workspaceRoot, name: "repo" }], false);
    try {
      const files = await index.queryFiles("package");
      assert.ok(files.some((entry) => entry.relativePath === "package.json"));
      const controller = new AbortController();
      const scan = index.queryFiles("a", { limit: 200_000, signal: controller.signal });
      controller.abort();
      const partial = await scan;
      assert.ok(partial.length < index.getStatus().indexed, "cancel should stop the worker before the full scan completes");
    } finally { index.dispose(); }
  });

  test("falls back to Git-visible paths after real worker OOM and warns once", async function () {
    const workspaceRoot = path.resolve(__dirname, "../../..");
    const feedback: string[] = [];
    const index = new WorkspaceFileIndex([{ path: workspaceRoot, name: "repo" }], false, undefined, {
      workerHeapMb: 8,
      userFeedbackSink: { notify: (message) => feedback.push(message.message) },
    });
    try {
      try { await index.build(); } catch { /* worker startup can fail before fallback is ready */ }
      for (let attempt = 0; attempt < 100 && index.getStatus().state !== WORKSPACE_FILE_INDEX_STATES.DEGRADED; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(index.getStatus().state, WORKSPACE_FILE_INDEX_STATES.DEGRADED);
      assert.ok((await index.queryFiles("package")).some((entry) => entry.relativePath === "package.json"));
      assert.deepStrictEqual(feedback, ["Workspace file index stopped at its 2 GB memory limit; ignored files may be missing from @ completions."]);
    } finally { index.dispose(); }
  });
});
