import * as assert from "assert";
import * as path from "path";
import {
  resolveWorkspaceRoot,
  type ResolverWorkspaceFolder,
} from "../../platform/WorkspaceRootResolver";

/**
 * Pure-function tests for the `.ctrlyoke` root resolver. These intentionally
 * do not touch the `vscode` module — the VS Code binding lives in
 * `VsCodeWorkspaceRoot.ts` and just gathers these inputs from live workspace
 * state.
 */
suite("WorkspaceRootResolver Tests", () => {
  // OS-appropriate absolute paths so the assertions hold on win32 and posix.
  const repoRoot = path.resolve("/repo");
  const appFolder = path.resolve("/repo/app");
  const docsFolder = path.resolve("/repo/docs");
  const workspaceFileDir = path.resolve("/repo/.vscode");

  const folders: ResolverWorkspaceFolder[] = [
    { name: "app", fsPath: appFolder },
    { name: "docs", fsPath: docsFolder },
  ];

  suite("setting (highest precedence)", () => {
    test("absolute setting is used as-is (normalized)", () => {
      const custom = path.resolve("/elsewhere/custom-root");
      assert.strictEqual(
        resolveWorkspaceRoot({
          setting: custom,
          workspaceFileDir,
          workspaceFolders: folders,
        }),
        path.normalize(custom)
      );
    });

    test("relative setting resolves against the .code-workspace dir", () => {
      assert.strictEqual(
        resolveWorkspaceRoot({
          setting: "../project",
          workspaceFileDir,
          workspaceFolders: folders,
        }),
        path.resolve(workspaceFileDir, "../project")
      );
    });

    test("relative setting falls back to the first folder when no workspace file", () => {
      assert.strictEqual(
        resolveWorkspaceRoot({
          setting: "sub/dir",
          workspaceFolders: folders,
        }),
        path.resolve(appFolder, "sub/dir")
      );
    });

    test("${workspaceFolder} expands to the first folder", () => {
      assert.strictEqual(
        resolveWorkspaceRoot({
          setting: "${workspaceFolder}",
          workspaceFolders: folders,
        }),
        path.normalize(appFolder)
      );
    });

    test("${workspaceFolder:Name} expands to the named folder", () => {
      assert.strictEqual(
        resolveWorkspaceRoot({
          setting: "${workspaceFolder:docs}",
          workspaceFolders: folders,
        }),
        path.normalize(docsFolder)
      );
    });

    test("unknown ${workspaceFolder:Name} is left untouched and treated as relative", () => {
      assert.strictEqual(
        resolveWorkspaceRoot({
          setting: "${workspaceFolder:missing}/x",
          workspaceFileDir,
          workspaceFolders: folders,
        }),
        path.resolve(workspaceFileDir, "${workspaceFolder:missing}/x")
      );
    });

    test("whitespace-only setting is treated as unset", () => {
      assert.strictEqual(
        resolveWorkspaceRoot({
          setting: "   ",
          workspaceFileDir,
          workspaceFolders: folders,
        }),
        workspaceFileDir
      );
    });
  });

  suite("auto-detect (no setting)", () => {
    test("uses the .code-workspace dir when present (saved multi-root)", () => {
      assert.strictEqual(
        resolveWorkspaceRoot({
          workspaceFileDir,
          workspaceFolders: folders,
        }),
        workspaceFileDir
      );
    });

    test("untitled multi-root (no workspaceFileDir) falls back to first folder", () => {
      assert.strictEqual(
        resolveWorkspaceRoot({
          workspaceFolders: folders,
        }),
        appFolder
      );
    });

    test("single-folder case returns that folder (today's behavior)", () => {
      assert.strictEqual(
        resolveWorkspaceRoot({
          workspaceFolders: [{ name: "solo", fsPath: repoRoot }],
        }),
        repoRoot
      );
    });

    test("no folder open falls back to the provided cwd", () => {
      const cwd = path.resolve("/some/cwd");
      assert.strictEqual(resolveWorkspaceRoot({ cwd }), cwd);
    });

    test("no folder and no cwd falls back to process.cwd()", () => {
      assert.strictEqual(resolveWorkspaceRoot({}), process.cwd());
    });
  });
});
