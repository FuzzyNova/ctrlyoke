/**
 * RunBundleExporter — the secrets half of export redaction.
 *
 * A run's own redactor is gone once it finishes, so export re-resolves the
 * secrets the definition grants and removes their current values (and their
 * JSON-escaped form, which harnesses print when they echo a config). The
 * path and heuristic halves are covered end to end in
 * `runReplay.integration.test.ts`.
 */
import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import {
  exportRunBundle,
  resolveRunBundleSecrets,
} from "../../core/orchestration/RunBundleExporter";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import type { PromptFile, WorkingFile } from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  WORKTREE_MODES,
} from "../../types/DashboardConstants";
import { RUN_BUNDLE_FILES } from "../../types/RunBundleTypes";
import { readRunBundle } from "../../core/orchestration/RunBundleReader";
import { execGit } from "../../utils/GitUtils";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

let root: string;
let workspace: string;

suite("RunBundleExporter secrets", () => {
  setup(async () => {
    root = makeTempDir("ctrlyoke-run-export-");
    workspace = path.join(root, "repo");
    await fs.mkdir(workspace, { recursive: true });
    await execGit(["init"], { cwd: workspace });
    await execGit(["config", "user.email", "test@example.com"], {
      cwd: workspace,
    });
    await execGit(["config", "user.name", "Test"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "base.txt"), "base\n");
    await execGit(["add", "base.txt"], { cwd: workspace });
    await execGit(["commit", "-m", "base"], { cwd: workspace });
  });

  teardown(async () => removeTempDir(root));

  const definition = {
    secrets: ["DEMO_TOKEN"],
    steps: [{ prompt: "uses !STEP_ONLY_TOKEN" }, { prompt: "plain" }],
  } as unknown as PromptFile;

  test("resolves every granted secret, including inline grants", async () => {
    const values = await resolveRunBundleSecrets(definition, {
      workspaceRoot: process.cwd(),
      environment: { DEMO_TOKEN: 'abc"quoted', STEP_ONLY_TOKEN: "step-secret" },
    });
    assert.ok(values.includes('abc"quoted'));
    assert.ok(values.includes('abc\\"quoted'), "the JSON-escaped spelling too");
    assert.ok(values.includes("step-secret"));
  });

  test("skips a granted secret with no value on this machine", async () => {
    const values = await resolveRunBundleSecrets(definition, {
      workspaceRoot: process.cwd(),
      environment: { DEMO_TOKEN: "only-this-one" },
    });
    assert.deepStrictEqual(values, ["only-this-one"]);
  });

  test("exports continuation state and an untracked patch without touching the real index", async () => {
    const { workflowKey, runRef } = await createRun({
      state: EXECUTION_STATES.STOPPED,
      currentIndex: 1,
      steps: [
        { prompt: "done" },
        { prompt: "next sk-test0123456789abcdefghij" },
      ],
    });
    await fs.writeFile(path.join(workspace, "base.txt"), "staged\n");
    await execGit(["add", "base.txt"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "base.txt"), "working tree\n");
    await fs.writeFile(path.join(workspace, "untracked.txt"), "new file\n");
    const before = (
      await execGit(["status", "--porcelain"], { cwd: workspace })
    ).stdout;
    const indexPath = path.resolve(
      workspace,
      (
        await execGit(["rev-parse", "--git-path", "index"], {
          cwd: workspace,
        })
      ).stdout.trim()
    );
    const indexBefore = await fs.readFile(indexPath);
    const exported = await exportRunBundle({
      stateRoot: workspace,
      workspaceRoot: workspace,
      workflowKey,
      runRef,
      bundleDir: path.join(root, "continuable.ctrlyokerun"),
      exportedByVersion: "test",
      secrets: { workspaceRoot: workspace, environment: {} },
    });
    const after = (await execGit(["status", "--porcelain"], { cwd: workspace }))
      .stdout;
    const indexAfter = await fs.readFile(indexPath);
    assert.strictEqual(
      after,
      before,
      "the user's real index and status are unchanged"
    );
    assert.deepStrictEqual(indexAfter, indexBefore);
    assert.strictEqual(exported.continuable, true);
    assert.deepStrictEqual(exported.continuation?.nextStep, {
      kind: "queue",
      stepIndex: 1,
    });
    assert.strictEqual(exported.continuation?.pendingStepCount, 1);
    assert.strictEqual(exported.continuation?.workspace.patch?.files, 2);
    assert.ok(exported.changedFiles.includes("untracked.txt"));
    assert.ok(exported.manifest.redaction.byFile?.[RUN_BUNDLE_FILES.RUNTIME]);
    const runtime = await fs.readFile(
      path.join(exported.bundleDir, RUN_BUNDLE_FILES.RUNTIME),
      "utf8"
    );
    assert.ok(!runtime.includes("sk-test0123456789abcdefghij"));
    const patch = await fs.readFile(
      path.join(exported.bundleDir, RUN_BUNDLE_FILES.CHANGES),
      "utf8"
    );
    assert.ok(patch.includes("untracked.txt"));
    assert.strictEqual(
      exported.continuation?.workspace.patch?.sha256,
      crypto.createHash("sha256").update(patch).digest("hex")
    );
    const loaded = await readRunBundle(exported.bundleDir, workspace);
    assert.ok(loaded.runtime);
    await fs.appendFile(
      path.join(exported.bundleDir, RUN_BUNDLE_FILES.CHANGES),
      "tamper"
    );
    await assert.rejects(
      readRunBundle(exported.bundleDir, workspace),
      /failed its SHA-256 check/
    );
  });

  test("completed runs remain history only and --no-changes omits the patch", async () => {
    const completed = await createRun({
      state: EXECUTION_STATES.COMPLETED,
      currentIndex: 1,
      steps: [{ prompt: "done" }],
    });
    const history = await exportRunBundle({
      stateRoot: workspace,
      workspaceRoot: workspace,
      ...completed,
      bundleDir: path.join(root, "history.ctrlyokerun"),
      exportedByVersion: "test",
    });
    assert.strictEqual(history.continuable, false);
    assert.ok(!history.manifest.continuation);

    const stopped = await createRun({
      state: EXECUTION_STATES.STOPPED,
      currentIndex: 0,
      steps: [{ prompt: "next" }],
    });
    const noChanges = await exportRunBundle({
      stateRoot: workspace,
      workspaceRoot: workspace,
      ...stopped,
      bundleDir: path.join(root, "no-changes.ctrlyokerun"),
      exportedByVersion: "test",
      includeChanges: false,
    });
    assert.ok(noChanges.continuable);
    assert.ok(!noChanges.continuation?.workspace.patch);
    await assert.rejects(
      fs.stat(path.join(noChanges.bundleDir, RUN_BUNDLE_FILES.CHANGES))
    );
    const loaded = await readRunBundle(noChanges.bundleDir, workspace);
    assert.ok(loaded.runtime);
  });

  test("refuses pending rewinds and records managed worktree base commits", async () => {
    const pending = await createRun({
      state: EXECUTION_STATES.STOPPED,
      currentIndex: 0,
      steps: [{ prompt: "next" }],
      pendingRewind: true,
    });
    await assert.rejects(
      exportRunBundle({
        stateRoot: workspace,
        workspaceRoot: workspace,
        ...pending,
        bundleDir: path.join(root, "refused.ctrlyokerun"),
        exportedByVersion: "test",
      }),
      /commit or discard the rewind first/i
    );

    for (const state of [
      EXECUTION_STATES.PAUSING,
      EXECUTION_STATES.CANCELLING,
    ]) {
      const transient = await createRun({
        state,
        currentIndex: 0,
        steps: [{ prompt: "not settled" }],
      });
      await assert.rejects(
        exportRunBundle({
          stateRoot: workspace,
          workspaceRoot: workspace,
          ...transient,
          bundleDir: path.join(root, `${state}.ctrlyokerun`),
          exportedByVersion: "test",
        }),
        new RegExp(state)
      );
    }

    const baseCommit = (
      await execGit(["rev-parse", "HEAD"], { cwd: workspace })
    ).stdout.trim();
    const worktree = await createRun({
      state: EXECUTION_STATES.PAUSED,
      currentIndex: 0,
      steps: [{ prompt: "next" }],
      worktree: {
        mode: WORKTREE_MODES.MANAGED,
        baseCommit,
        branchName: "feature-branch",
        executionRoot: workspace,
      },
    });
    const exported = await exportRunBundle({
      stateRoot: workspace,
      workspaceRoot: workspace,
      ...worktree,
      bundleDir: path.join(root, "worktree.ctrlyokerun"),
      exportedByVersion: "test",
    });
    assert.strictEqual(exported.continuation?.workspace.baseCommit, baseCommit);
    assert.strictEqual(
      exported.continuation?.workspace.branch,
      "feature-branch"
    );
    assert.strictEqual(exported.continuation?.worktreeMode, "managed");
  });
});

async function createRun(args: {
  state: (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];
  currentIndex: number;
  steps: Array<{ prompt: string }>;
  pendingRewind?: boolean;
  worktree?: {
    mode: string;
    baseCommit: string;
    branchName: string;
    executionRoot: string;
  };
}): Promise<{ workflowKey: never; runRef: never }> {
  const repository = new WorkflowLineageRepository();
  const lineage = await repository.createLineage(
    workspace,
    "export fixture",
    "Export fixture"
  );
  const allocation = await repository.allocateRun(
    workspace,
    lineage.workflowKey
  );
  const workingFile = {
    steps: args.steps,
    startedAt: 100,
    definitionRevision: 1,
    _runtime: {
      currentIndex: args.currentIndex,
      executionState: args.state,
      ...(args.pendingRewind
        ? { pendingRewind: { fromStepIndex: 0, baseDefinitionRevision: 1 } }
        : {}),
      ...(args.worktree
        ? {
            worktree: {
              ...args.worktree,
              schemaVersion: 1,
              origin: "created",
              executionCheckoutRoot: args.worktree.executionRoot,
              sourceCheckoutRoot: workspace,
              namedWorkspaceRoots: [],
              lifecycleOwner: "ctrlyoke",
              lifecycleState: "settled",
              directoryState: "present",
              branchState: "present",
              updatedAt: 100,
            },
          }
        : {}),
    },
  } as unknown as WorkingFile;
  await WorkingFileManager.writeWorkingFileAtomic(
    allocation.stagingRunFilePath,
    workingFile
  );
  const timeline = new TimelineRecorder();
  await timeline.initializeRunAt(
    allocation.stagingRunDir,
    lineage.workflowKey,
    allocation.runId,
    100,
    args.state
  );
  await WorkingFileManager.publishAnchoredRun(
    workspace,
    lineage.workflowKey,
    allocation,
    workingFile,
    repository
  );
  return {
    workflowKey: lineage.workflowKey as never,
    runRef: allocation.runRef as never,
  };
}
