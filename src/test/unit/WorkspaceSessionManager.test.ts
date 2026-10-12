import * as assert from "assert";
import * as fsCallbacks from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { WorkspaceSessionManager } from "../../core/orchestration/WorkspaceSessionManager";
import { PromptFileParser } from "../../core/PromptFileParser";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type {
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../../types/DashboardConstants";

async function writeDraftLineage(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  workflowName: string,
  startedAt: number,
  lastModifiedAt: number,
  isSystemGenerated = false
): Promise<void> {
  await fs.mkdir(WorkflowPaths.draftDir(workspaceRoot, workflowKey), {
    recursive: true,
  });
  const descriptor: WorkflowLineageDescriptor = {
    schemaVersion: 1,
    workflowKey,
    workflowName,
    ...(isSystemGenerated ? { isSystemGenerated: true } : {}),
    isFavorite: false,
    createdAt: startedAt,
    lastModifiedAt,
    nextRunId: 1,
    revision: 1,
  };
  await fs.writeFile(
    WorkflowPaths.descriptorPath(workspaceRoot, workflowKey),
    JSON.stringify(descriptor, null, 2),
    "utf8"
  );
  await fs.writeFile(
    WorkflowPaths.draftFilePath(workspaceRoot, workflowKey),
    JSON.stringify({
      workflowName,
      startedAt,
      lastModifiedAt,
      definitionRevision: 1,
      steps: [],
    }),
    "utf8"
  );
}

suite("WorkspaceSessionManager", () => {
  test("uses lastModifiedAt instead of filename order for recent session discovery", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workspace-session-manager-")
    );

    try {
      const olderKey = "older-name-2026-01-01T00-00-00" as WorkflowKey;
      const newerKey = "newer-name-2026-01-02T00-00-00" as WorkflowKey;
      await writeDraftLineage(workspaceRoot, olderKey, "older-name", 100, 5000);
      await writeDraftLineage(workspaceRoot, newerKey, "newer-name", 200, 1000);

      const manager = new WorkspaceSessionManager(
        new PromptFileParser(),
        {} as any
      );

      const mostRecentPath =
        await manager.getMostRecentWorkingFilePath(workspaceRoot);
      const sessions = await manager.discoverSessions(workspaceRoot);

      assert.strictEqual(
        mostRecentPath,
        WorkflowPaths.draftFilePath(workspaceRoot, olderKey)
      );
      assert.strictEqual(sessions[0]?.label, "⏸ older-name");
      assert.strictEqual(sessions[1]?.label, "⏸ newer-name");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("includes persisted worktree branch and lifecycle state in session details", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-worktree-session-detail-")
    );

    try {
      const workflowKey = "worktree-detail-2026-01-01T00-00-00" as WorkflowKey;
      await writeDraftLineage(
        workspaceRoot,
        workflowKey,
        "worktree-detail",
        100,
        100
      );
      const filePath = WorkflowPaths.draftFilePath(workspaceRoot, workflowKey);
      const workingFile = JSON.parse(
        await fs.readFile(filePath, "utf8")
      ) as Record<string, unknown>;
      workingFile._runtime = {
        currentIndex: 1,
        executionState: EXECUTION_STATES.COMPLETED,
        worktree: {
          mode: "managed",
          branchName: "ctrlyoke/worktree-detail/run-1",
          lifecycleState: "settled",
          directoryState: "removed",
          branchState: "present",
        },
        worktreeNotice:
          "Configured worktree default did not apply: workspace is not a Git repository.",
      };
      await fs.writeFile(filePath, JSON.stringify(workingFile), "utf8");

      const manager = new WorkspaceSessionManager(
        new PromptFileParser(),
        {} as any
      );
      const [session] = await manager.discoverSessions(workspaceRoot);

      assert.match(
        session?.detail ?? "",
        /Worktree: ctrlyoke\/worktree-detail\/run-1 \(managed, lifecycle settled, directory removed, branch present\)/
      );
      assert.match(
        session?.detail ?? "",
        /Configured worktree default did not apply: workspace is not a Git repository\./
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("finds the most recent lineage from run-file activity newer than its descriptor", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workspace-recent-activity-")
    );

    try {
      // Appending to a run writes only the run file, never the descriptor.
      const appendedKey = "appended-2026-01-01T00-00-00" as WorkflowKey;
      const editedKey = "edited-2026-01-02T00-00-00" as WorkflowKey;
      await writeDraftLineage(
        workspaceRoot,
        appendedKey,
        "appended",
        100,
        1000
      );
      await writeDraftLineage(workspaceRoot, editedKey, "edited", 200, 5000);
      const appendedPath = WorkflowPaths.draftFilePath(
        workspaceRoot,
        appendedKey
      );
      const appended = JSON.parse(
        await fs.readFile(appendedPath, "utf8")
      ) as Record<string, unknown>;
      appended.steps = [
        { prompt: "continue", _runtime: { completedAt: 9000 } },
      ];
      await fs.writeFile(appendedPath, JSON.stringify(appended), "utf8");
      // Real mtimes trail the activity they record; pin them to match.
      await fs.utimes(appendedPath, new Date(9000), new Date(9000));
      await fs.utimes(
        WorkflowPaths.draftFilePath(workspaceRoot, editedKey),
        new Date(5000),
        new Date(5000)
      );

      const manager = new WorkspaceSessionManager(
        new PromptFileParser(),
        {} as any
      );

      assert.strictEqual(
        await manager.getMostRecentWorkingFilePath(workspaceRoot),
        appendedPath
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reads only lineages whose recency bound can still beat the best found", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workspace-recent-bound-")
    );
    const promises = fsCallbacks.promises;
    const originalReadFile = promises.readFile;
    const workingFilesRead = new Set<string>();

    try {
      const keys = [
        "oldest-2026-01-01T00-00-00",
        "newest-2026-01-02T00-00-00",
        "middle-2026-01-03T00-00-00",
      ] as WorkflowKey[];
      const modifiedAt = [1000, 9000, 5000];
      for (const [index, workflowKey] of keys.entries()) {
        await writeDraftLineage(
          workspaceRoot,
          workflowKey,
          workflowKey,
          modifiedAt[index],
          modifiedAt[index]
        );
        const filePath = WorkflowPaths.draftFilePath(
          workspaceRoot,
          workflowKey
        );
        await fs.utimes(
          filePath,
          new Date(modifiedAt[index]),
          new Date(modifiedAt[index])
        );
      }

      promises.readFile = ((
        file: Parameters<typeof originalReadFile>[0],
        ...rest: unknown[]
      ) => {
        if (String(file).endsWith("workflow.ctrlyoke.json")) {
          workingFilesRead.add(String(file));
        }
        return (originalReadFile as (...args: unknown[]) => unknown)(
          file,
          ...rest
        );
      }) as typeof originalReadFile;

      const manager = new WorkspaceSessionManager(
        new PromptFileParser(),
        {} as any
      );
      const newestPath = WorkflowPaths.draftFilePath(workspaceRoot, keys[1]);

      assert.strictEqual(
        await manager.getMostRecentWorkingFilePath(workspaceRoot),
        newestPath
      );
      assert.deepStrictEqual([...workingFilesRead], [newestPath]);
    } finally {
      promises.readFile = originalReadFile;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("omits system-generated lineages from recent session discovery", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workspace-system-session-")
    );

    try {
      const userKey = "user-workflow-2026-01-01T00-00-00" as WorkflowKey;
      const systemKey = "system-workflow-2026-01-02T00-00-00" as WorkflowKey;
      await writeDraftLineage(
        workspaceRoot,
        userKey,
        "user-workflow",
        100,
        100
      );
      await writeDraftLineage(
        workspaceRoot,
        systemKey,
        "system-workflow",
        200,
        200,
        true
      );

      const manager = new WorkspaceSessionManager(
        new PromptFileParser(),
        {} as any
      );
      const sessions = await manager.discoverSessions(workspaceRoot);

      assert.deepStrictEqual(
        sessions.map((session) => session.filePath),
        [WorkflowPaths.draftFilePath(workspaceRoot, userKey)]
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
