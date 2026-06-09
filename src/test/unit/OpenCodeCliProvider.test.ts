import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { OpenCodeCliProvider } from "../../flightpath/harness/opencode/OpenCodeCliProvider";

suite("OpenCodeCliProvider", () => {
  test("writes a temporary plugin gitignore and cleans plugin artifacts after a run", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-provider-")
    );
    const extensionPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-extension-")
    );
    const provider = new OpenCodeCliProvider();

    try {
      await fs.mkdir(path.join(extensionPath, "out", "scripts"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(extensionPath, "out", "scripts", "flightpath-opencode-plugin.ts"),
        "export default {};\n",
        "utf-8"
      );

      await provider.buildCliArgs(
        { prompt: "test" },
        true,
        extensionPath,
        workspaceRoot,
        undefined,
        {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: {
            hooks: [{ event: "stop", command: "echo cleanup" }],
          },
        } as any
      );

      const pluginDir = path.join(workspaceRoot, ".opencode", "plugin");
      const pluginPath = path.join(pluginDir, "flightpath-completion-hook.ts");
      const sidecarPath = path.join(pluginDir, "flightpath-hooks.json");
      const gitignorePath = path.join(pluginDir, ".gitignore");

      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      assert.ok(gitignoreContent.includes("flightpath-completion-hook.ts"));
      assert.ok(gitignoreContent.includes("flightpath-hooks.json"));
      await fs.access(pluginPath);
      await fs.access(sidecarPath);

      for (const artifactPath of provider.getAdditionalCleanupFilePaths(
        workspaceRoot
      )) {
        await fs.unlink(artifactPath).catch(() => {});
      }
      await provider.cleanupWorkspaceArtifacts(workspaceRoot);

      await assert.rejects(fs.access(pluginPath), /ENOENT/);
      await assert.rejects(fs.access(sidecarPath), /ENOENT/);
      await assert.rejects(fs.access(gitignorePath), /ENOENT/);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(extensionPath, { recursive: true, force: true });
    }
  });

  test("preserves a user-owned plugin gitignore during cleanup", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-provider-")
    );
    const extensionPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-extension-")
    );
    const provider = new OpenCodeCliProvider();

    try {
      const pluginDir = path.join(workspaceRoot, ".opencode", "plugin");
      await fs.mkdir(pluginDir, { recursive: true });
      const gitignorePath = path.join(pluginDir, ".gitignore");
      const userGitignore = "# user-owned\n*.log\n";
      await fs.writeFile(gitignorePath, userGitignore, "utf-8");
      await fs.mkdir(path.join(extensionPath, "out", "scripts"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(extensionPath, "out", "scripts", "flightpath-opencode-plugin.ts"),
        "export default {};\n",
        "utf-8"
      );

      await provider.buildCliArgs(
        { prompt: "test" },
        true,
        extensionPath,
        workspaceRoot,
        undefined,
        {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: {
            hooks: [{ event: "stop", command: "echo cleanup" }],
          },
        } as any
      );

      for (const artifactPath of provider.getAdditionalCleanupFilePaths(
        workspaceRoot
      )) {
        await fs.unlink(artifactPath).catch(() => {});
      }
      await provider.cleanupWorkspaceArtifacts(workspaceRoot);

      assert.strictEqual(await fs.readFile(gitignorePath, "utf-8"), userGitignore);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(extensionPath, { recursive: true, force: true });
    }
  });
});
