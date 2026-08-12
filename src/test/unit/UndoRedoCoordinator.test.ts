import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as Diff from "diff";
import { execFileSync } from "child_process";
import { suite, test } from "mocha";
import { UndoRedoCoordinator } from "../../ui/UndoRedoCoordinator";
import {
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  UNDO_FILE_ACTIONS,
} from "../../types/DashboardConstants";
import type { PostMessageFn } from "../../ui/WebviewSettingsSync";
import type { UnifiedDiffHunk } from "../../types/CliOutputTypes";
import type {
  RunRef,
  WorkflowKey,
  WorkingFileWorktreeRuntime,
} from "../../types/CtrlYokeTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

suite("UndoRedoCoordinator", function () {
  this.timeout(10_000);

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
    }).trim();
  }

  async function createGitWorkspace(): Promise<string> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-undo-worktree-")
    );
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test User");
    await fs.writeFile(path.join(root, "shared.txt"), "base\n", "utf8");
    git(root, "add", "shared.txt");
    git(root, "commit", "-qm", "initial");
    return root;
  }

  async function writeRunFile(
    stateRoot: string,
    worktree: WorkingFileWorktreeRuntime,
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<void> {
    const runFilePath = WorkflowPaths.runFilePath(
      stateRoot,
      workflowKey,
      runRef
    );
    await fs.mkdir(path.dirname(runFilePath), { recursive: true });
    await fs.writeFile(
      runFilePath,
      JSON.stringify({ _runtime: { worktree } }),
      "utf8"
    );
  }

  test("undoes two edits to one file and redoes them as a round trip", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-undo-coordinator-")
    );
    try {
      const filePath = path.join(workspaceRoot, "shared.txt");
      const beforeWorkflow = "base\n";
      const afterFirstStep = "first\n";
      const afterSecondStep = "second\n";
      await fs.writeFile(filePath, afterSecondStep, "utf8");

      const firstPatch = Diff.structuredPatch(
        "shared.txt",
        "shared.txt",
        beforeWorkflow,
        afterFirstStep
      ).hunks as UnifiedDiffHunk[];
      const secondPatch = Diff.structuredPatch(
        "shared.txt",
        "shared.txt",
        afterFirstStep,
        afterSecondStep
      ).hunks as UnifiedDiffHunk[];
      const targetOne = {
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex: 0,
      } as const;
      const targetTwo = {
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex: 1,
      } as const;
      const workflowKey = "undo-test" as WorkflowKey;
      const runRef = "run-2026-08-11T00-00-00-000Z" as RunRef;
      const runFilePath = WorkflowPaths.runFilePath(
        workspaceRoot,
        workflowKey,
        runRef
      );
      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(runFilePath, JSON.stringify({}), "utf8");
      const postMessage = (() => undefined) as PostMessageFn;
      const coordinator = new UndoRedoCoordinator(
        () => undefined,
        () => ({
          executionRoot: workspaceRoot,
          namedWorkspaceRoots: [],
        })
      );

      await coordinator.handleUndoWorkflowChanges(
        {
          type: MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES,
          data: {
            requestId: "undo-round-trip",
            workflowKey,
            runRef,
            entries: [
              {
                target: targetTwo,
                files: [
                  {
                    path: "shared.txt",
                    action: UNDO_FILE_ACTIONS.REVERSE_PATCH,
                    structuredPatch: secondPatch,
                  },
                ],
              },
              {
                target: targetOne,
                files: [
                  {
                    path: "shared.txt",
                    action: UNDO_FILE_ACTIONS.REVERSE_PATCH,
                    structuredPatch: firstPatch,
                  },
                ],
              },
            ],
          },
        },
        postMessage
      );
      assert.strictEqual(await fs.readFile(filePath, "utf8"), beforeWorkflow);

      await coordinator.handleRedoWorkflowChanges(
        {
          type: MESSAGE_TYPES.REDO_WORKFLOW_CHANGES,
          data: {
            requestId: "redo-round-trip",
            workflowKey,
            runRef,
            entries: [
              {
                target: targetOne,
                files: [
                  {
                    path: "shared.txt",
                    action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
                    contentToRestore: afterFirstStep,
                    structuredPatch: firstPatch,
                  },
                ],
              },
              {
                target: targetTwo,
                files: [
                  {
                    path: "shared.txt",
                    action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
                    contentToRestore: afterSecondStep,
                    structuredPatch: secondPatch,
                  },
                ],
              },
            ],
          },
        },
        postMessage
      );
      assert.strictEqual(await fs.readFile(filePath, "utf8"), afterSecondStep);
    } finally {
      await fs.rm(workspaceRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test("restores a named worktree without touching the source checkout", async () => {
    const sourceRoot = await createGitWorkspace();
    const executionRoot = path.join(
      path.dirname(sourceRoot),
      `${path.basename(sourceRoot)}-linked`
    );
    const workflowKey = "worktree-undo" as WorkflowKey;
    const runRef = "run-2026-08-11T00-00-01-000Z" as RunRef;
    try {
      git(sourceRoot, "worktree", "add", "-q", "-b", "feature/undo", executionRoot);
      await fs.writeFile(path.join(executionRoot, "shared.txt"), "agent\n", "utf8");
      const runtime: WorkingFileWorktreeRuntime = {
        schemaVersion: 1,
        mode: "named",
        origin: "created",
        branchName: "feature/undo",
        worktreePath: executionRoot,
        executionRoot,
        executionCheckoutRoot: executionRoot,
        sourceCheckoutRoot: sourceRoot,
        namedWorkspaceRoots: [{ name: "repo", fsPath: executionRoot }],
        baseCommit: git(sourceRoot, "rev-parse", "HEAD"),
        lifecycleOwner: "user",
        lifecycleState: "ready",
        directoryState: "present",
        branchState: "present",
        updatedAt: Date.now(),
      };
      await writeRunFile(sourceRoot, runtime, workflowKey, runRef);

      const coordinator = new UndoRedoCoordinator(
        () => undefined,
        () => ({
          executionRoot: sourceRoot,
          namedWorkspaceRoots: [{ name: "repo", fsPath: sourceRoot }],
        })
      );
      await coordinator.handleUndoPromptChanges(
        {
          type: MESSAGE_TYPES.UNDO_PROMPT_CHANGES,
          data: {
            requestId: "worktree-undo",
            workflowKey,
            runRef,
            target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
            files: [
              {
                path: "shared.txt",
                action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
                contentToRestore: "base\n",
              },
            ],
          },
        },
        (() => undefined) as PostMessageFn
      );

      assert.strictEqual(
        await fs.readFile(path.join(sourceRoot, "shared.txt"), "utf8"),
        "base\n"
      );
      assert.strictEqual(
        await fs.readFile(path.join(executionRoot, "shared.txt"), "utf8"),
        "base\n"
      );

      runtime.branchName = "feature/not-the-checked-out-branch";
      await fs.writeFile(path.join(executionRoot, "shared.txt"), "agent-again\n", "utf8");
      await writeRunFile(sourceRoot, runtime, workflowKey, runRef);
      await coordinator.handleUndoPromptChanges(
        {
          type: MESSAGE_TYPES.UNDO_PROMPT_CHANGES,
          data: {
            requestId: "mismatched-worktree-undo",
            workflowKey,
            runRef,
            target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
            files: [
              {
                path: "shared.txt",
                action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
                contentToRestore: "must-not-apply\n",
              },
            ],
          },
        },
        (() => undefined) as PostMessageFn
      );
      assert.strictEqual(
        await fs.readFile(path.join(executionRoot, "shared.txt"), "utf8"),
        "agent-again\n"
      );
    } finally {
      await fs.rm(sourceRoot, { recursive: true, force: true });
      await fs.rm(executionRoot, { recursive: true, force: true });
    }
  });

  test("refuses a missing recorded worktree even when called directly", async () => {
    const sourceRoot = await createGitWorkspace();
    const missingRoot = path.join(path.dirname(sourceRoot), "missing-worktree");
    const workflowKey = "missing-worktree-undo" as WorkflowKey;
    const runRef = "run-2026-08-11T00-00-02-000Z" as RunRef;
    try {
      const runtime: WorkingFileWorktreeRuntime = {
        schemaVersion: 1,
        mode: "named",
        origin: "recovered",
        branchName: "feature/missing",
        worktreePath: missingRoot,
        executionRoot: missingRoot,
        executionCheckoutRoot: missingRoot,
        sourceCheckoutRoot: sourceRoot,
        namedWorkspaceRoots: [{ name: "repo", fsPath: missingRoot }],
        baseCommit: git(sourceRoot, "rev-parse", "HEAD"),
        lifecycleOwner: "user",
        lifecycleState: "ready",
        directoryState: "present",
        branchState: "present",
        updatedAt: Date.now(),
      };
      await writeRunFile(sourceRoot, runtime, workflowKey, runRef);
      const coordinator = new UndoRedoCoordinator(
        () => undefined,
        () => ({ executionRoot: sourceRoot, namedWorkspaceRoots: [] })
      );

      await coordinator.handleUndoPromptChanges(
        {
          type: MESSAGE_TYPES.UNDO_PROMPT_CHANGES,
          data: {
            requestId: "missing-worktree-undo",
            workflowKey,
            runRef,
            target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
            files: [
              {
                path: "shared.txt",
                action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
                contentToRestore: "overwritten\n",
              },
            ],
          },
        },
        (() => undefined) as PostMessageFn
      );

      assert.strictEqual(
        await fs.readFile(path.join(sourceRoot, "shared.txt"), "utf8"),
        "base\n"
      );
    } finally {
      await fs.rm(sourceRoot, { recursive: true, force: true });
    }
  });
});
