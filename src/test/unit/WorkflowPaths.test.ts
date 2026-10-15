import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import { RUN_HISTORY_LOCATIONS } from "../../types/DashboardConstants";
import {
  initializeRunHistoryLocation,
  resetRunHistoryLocationForTests,
} from "../../utils/RunHistoryStoragePolicy";
import { projectStateRoot } from "../../utils/ProjectStatePaths";

suite("WorkflowPaths", () => {
  suite("assertValidWorkflowKey / assertValidRunRef", () => {
    test("accepts a well-formed workflowKey", () => {
      assert.doesNotThrow(() =>
        WorkflowPaths.assertValidWorkflowKey("my-workflow-2026-07-20T10-30-00")
      );
    });

    test("rejects traversal, separators, and dot segments", () => {
      for (const bad of ["..", ".", "a/b", "a\\b", "../escape", ""]) {
        assert.throws(() => WorkflowPaths.assertValidWorkflowKey(bad));
      }
    });

    test("rejects Windows-reserved device names", () => {
      for (const bad of ["con", "CON", "nul", "com1", "lpt9"]) {
        assert.throws(() => WorkflowPaths.assertValidWorkflowKey(bad));
      }
    });

    test("accepts a well-formed runRef and round-trips its timestamp", () => {
      const runRef = WorkflowPaths.formatRunRef(1_753_000_000_000);
      assert.doesNotThrow(() => WorkflowPaths.assertValidRunRef(runRef));
      assert.strictEqual(
        WorkflowPaths.parseRunRefTimestamp(runRef),
        1_753_000_000_000
      );
    });

    test("rejects a runRef with the wrong grammar", () => {
      for (const bad of ["run-not-a-timestamp", "runrun-2026", "run-"]) {
        assert.throws(() => WorkflowPaths.assertValidRunRef(bad));
      }
    });
  });

  suite("path construction and containment", () => {
    const workspaceRoot = path.join("C:", "dev", "some-workspace");
    const workflowKey = "my-workflow-2026-07-20T10-30-00" as WorkflowKey;
    const runRef = "run-2026-07-20T10-30-00-000Z" as RunRef;

    test("builds the expected layout paths", () => {
      const runsRoot = WorkflowPaths.runsRoot(workspaceRoot);
      assert.strictEqual(
        WorkflowPaths.lineageDir(workspaceRoot, workflowKey),
        path.join(runsRoot, workflowKey)
      );
      assert.strictEqual(
        WorkflowPaths.descriptorPath(workspaceRoot, workflowKey),
        path.join(runsRoot, workflowKey, "workflow.json")
      );
      assert.strictEqual(
        WorkflowPaths.draftFilePath(workspaceRoot, workflowKey),
        path.join(runsRoot, workflowKey, "draft", "workflow.ctrlyoke.json")
      );
      assert.strictEqual(
        WorkflowPaths.runFilePath(workspaceRoot, workflowKey, runRef),
        path.join(runsRoot, workflowKey, runRef, "workflow.ctrlyoke.json")
      );
      assert.strictEqual(
        WorkflowPaths.manifestPath(workspaceRoot, workflowKey, runRef),
        path.join(runsRoot, workflowKey, runRef, "manifest.json")
      );
      assert.strictEqual(
        WorkflowPaths.eventsPath(workspaceRoot, workflowKey, runRef),
        path.join(runsRoot, workflowKey, runRef, "events.jsonl")
      );
      assert.strictEqual(
        WorkflowPaths.runnerLockPath(workspaceRoot, workflowKey),
        path.join(runsRoot, workflowKey, "runner.json")
      );
    });

    test("rejects a workflowKey that would escape the runs root", () => {
      assert.throws(() =>
        WorkflowPaths.lineageDir(workspaceRoot, "../../escape" as WorkflowKey)
      );
    });
  });

  suite("runArtifactStem", () => {
    const workspaceRoot = path.join("C:", "dev", "some-workspace");
    const workflowKey = "my-workflow-2026-07-20T10-30-00" as WorkflowKey;
    const firstRun = "run-2026-07-20T10-30-00-000Z" as RunRef;
    const secondRun = "run-2026-07-20T10-31-00-000Z" as RunRef;

    test("distinguishes run files and the draft working file", () => {
      const first = WorkflowPaths.runArtifactStem(
        WorkflowPaths.runFilePath(workspaceRoot, workflowKey, firstRun)
      );
      const second = WorkflowPaths.runArtifactStem(
        WorkflowPaths.runFilePath(workspaceRoot, workflowKey, secondRun)
      );
      const draft = WorkflowPaths.runArtifactStem(
        WorkflowPaths.draftFilePath(workspaceRoot, workflowKey)
      );

      assert.strictEqual(first, `${workflowKey}-${firstRun}`);
      assert.strictEqual(second, `${workflowKey}-${secondRun}`);
      assert.strictEqual(draft, `${workflowKey}-draft`);
      assert.strictEqual(new Set([first, second, draft]).size, 3);
    });

    test("returns a stable safe stem for nonstandard working-file paths", () => {
      const first = WorkflowPaths.runArtifactStem(
        path.join(workspaceRoot, "workflow.ctrlyoke.json")
      );
      assert.strictEqual(
        first,
        WorkflowPaths.runArtifactStem(
          path.join(workspaceRoot, ".", "workflow.ctrlyoke.json")
        )
      );
      assert.match(first, /^[a-f0-9]{16}$/);
    });
  });

  suite("parseRunFilePath / parseRunArtifactPath", () => {
    const workspaceRoot = path.join("C:", "dev", "some-workspace");
    const workflowKey = "my-workflow-2026-07-20T10-30-00" as WorkflowKey;
    const runRef = "run-2026-07-20T10-30-00-000Z" as RunRef;

    test("round-trips a run definition file path", () => {
      const filePath = WorkflowPaths.runFilePath(
        workspaceRoot,
        workflowKey,
        runRef
      );
      const parsed = WorkflowPaths.parseRunFilePath(workspaceRoot, filePath);
      assert.deepStrictEqual(parsed, { workflowKey, runRef });
    });

    test("round-trips a run artifact (manifest) path", () => {
      const filePath = WorkflowPaths.manifestPath(
        workspaceRoot,
        workflowKey,
        runRef
      );
      const parsed = WorkflowPaths.parseRunArtifactPath(
        workspaceRoot,
        filePath
      );
      assert.deepStrictEqual(parsed, {
        workflowKey,
        runRef,
        fileName: "manifest.json",
      });
    });

    test("returns undefined for a draft file path (not parseRunFilePath's shape)", () => {
      const filePath = WorkflowPaths.draftFilePath(workspaceRoot, workflowKey);
      assert.strictEqual(
        WorkflowPaths.parseRunFilePath(workspaceRoot, filePath),
        undefined
      );
    });

    test("returns undefined for a path outside the runs root", () => {
      const outside = path.join(workspaceRoot, "somewhere-else", "file.json");
      assert.strictEqual(
        WorkflowPaths.parseRunFilePath(workspaceRoot, outside),
        undefined
      );
      assert.strictEqual(
        WorkflowPaths.parseRunArtifactPath(workspaceRoot, outside),
        undefined
      );
    });

    test("returns undefined for a symlink-style traversal attempt", () => {
      const traversal = path.join(
        workspaceRoot,
        ".ctrlyoke",
        ".runs",
        "..",
        "..",
        "outside.json"
      );
      assert.strictEqual(
        WorkflowPaths.parseRunArtifactPath(workspaceRoot, traversal),
        undefined
      );
    });
  });

  suite("allocateWorkflowKey", () => {
    let workspaceRoot: string;

    setup(async () => {
      workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-workflow-paths-")
      );
    });

    teardown(async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    });

    test("mints a slugified key and exclusively creates its lineage directory", async () => {
      const key = await WorkflowPaths.allocateWorkflowKey(
        workspaceRoot,
        "My Cool Workflow.ctrlyoke.json"
      );
      assert.match(key, /^my-cool-workflow-\d{4}-\d{2}-\d{2}T[\d-]+$/);
      const stat = await fs.stat(WorkflowPaths.lineageDir(workspaceRoot, key));
      assert.ok(stat.isDirectory());
    });

    test("retries with an advancing timestamp on collision", async () => {
      const fixedNow = () => 1_753_000_000_000;
      const first = await WorkflowPaths.allocateWorkflowKey(
        workspaceRoot,
        "same-name",
        fixedNow
      );
      const second = await WorkflowPaths.allocateWorkflowKey(
        workspaceRoot,
        "same-name",
        fixedNow
      );
      assert.notStrictEqual(first, second);
      const firstStat = await fs.stat(
        WorkflowPaths.lineageDir(workspaceRoot, first)
      );
      const secondStat = await fs.stat(
        WorkflowPaths.lineageDir(workspaceRoot, second)
      );
      assert.ok(firstStat.isDirectory());
      assert.ok(secondStat.isDirectory());
    });
  });

  suite("run-history location", () => {
    const stateRoot = path.join("C:", "dev", "some-workspace");

    setup(() => {
      resetRunHistoryLocationForTests();
    });

    teardown(() => {
      resetRunHistoryLocationForTests();
      initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
    });

    test("uses the project directory in user mode", () => {
      initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
      assert.strictEqual(
        WorkflowPaths.runsRoot(stateRoot),
        path.join(
          projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.USER),
          ".runs"
        )
      );
    });

    test("preserves today's workspace layout in workspace mode", () => {
      initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.WORKSPACE);
      assert.strictEqual(
        WorkflowPaths.runsRoot(stateRoot),
        path.join(stateRoot, ".ctrlyoke", ".runs")
      );
    });
  });
});
