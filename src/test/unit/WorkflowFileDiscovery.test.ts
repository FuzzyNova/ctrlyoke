import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, test } from "mocha";
import { findWorkflowFilesInWorkspace } from "../../utils/WorkflowFileDiscovery";
import { BUNDLE_MANIFEST_FILE_NAME } from "../../types/DashboardConstants";

suite("WorkflowFileDiscovery", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not discover prompt files inside manifested bundle assets", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workflow-discovery-")
    );
    tempDirs.push(workspaceRoot);
    const assetsDirectory = path.join(workspaceRoot, "workflow.assets");
    await fs.mkdir(assetsDirectory);
    await fs.writeFile(
      path.join(assetsDirectory, BUNDLE_MANIFEST_FILE_NAME),
      "{}",
      "utf8"
    );
    await fs.writeFile(
      path.join(assetsDirectory, "asset.prompt.md"),
      "bundled prompt",
      "utf8"
    );

    assert.deepStrictEqual(findWorkflowFilesInWorkspace(workspaceRoot), []);
  });

  test("discovers prompt files inside an unmanifested assets directory", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workflow-discovery-")
    );
    tempDirs.push(workspaceRoot);
    const assetsDirectory = path.join(workspaceRoot, "mygame.assets");
    await fs.mkdir(assetsDirectory);
    await fs.writeFile(
      path.join(assetsDirectory, "workflow.prompt.md"),
      "user workflow",
      "utf8"
    );

    const files = findWorkflowFilesInWorkspace(workspaceRoot);

    assert.deepStrictEqual(
      files.map((file) => file.relativePath),
      ["mygame.assets/workflow.prompt.md"]
    );
  });
});
