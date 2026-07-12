import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { WorkspaceSessionManager } from "../../core/orchestration/WorkspaceSessionManager";
import { PromptFileParser } from "../../core/PromptFileParser";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

suite("WorkspaceSessionManager", () => {
  test("uses lastModifiedAt instead of filename order for recent session discovery", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workspace-session-manager-")
    );
    const workingDir = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.WORKING_DIR
    );
    await fs.mkdir(workingDir, { recursive: true });

    try {
      await fs.writeFile(
        path.join(workingDir, "older-name.ctrlyoke.json"),
        JSON.stringify({
          workflowName: "older-name",
          startedAt: 100,
          lastModifiedAt: 5000,
          steps: [],
        })
      );
      await fs.writeFile(
        path.join(workingDir, "newer-name.ctrlyoke.json"),
        JSON.stringify({
          workflowName: "newer-name",
          startedAt: 200,
          lastModifiedAt: 1000,
          steps: [],
        })
      );

      const manager = new WorkspaceSessionManager(
        new PromptFileParser(),
        {} as any
      );

      const mostRecentPath =
        await manager.getMostRecentWorkingFilePath(workspaceRoot);
      const sessions = await manager.discoverSessions(workspaceRoot);

      assert.strictEqual(
        mostRecentPath,
        path.join(workingDir, "older-name.ctrlyoke.json")
      );
      assert.strictEqual(sessions[0]?.label, "⏸ older-name");
      assert.strictEqual(sessions[1]?.label, "⏸ newer-name");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
