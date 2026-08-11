import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  createNoWorktreeExecutionWorkspace,
  type PlatformAdapter,
} from "../../platform/PlatformAdapter";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";

class RecordingPlatform implements PlatformAdapter {
  readonly approvedRootArguments: Array<string | undefined> = [];

  constructor(
    private readonly stateRoot: string,
    private readonly workspaceRoots: string[],
    private readonly namedWorkspaceRoots: ResolverWorkspaceFolder[],
    private readonly approvedExternalRoots: string[]
  ) {}

  getWorkspaceRoot(): string {
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
    return this.stateRoot;
  }
}

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
});
