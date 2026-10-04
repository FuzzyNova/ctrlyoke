import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { ExternalRunWatchCoordinator } from "../../core/orchestration/ExternalRunWatchCoordinator";
import { ExternalRunWatchSession } from "../../core/orchestration/ExternalRunWatchSession";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { PromptFileWatcher } from "../../core/orchestration/PromptFileWatcher";
import { PromptQueue } from "../../core/PromptQueue";
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
import type {
  Disposable,
  FileWatcher,
  FileWatcherFactory,
} from "../../core/HostPorts";

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

type WatchListener = (filePath: string) => unknown;

/** One watcher created by {@link RecordingFileWatcherFactory}. */
class RecordingFileWatcher implements FileWatcher {
  readonly createListeners: WatchListener[] = [];
  readonly changeListeners: WatchListener[] = [];
  readonly deleteListeners: WatchListener[] = [];
  disposed = false;

  constructor(
    readonly basePath: string,
    readonly glob: string
  ) {}

  onDidCreate(listener: WatchListener): Disposable {
    this.createListeners.push(listener);
    return { dispose: () => undefined };
  }

  onDidChange(listener: WatchListener): Disposable {
    this.changeListeners.push(listener);
    return { dispose: () => undefined };
  }

  onDidDelete(listener: WatchListener): Disposable {
    this.deleteListeners.push(listener);
    return { dispose: () => undefined };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Host-neutral watcher factory that records every watcher it creates. */
class RecordingFileWatcherFactory implements FileWatcherFactory {
  readonly watchers: RecordingFileWatcher[] = [];

  create(basePath: string, glob: string): RecordingFileWatcher {
    const watcher = new RecordingFileWatcher(basePath, glob);
    this.watchers.push(watcher);
    return watcher;
  }
}

suite("external watcher patterns", () => {
  test("reloads an atomic rename through polling when the host has no file watcher", async () => {
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
    const watcherFactory = new RecordingFileWatcherFactory();

    let promptWatcher: PromptFileWatcher | undefined;
    try {
      promptWatcher = new PromptFileWatcher(
        queue,
        () => undefined,
        watcherFactory,
        () => [externalRoot]
      );
      let reloadCount = 0;
      promptWatcher.setupFileWatcher(
        workingFilePath,
        async () => {
          reloadCount += 1;
        },
        () => undefined
      );
      assert.strictEqual(watcherFactory.watchers.length, 1);
      const [onDidCreate] = watcherFactory.watchers[0].createListeners;
      assert.ok(onDidCreate);
      const replacementPath = `${workingFilePath}.tmp`;
      await fs.writeFile(
        replacementPath,
        JSON.stringify({
          steps: [{ type: STEP_TYPES.PROMPT, prompt: "after atomic rename" }],
        })
      );
      await fs.rename(replacementPath, workingFilePath);
      await onDidCreate(workingFilePath);
      assert.strictEqual(reloadCount, 1);
    } finally {
      promptWatcher?.dispose();
      await fs.rm(externalRoot, { recursive: true, force: true });
    }
  });

  test("follows the promoted run file instead of the draft", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-watcher-promotion-")
    );
    const watcherFactory = new RecordingFileWatcherFactory();
    const watchers = watcherFactory.watchers;
    const steps: WorkflowStep[] = [
      { type: STEP_TYPES.PROMPT, prompt: "run this" },
    ];

    let promptWatcher: PromptFileWatcher | undefined;
    try {
      const queue = new PromptQueue();
      const draftPath = await queue.createWorkingFile(
        "watcher-promotion",
        steps,
        workspaceRoot
      );
      queue.loadPrompts({ steps }, draftPath);

      promptWatcher = new PromptFileWatcher(
        queue,
        () => undefined,
        watcherFactory
      );
      promptWatcher.setupFileWatcher(
        draftPath,
        async () => undefined,
        () => undefined
      );

      const promoted = await queue.promoteToNewRun(workspaceRoot, Date.now());
      assert.ok(promoted);
      assert.strictEqual(watchers.length, 2);
      assert.ok(pathsEqual(watchers[0].basePath, path.dirname(draftPath)));
      assert.ok(watchers[0].disposed);
      assert.ok(
        pathsEqual(watchers[1].basePath, path.dirname(promoted.workingFilePath))
      );
      assert.strictEqual(
        watchers[1].glob,
        path.basename(promoted.workingFilePath)
      );
    } finally {
      promptWatcher?.dispose();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("keeps following the working file after a superseded draft delete", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-watcher-stale-delete-")
    );
    const watcherFactory = new RecordingFileWatcherFactory();
    const watchers = watcherFactory.watchers;
    const steps: WorkflowStep[] = [
      { type: STEP_TYPES.PROMPT, prompt: "run this" },
    ];

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
          }) as unknown as IDashboardSink,
        watcherFactory
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
      assert.strictEqual(watchers.length, 2);

      // finalizeRun deletes the promoted draft, and that event can arrive after
      // the queue already switched to the run file. It must be ignored: it is
      // not the active working file.
      const deleteHandlers = watchers.flatMap(
        (watcher) => watcher.deleteListeners
      );
      assert.ok(deleteHandlers.length >= 1);
      for (const handler of deleteHandlers) {
        handler(draftPath);
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
        watchers.length,
        3,
        "watcher must still follow workingFilePath after a superseded delete"
      );
      assert.ok(
        pathsEqual(
          watchers[2].basePath,
          path.dirname(secondPromotion.workingFilePath)
        )
      );
    } finally {
      promptWatcher?.dispose();
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
    let coordinator: ExternalRunWatchCoordinator | undefined;

    Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
      configurable: true,
      value: (value: vscode.GlobPattern) => {
        pattern = value as vscode.RelativePattern;
        return createFakeWatcher();
      },
    });

    try {
      coordinator = new ExternalRunWatchCoordinator({
        broadcast: {
          notifyWorkflowAdded: () => undefined,
          notifyWorkflowDismissed: () => undefined,
          notifyWorkflowSummaryUpdated: () => undefined,
          notifyCliWatchOutput: () => undefined,
          notifyCliPromptsExtended: () => undefined,
          updateStepStatus: () => undefined,
          updateSessionRestored: async () => undefined,
        },
        lineageRepository: {
          listLineageKeys: async () => [],
          readWorkflowDisplayName: async () => "fixture",
          pruneStaleStagingDirs: async () => undefined,
        },
        findInstanceForWorkingFile: () => [],
        retireWorkflow: () => undefined,
        workspaceRoot,
        saveState: async () => undefined,
        getOutputHistoryManager: () => new OutputHistoryManager(workspaceRoot),
        runnerHostIdentity: observer,
        fileWatcherFactory: new VsCodeFileWatcherFactory(),
      });
      coordinator.setupRunnerJsonCreateWatcher(workspaceRoot, runsRoot);

      assert.ok(pattern);
      assert.ok(
        pathsEqual(getBasePath(pattern as vscode.RelativePattern), runsRoot)
      );
      assert.strictEqual(pattern?.pattern, "*/runner.json");
    } finally {
      const pollInterval =
        coordinator === undefined
          ? undefined
          : (
              coordinator as unknown as {
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
