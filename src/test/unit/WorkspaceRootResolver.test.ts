import * as assert from "assert";
import * as path from "path";
import {
  resolveWorkspaceRoot,
  resolveTrustedWorkspaceRoots,
  resolveNamedRelativePath,
  resolveEffectiveAbsoluteReferences,
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

  suite("resolveTrustedWorkspaceRoots", () => {
    test("includes the primary root plus every workspace folder, even when the .code-workspace file lives outside all of them", () => {
      // A completely ordinary multi-root layout: the .code-workspace file is
      // saved in a directory that is NOT an ancestor of either project folder
      // (VS Code does not require this). Before this helper existed, only
      // `workspaceFileDir` was trusted, so @file refs into either folder were
      // wrongly blocked as "outside the workspace."
      const unrelatedConfigDir = path.resolve("/configs");
      const frontendFolder = path.resolve("/repos/frontend");
      const backendFolder = path.resolve("/other/backend");

      const roots = resolveTrustedWorkspaceRoots({
        workspaceFileDir: unrelatedConfigDir,
        workspaceFolders: [
          { name: "frontend", fsPath: frontendFolder },
          { name: "backend", fsPath: backendFolder },
        ],
      });

      assert.deepStrictEqual(
        new Set(roots),
        new Set([unrelatedConfigDir, frontendFolder, backendFolder])
      );
    });

    test("dedupes when the primary root is also one of the workspace folders", () => {
      const roots = resolveTrustedWorkspaceRoots({
        workspaceFolders: folders, // no workspaceFileDir → primary root = folders[0] = appFolder
      });

      assert.deepStrictEqual(new Set(roots), new Set([appFolder, docsFolder]));
      assert.strictEqual(roots.length, 2);
    });

    test("returns just the cwd fallback when no folders are open", () => {
      const cwd = path.resolve("/some/cwd");
      assert.deepStrictEqual(resolveTrustedWorkspaceRoots({ cwd }), [cwd]);
    });
  });

  suite("resolveNamedRelativePath", () => {
    test("folder-name-prefixed ref resolves against the matching named root", () => {
      assert.strictEqual(
        resolveNamedRelativePath("docs/readme.md", appFolder, folders),
        path.resolve(docsFolder, "readme.md")
      );
    });

    test("falls back to the root's directory basename when name doesn't match", () => {
      const unnamedRoots: ResolverWorkspaceFolder[] = [
        { name: "Frontend App", fsPath: appFolder },
      ];
      assert.strictEqual(
        resolveNamedRelativePath("app/src/index.ts", repoRoot, unnamedRoots),
        path.resolve(appFolder, "src/index.ts")
      );
    });

    test("unprefixed ref resolves against the primary root", () => {
      assert.strictEqual(
        resolveNamedRelativePath("src/index.ts", appFolder, folders),
        path.resolve(appFolder, "src/index.ts")
      );
    });

    test("no named-root match falls back to the primary root (segment looks like a path, not a folder name)", () => {
      assert.strictEqual(
        resolveNamedRelativePath("lib/index.ts", appFolder, folders),
        path.resolve(appFolder, "lib/index.ts")
      );
    });

    test("absolute paths are returned as-is regardless of named roots", () => {
      const absolute = path.resolve("/elsewhere/file.ts");
      assert.strictEqual(
        resolveNamedRelativePath(absolute, appFolder, folders),
        absolute
      );
    });

    test("empty named roots behaves exactly like plain path.resolve", () => {
      assert.strictEqual(
        resolveNamedRelativePath("docs/readme.md", appFolder, []),
        path.resolve(appFolder, "docs/readme.md")
      );
    });
  });

  suite("resolveEffectiveAbsoluteReferences", () => {
    test("multi-root forces absolute even when the user setting is off", () => {
      assert.strictEqual(resolveEffectiveAbsoluteReferences(false, true), true);
    });

    test("single-root falls back to the user setting (off)", () => {
      assert.strictEqual(
        resolveEffectiveAbsoluteReferences(false, false),
        false
      );
    });

    test("single-root falls back to the user setting (on)", () => {
      assert.strictEqual(resolveEffectiveAbsoluteReferences(true, false), true);
    });
  });
});
