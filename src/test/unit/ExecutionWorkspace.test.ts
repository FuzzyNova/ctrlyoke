import { INTERACTIVE_TERMINAL_MODES } from "../../types/DashboardConstants";
import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  createNoWorktreeExecutionWorkspace,
  NO_WORKSPACE_FOLDER_MESSAGE,
  requireWorkspaceRoot,
  type PlatformAdapter,
} from "../../platform/PlatformAdapter";
import { noWorkspacePlaceholderRoot } from "../../utils/ProjectStatePaths";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";

class RecordingPlatform implements PlatformAdapter {
  readonly interactiveTerminal = INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY;
  readonly approvedRootArguments: Array<string | undefined> = [];

  constructor(
    /** `undefined` models a VS Code window with no folder open. */
    private readonly stateRoot: string | undefined,
    private readonly workspaceRoots: string[],
    private readonly namedWorkspaceRoots: ResolverWorkspaceFolder[],
    private readonly approvedExternalRoots: string[]
  ) {}

  getWorkspaceRoot(): string | undefined {
    return this.stateRoot;
  }

  getWorkspaceRoots(): string[] {
    return this.workspaceRoots;
  }

  getNamedWorkspaceRoots(): ResolverWorkspaceFolder[] {
    return this.namedWorkspaceRoots;
  }

  getApprovedExternalFileRoots(stateRoot?: string): string[] {
    this.approvedRootArguments.push(stateRoot);
    return this.approvedExternalRoots;
  }

  getExtensionPath(): string {
    return os.tmpdir();
  }
}

suite("requireWorkspaceRoot", () => {
  test("returns the platform's root when a workspace is open", () => {
    const stateRoot = path.join(os.tmpdir(), "ctrlyoke-open-workspace");
    const platform = new RecordingPlatform(stateRoot, [stateRoot], [], []);

    assert.strictEqual(requireWorkspaceRoot(platform), stateRoot);
  });

  test("refuses rather than falling back to the process cwd", () => {
    const platform = new RecordingPlatform(undefined, [], [], []);

    assert.throws(
      () => requireWorkspaceRoot(platform),
      (error: Error) => error.message === NO_WORKSPACE_FOLDER_MESSAGE
    );
  });
});

suite("createNoWorktreeExecutionWorkspace", () => {
  test("preserves the single-root adapter values", () => {
    const stateRoot = path.join(os.tmpdir(), "ctrlyoke-single-root-state");
    const roots = [stateRoot];
    const namedRoots = [{ name: "project", fsPath: stateRoot }];
    const approvedRoots = [path.join(os.tmpdir(), "approved")];
    const platform = new RecordingPlatform(
      stateRoot,
      roots,
      namedRoots,
      approvedRoots
    );

    const workspace = createNoWorktreeExecutionWorkspace(platform);

    assert.strictEqual(workspace.stateRoot, stateRoot);
    assert.strictEqual(workspace.executionRoot, stateRoot);
    assert.deepStrictEqual(workspace.workspaceRoots, roots);
    assert.deepStrictEqual(workspace.namedWorkspaceRoots, namedRoots);
    assert.deepStrictEqual(workspace.approvedExternalRoots, approvedRoots);
    assert.deepStrictEqual(platform.approvedRootArguments, [stateRoot]);
  });

  test("preserves every multi-root adapter value", () => {
    const stateRoot = path.join(os.tmpdir(), "ctrlyoke-multi-root-state");
    const roots = [stateRoot, path.join(os.tmpdir(), "ctrlyoke-second-root")];
    const namedRoots = [
      { name: "primary", fsPath: roots[0] },
      { name: "secondary", fsPath: roots[1] },
    ];
    const approvedRoots = [path.join(os.tmpdir(), "shared-documents")];
    const platform = new RecordingPlatform(
      stateRoot,
      roots,
      namedRoots,
      approvedRoots
    );

    const workspace = createNoWorktreeExecutionWorkspace(platform);

    assert.deepStrictEqual(workspace.workspaceRoots, roots);
    assert.deepStrictEqual(workspace.namedWorkspaceRoots, namedRoots);
    assert.deepStrictEqual(workspace.approvedExternalRoots, approvedRoots);
    assert.strictEqual(workspace.executionRoot, stateRoot);
    assert.deepStrictEqual(platform.approvedRootArguments, [stateRoot]);
  });

  test("keeps a state root outside the repository roots unchanged", () => {
    const stateRoot = path.join(os.tmpdir(), "ctrlyoke-code-workspace-state");
    const repositoryRoot = path.join(os.tmpdir(), "ctrlyoke-repository");
    const roots = [
      repositoryRoot,
      path.join(repositoryRoot, "packages", "app"),
    ];
    const namedRoots = [
      { name: "repository", fsPath: roots[0] },
      { name: "app", fsPath: roots[1] },
    ];
    const platform = new RecordingPlatform(stateRoot, roots, namedRoots, []);

    const workspace = createNoWorktreeExecutionWorkspace(platform);

    assert.strictEqual(workspace.stateRoot, stateRoot);
    assert.strictEqual(workspace.executionRoot, stateRoot);
    assert.deepStrictEqual(workspace.workspaceRoots, roots);
    assert.deepStrictEqual(workspace.namedWorkspaceRoots, namedRoots);
    assert.deepStrictEqual(workspace.approvedExternalRoots, []);
    assert.deepStrictEqual(platform.approvedRootArguments, [stateRoot]);
  });

  test("roots a window with no folder in the inert placeholder, never the cwd", () => {
    const platform = new RecordingPlatform(undefined, [], [], []);

    const workspace = createNoWorktreeExecutionWorkspace(platform);

    assert.strictEqual(workspace.stateRoot, noWorkspacePlaceholderRoot());
    assert.strictEqual(workspace.executionRoot, noWorkspacePlaceholderRoot());
    assert.notStrictEqual(workspace.stateRoot, process.cwd());
    assert.deepStrictEqual(workspace.workspaceRoots, []);
  });
});
