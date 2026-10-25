import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { afterEach, suite, test } from "mocha";
import { findWorkflowFilesInWorkspace } from "../../utils/WorkflowFileDiscovery";
import { BUNDLE_MANIFEST_FILE_NAME } from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
import type { ConfigBackend } from "../../config/CtrlYokeConfigService";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

const execFileAsync = promisify(execFile);

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

    assert.deepStrictEqual(await findWorkflowFilesInWorkspace(workspaceRoot), []);
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

    const files = await findWorkflowFilesInWorkspace(workspaceRoot);

    assert.deepStrictEqual(
      files.map((file) => file.relativePath),
      ["mygame.assets/workflow.prompt.md"]
    );
  });

  test("uses Git candidates and excludes ignored workflows unless requested", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workflow-discovery-git-")
    );
    tempDirs.push(workspaceRoot);
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspaceRoot });
    await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "ignored/\n");
    await fs.mkdir(path.join(workspaceRoot, "ignored"));
    await fs.writeFile(path.join(workspaceRoot, "ignored", "hidden.prompt.md"), "ignored");
    await fs.writeFile(path.join(workspaceRoot, "tracked.ctrlyoke.yaml"), "tracked");
    await fs.writeFile(path.join(workspaceRoot, "untracked.prompt.md"), "untracked");
    await execFileAsync("git", ["add", ".gitignore", "tracked.ctrlyoke.yaml"], {
      cwd: workspaceRoot,
    });

    const visibleFiles = await findWorkflowFilesInWorkspace(workspaceRoot);
    assert.deepStrictEqual(
      visibleFiles.map((file) => file.relativePath),
      ["tracked.ctrlyoke.yaml", "untracked.prompt.md"]
    );
    assert.ok(visibleFiles.every((file) => file.gitIgnored === false));

    const settings: ConfigBackend = {
      getAll: () => ({ ui: { hideGitIgnoredFiles: false } }),
      set: async () => ({ ui: { hideGitIgnoredFiles: false } }),
    };
    configService.setUserBackend(settings);
    let allFiles: Awaited<ReturnType<typeof findWorkflowFilesInWorkspace>>;
    try {
      allFiles = await findWorkflowFilesInWorkspace(workspaceRoot, {
        includeGitIgnored:
          ConfigurationUtils.shouldIncludeGitIgnoredWorkflowFiles(),
      });
    } finally {
      configService.setUserBackend({
        getAll: () => ({}),
        set: async () => ({}),
      });
    }
    assert.deepStrictEqual(
      allFiles.map((file) => [file.relativePath, file.gitIgnored]),
      [
        ["ignored/hidden.prompt.md", true],
        ["tracked.ctrlyoke.yaml", false],
        ["untracked.prompt.md", false],
      ]
    );
  });

  test("uses the asynchronous filesystem walk outside a Git checkout", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workflow-discovery-non-git-")
    );
    tempDirs.push(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "nested"));
    await fs.mkdir(path.join(workspaceRoot, "node_modules"));
    await fs.writeFile(path.join(workspaceRoot, "nested", "workflow.prompt.md"), "workflow");
    await fs.writeFile(path.join(workspaceRoot, "node_modules", "hidden.prompt.md"), "hidden");

    const files = await findWorkflowFilesInWorkspace(workspaceRoot);
    assert.deepStrictEqual(
      files.map((file) => file.relativePath),
      ["nested/workflow.prompt.md"]
    );
  });

  test("falls back to the filesystem walk when Git cannot spawn", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workflow-discovery-no-git-")
    );
    tempDirs.push(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, "workflow.prompt.md"), "workflow");

    const files = await findWorkflowFilesInWorkspace(workspaceRoot, {
      dependencies: {
        getGitFilesIncludingNestedRepos: async function* () {
          const error = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      },
    });

    assert.deepStrictEqual(
      files.map((file) => file.relativePath),
      ["workflow.prompt.md"]
    );
  });
});
