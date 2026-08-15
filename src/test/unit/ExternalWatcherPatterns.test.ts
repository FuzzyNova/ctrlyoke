import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { CliWatchSession } from "../../core/orchestration/CliWatchSession";
import { WorkflowOrchestrator } from "../../core/WorkflowOrchestrator";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { pathsEqual } from "../../utils/PathCasing";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

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
      const session = new CliWatchSession(
        workingFilePath,
        workflowKey,
        runRef,
        workspaceRoot,
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
