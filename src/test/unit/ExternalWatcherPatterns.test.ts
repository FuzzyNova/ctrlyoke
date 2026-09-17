import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { ExternalRunWatchSession } from "../../core/orchestration/ExternalRunWatchSession";
import { PromptFileWatcher } from "../../core/orchestration/PromptFileWatcher";
import { PromptQueue } from "../../core/PromptQueue";
import { WorkflowOrchestrator } from "../../core/WorkflowOrchestrator";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { pathsEqual } from "../../utils/PathCasing";
import type {
  RunRef,
  RunnerHostIdentity,
  WorkflowStep,
  WorkflowKey,
  WorkflowRunnerLock,
} from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../../types/CtrlYokeTypes";
import { RUNNER_IDS, STEP_TYPES } from "../../types/DashboardConstants";
import type { ActiveExternalLockInspection } from "../../core/orchestration/ExternalExecutionResolver";
import type { IDashboardSink } from "../../types/IDashboardSink";
import { VsCodeFileWatcherFactory } from "../../platform/VsCodeFileWatcher";

function makeInspection(
  workflowKey: WorkflowKey,
  runRef: RunRef
): ActiveExternalLockInspection {
  const lock: WorkflowRunnerLock = {
    schemaVersion: 2,
    workflowKey,
    runRef,
    runner: RUNNER_IDS.CLI,
    pid: process.pid,
    hostInstanceId: "watch-pattern-host",
    executionInstanceId: "watch-pattern-execution",
    ownerToken: "watch-pattern-owner",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  return { liveness: "active", locality: "external", lock };
}

const observer: RunnerHostIdentity = {
  runner: RUNNER_IDS.VSCODE,
  hostInstanceId: "observer-host",
  pid: process.pid,
};

function createFakeWatcher(): vscode.FileSystemWatcher {
  const disposable = { dispose: () => undefined };
  return {
    onDidCreate: () => disposable,
    onDidChange: () => disposable,
    onDidDelete: () => disposable,
    dispose: () => undefined,
  } as unknown as vscode.FileSystemWatcher;
}

function getBasePath(pattern: vscode.RelativePattern): string {
  return pattern.baseUri.fsPath;
}

suite("external watcher patterns", () => {
  test("reloads an atomic rename through the external-path polling fallback", async () => {
    const externalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-watcher-rename-")
    );
    const workingFilePath = path.join(
      externalRoot,
      "run",
      "workflow.ctrlyoke.json"
    );
    await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
    await fs.writeFile(
      workingFilePath,
      JSON.stringify({
        steps: [{ type: STEP_TYPES.PROMPT, prompt: "initial" }],
        _runtime: {
          currentIndex: 0,
          executionState: EXECUTION_STATES.RUNNING,
        },
      })
    );

    const queue = new PromptQueue();
    await queue.restoreFromWorkingFile(workingFilePath);
    const promptWatcher = new PromptFileWatcher(queue);
    let resolveReload: () => void = () => undefined;
    const reload = new Promise<void>((resolve) => {
      resolveReload = resolve;
    });

    promptWatcher.setupFileWatcher(
      workingFilePath,
      async () => {
        resolveReload();
      },
      () => undefined
    );

    try {
      // Let the polling fallback record the pre-rename signature first.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const replacementPath = `${workingFilePath}.tmp`;
      await fs.writeFile(
        replacementPath,
        JSON.stringify({
          steps: [{ type: STEP_TYPES.PROMPT, prompt: "after atomic rename" }],
        })
      );
      await fs.rename(replacementPath, workingFilePath);

      await reload;
    } finally {
      promptWatcher.dispose();
      await fs.rm(externalRoot, { recursive: true, force: true });
    }
  });

  test("routes an atomic rename through the onDidCreate reload handler", async () => {
    const externalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-watcher-create-")
    );
    const workingFilePath = path.join(
      externalRoot,
      "run",
      "workflow.ctrlyoke.json"
    );
    await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
    await fs.writeFile(
      workingFilePath,
      JSON.stringify({
        steps: [{ type: STEP_TYPES.PROMPT, prompt: "initial" }],
        _runtime: {
          currentIndex: 0,
          executionState: EXECUTION_STATES.RUNNING,
        },
      })
    );

    const queue = new PromptQueue();
    await queue.restoreFromWorkingFile(workingFilePath);
    const originalCreateFileSystemWatcher =
      vscode.workspace.createFileSystemWatcher;
    let onDidCreate: ((uri: vscode.Uri) => unknown) | undefined;
    const disposable = { dispose: () => undefined };
    Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
      configurable: true,
      value: () =>
        ({
          onDidCreate: (handler: (uri: vscode.Uri) => unknown) => {
            onDidCreate = handler;
            return disposable;
          },
          onDidChange: () => disposable,
          onDidDelete: () => disposable,
          dispose: () => undefined,
        }) as unknown as vscode.FileSystemWatcher,
    });

    let promptWatcher: PromptFileWatcher | undefined;
    try {
      promptWatcher = new PromptFileWatcher(queue);
      let reloadCount = 0;
      promptWatcher.setupFileWatcher(
        workingFilePath,
        async () => {
          reloadCount += 1;
        },
        () => undefined
      );
      assert.ok(onDidCreate);
      const replacementPath = `${workingFilePath}.tmp`;
      await fs.writeFile(
        replacementPath,
        JSON.stringify({
          steps: [{ type: STEP_TYPES.PROMPT, prompt: "after atomic rename" }],
        })
      );
      await fs.rename(replacementPath, workingFilePath);
      await onDidCreate(vscode.Uri.file(workingFilePath));
      assert.strictEqual(reloadCount, 1);
    } finally {
      promptWatcher?.dispose();
      Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
        configurable: true,
        value: originalCreateFileSystemWatcher,
      });
      await fs.rm(externalRoot, { recursive: true, force: true });
    }
  });

  test("follows the promoted run file instead of the draft", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-watcher-promotion-")
    );
    const originalCreateFileSystemWatcher =
      vscode.workspace.createFileSystemWatcher;
    const patterns: vscode.RelativePattern[] = [];
    const steps: WorkflowStep[] = [
      { type: STEP_TYPES.PROMPT, prompt: "run this" },
    ];

    Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
      configurable: true,
      value: (pattern: vscode.GlobPattern) => {
        patterns.push(pattern as vscode.RelativePattern);
        return createFakeWatcher();
      },
    });

    let promptWatcher: PromptFileWatcher | undefined;
    try {
      const queue = new PromptQueue();
      const draftPath = await queue.createWorkingFile(
        "watcher-promotion",
        steps,
        workspaceRoot
      );
      queue.loadPrompts({ steps }, draftPath);

      promptWatcher = new PromptFileWatcher(queue);
      promptWatcher.setupFileWatcher(
        draftPath,
        async () => undefined,
        () => undefined
      );

      const promoted = await queue.promoteToNewRun(workspaceRoot, Date.now());
      assert.ok(promoted);
      assert.strictEqual(patterns.length, 2);
      assert.ok(pathsEqual(getBasePath(patterns[0]), path.dirname(draftPath)));
      assert.ok(
        pathsEqual(
          getBasePath(patterns[1]),
          path.dirname(promoted.workingFilePath)
        )
      );
      assert.strictEqual(
        patterns[1].pattern,
        path.basename(promoted.workingFilePath)
      );
    } finally {
      promptWatcher?.dispose();
      Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
        configurable: true,
        value: originalCreateFileSystemWatcher,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("keeps following the working file after a superseded draft delete", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-watcher-stale-delete-")
    );
    const originalCreateFileSystemWatcher =
      vscode.workspace.createFileSystemWatcher;
    const patterns: vscode.RelativePattern[] = [];
    const deleteHandlers: ((uri: vscode.Uri) => unknown)[] = [];
    const steps: WorkflowStep[] = [
      { type: STEP_TYPES.PROMPT, prompt: "run this" },
    ];
    const disposable = { dispose: () => undefined };

    Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
      configurable: true,
      value: (pattern: vscode.GlobPattern) => {
        patterns.push(pattern as vscode.RelativePattern);
        return {
          onDidCreate: () => disposable,
          onDidChange: () => disposable,
          onDidDelete: (handler: (uri: vscode.Uri) => unknown) => {
            deleteHandlers.push(handler);
            return disposable;
          },
          dispose: () => undefined,
        } as unknown as vscode.FileSystemWatcher;
      },
    });

    let promptWatcher: PromptFileWatcher | undefined;
    try {
      const queue = new PromptQueue();
      const draftPath = await queue.createWorkingFile(
        "watcher-stale-delete",
        steps,
        workspaceRoot
      );
      queue.loadPrompts({ steps }, draftPath);

      let fileSelectedCleared = 0;
      promptWatcher = new PromptFileWatcher(
        queue,
        () =>
          ({
            updateFileSelected: () => {
              fileSelectedCleared += 1;
            },
          }) as unknown as IDashboardSink
      );

      let deletedPaths: string[] = [];
      promptWatcher.setupFileWatcher(
        draftPath,
        async () => undefined,
        (deletedPath) => {
          deletedPaths.push(deletedPath);
        }
      );

      const promoted = await queue.promoteToNewRun(workspaceRoot, Date.now());
      assert.ok(promoted);
      assert.strictEqual(patterns.length, 2);

      // finalizeRun deletes the promoted draft, and that event can arrive after
      // the queue already switched to the run file. It must be ignored: it is
      // not the active working file.
      assert.ok(deleteHandlers.length >= 1);
      for (const handler of deleteHandlers) {
        handler(vscode.Uri.file(draftPath));
      }
      assert.deepStrictEqual(
        deletedPaths,
        [],
        "a delete for the superseded draft must not report a deleted working file"
      );
      assert.strictEqual(
        fileSelectedCleared,
        0,
        "a superseded draft delete must not blank the dashboard mid-run"
      );

      // The state subscription must have survived, so a later working-file
      // change still re-points the watcher.
      const secondPromotion = await queue.promoteToNewRun(
        workspaceRoot,
        Date.now() + 1
      );
      assert.ok(secondPromotion);
      assert.strictEqual(
        patterns.length,
        3,
        "watcher must still follow workingFilePath after a superseded delete"
      );
      assert.ok(
        pathsEqual(
          getBasePath(patterns[2]),
          path.dirname(secondPromotion.workingFilePath)
        )
      );
    } finally {
      promptWatcher?.dispose();
      Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
        configurable: true,
        value: originalCreateFileSystemWatcher,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("uses external directory bases for the three exact CLI watch files", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-watcher-patterns-")
    );
    const originalCreateFileSystemWatcher =
      vscode.workspace.createFileSystemWatcher;
    const patterns: vscode.RelativePattern[] = [];

    Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
      configurable: true,
      value: (pattern: vscode.GlobPattern) => {
        patterns.push(pattern as vscode.RelativePattern);
        return createFakeWatcher();
      },
    });

    try {
      const workflowKey = "watch-patterns" as WorkflowKey;
      const runRef = "run-2026-08-14T00-00-00-000Z" as RunRef;
      const workingFilePath = path.join(
        workspaceRoot,
        "run",
        "workflow.ctrlyoke.json"
      );
      const session = new ExternalRunWatchSession(
        workingFilePath,
        workflowKey,
        runRef,
        workspaceRoot,
        makeInspection(workflowKey, runRef),
        observer,
        () => undefined,
        () => undefined,
        () => undefined
      );

      await session.start();
      session.dispose();

      const lockPath = WorkflowLockManager.getLockPath(
        workspaceRoot,
        workflowKey
      );
      const manifestPath = WorkflowPaths.manifestPath(
        workspaceRoot,
        workflowKey,
        runRef
      );
      assert.deepStrictEqual(
        patterns.map((pattern) => pattern.pattern),
        [
          path.basename(workingFilePath),
          path.basename(lockPath),
          path.basename(manifestPath),
        ]
      );
      assert.ok(
        pathsEqual(getBasePath(patterns[0]), path.dirname(workingFilePath))
      );
      assert.ok(pathsEqual(getBasePath(patterns[1]), path.dirname(lockPath)));
      assert.ok(
        pathsEqual(getBasePath(patterns[2]), path.dirname(manifestPath))
      );
    } finally {
      Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
        configurable: true,
        value: originalCreateFileSystemWatcher,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("uses a recursive external runs-root base for CLI discovery", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-orchestrator-watcher-")
    );
    const runsRoot = path.join(workspaceRoot, "state", ".runs");
    await fs.mkdir(runsRoot, { recursive: true });
    const originalCreateFileSystemWatcher =
      vscode.workspace.createFileSystemWatcher;
    let pattern: vscode.RelativePattern | undefined;
    let orchestrator: WorkflowOrchestrator | undefined;

    Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
      configurable: true,
      value: (value: vscode.GlobPattern) => {
        pattern = value as vscode.RelativePattern;
        return createFakeWatcher();
      },
    });

    try {
      orchestrator = Object.create(
        WorkflowOrchestrator.prototype
      ) as WorkflowOrchestrator;
      (
        orchestrator as unknown as {
          fileWatcherFactory: VsCodeFileWatcherFactory;
        }
      ).fileWatcherFactory = new VsCodeFileWatcherFactory();
      (
        orchestrator as unknown as {
          setupRunnerJsonCreateWatcher: (
            workspacePath: string,
            runsPath: string
          ) => void;
        }
      ).setupRunnerJsonCreateWatcher(workspaceRoot, runsRoot);

      assert.ok(pattern);
      assert.ok(
        pathsEqual(getBasePath(pattern as vscode.RelativePattern), runsRoot)
      );
      assert.strictEqual(pattern?.pattern, "*/runner.json");
    } finally {
      const pollInterval =
        orchestrator === undefined
          ? undefined
          : (
              orchestrator as unknown as {
                runnerJsonDiscoveryPollInterval?: ReturnType<
                  typeof setInterval
                >;
              }
            ).runnerJsonDiscoveryPollInterval;
      if (pollInterval !== undefined) {
        clearInterval(pollInterval);
      }
      Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
        configurable: true,
        value: originalCreateFileSystemWatcher,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
