import * as assert from "assert";
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

async function writeDraftLineage(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  workflowName: string,
  startedAt: number,
  lastModifiedAt: number
): Promise<void> {
  await fs.mkdir(WorkflowPaths.draftDir(workspaceRoot, workflowKey), {
    recursive: true,
  });
  const descriptor: WorkflowLineageDescriptor = {
    schemaVersion: 1,
    workflowKey,
    workflowName,
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
});
