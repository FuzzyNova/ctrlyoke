import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, teardown, test } from "mocha";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";
import {
  WORKTREE_DIRECTORY_KINDS,
  WORKTREE_IDENTITY_KINDS,
  WORKTREE_ROOT_TIERS,
} from "../../types/DashboardConstants";
import {
  assertWorktreePlacement,
  createWorktreeDirectoryName,
  evaluateWorkspaceEligibility,
  resolveThroughNearestExistingAncestor,
  resolveWorktreeDirectory,
  resolveWorktreeRoot,
  slugifyWorktreeName,
  validateWorktreeBranchName,
  type WorktreeRootResolution,
} from "../../utils/WorktreeUtils";
import { listWorktrees, gitCommonDir } from "../../utils/GitUtils";
import type { GitWorktreeEntry } from "../../utils/GitUtils";

suite("WorktreeUtils", function () {
  const temporaryDirectories: string[] = [];
  teardown(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  async function makeDirectory(name: string): Promise<string> {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), `ctrlyoke-${name}-`)
    );
    temporaryDirectories.push(directory);
    return directory;
  }

  const siblingRoot = (root: string): WorktreeRootResolution => ({
    root,
    tier: WORKTREE_ROOT_TIERS.SIBLING,
  });
  const explicitRoot = (root: string): WorktreeRootResolution => ({
    root,
    tier: WORKTREE_ROOT_TIERS.EXPLICIT,
  });

  test("an explicit root scopes new bare-name directories by repository", async () => {
    const parent = await makeDirectory("explicit-bare-name");
    const root = path.join(parent, "worktrees");
    await fs.mkdir(root);
    const repoA = path.join(parent, "repo-a");
    const repoB = path.join(parent, "repo-b");
    const commonA = path.join(repoA, ".git");
    const commonB = path.join(repoB, ".git");
    const plannedPath = async (source: string, common: string) => {
      const result = await resolveWorktreeDirectory(
        source,
        "bug-fix",
        [],
        common,
        explicitRoot(root)
      );
      assert.strictEqual(result.kind, WORKTREE_DIRECTORY_KINDS.PLANNED);
      return result.kind === WORKTREE_DIRECTORY_KINDS.PLANNED
        ? result.path
        : "";
    };

    const pathA = await plannedPath(repoA, commonA);
    const pathB = await plannedPath(repoB, commonB);
    assert.match(
      path.relative(root, pathA),
      new RegExp(`^repo-a-[0-9a-f]{12}\\${path.sep}bug-fix$`)
    );
    assert.match(
      path.relative(root, pathB),
      new RegExp(`^repo-b-[0-9a-f]{12}\\${path.sep}bug-fix$`)
    );
    // Another repository's directory at the old unscoped location no longer blocks this one.
    await fs.mkdir(path.join(root, "bug-fix"));
    assert.strictEqual(await plannedPath(repoB, commonB), pathB);
    // A linked worktree of repo A plans the same directory as its main checkout.
    assert.strictEqual(
      await plannedPath(path.join(parent, "repo-a-linked"), commonA),
      pathA
    );

    // A worktree this repository already registered at `<root>/bug-fix` is still found.
    const legacy = path.join(root, "bug-fix");
    const existing = await resolveWorktreeDirectory(
      repoA,
      "bug-fix",
      [
        {
          worktreePath: legacy,
          headCommit: "abc",
          branchName: "bug-fix",
          detached: false,
          bare: false,
        },
      ],
      commonA,
      explicitRoot(root)
    );
    assert.strictEqual(existing.kind, WORKTREE_DIRECTORY_KINDS.EXISTING);
    if (existing.kind === WORKTREE_DIRECTORY_KINDS.EXISTING)
      assert.strictEqual(existing.entry.worktreePath, legacy);
  });

  test("resolves named directory aliases, ambiguity, and planned paths", async () => {
    const parent = await makeDirectory("named-directories");
    const source = path.join(parent, "repo");
    const root = path.join(parent, "worktrees");
    await fs.mkdir(source);
    await fs.mkdir(root);
    const common = path.join(source, ".git");
    const exact = path.join(root, "bug-fix");
    const namedHash = path.join(
      root,
      createWorktreeDirectoryName("bug-fix", common, {
        kind: WORKTREE_IDENTITY_KINDS.NAMED,
        branchRef: "bug-fix",
      })
    );
    const entry = (worktreePath: string): GitWorktreeEntry => ({
      worktreePath,
      headCommit: "abc",
      branchName: "old",
      detached: false,
      bare: false,
    });
    for (const candidate of [exact, namedHash]) {
      const result = await resolveWorktreeDirectory(
        source,
        "bug-fix",
        [entry(candidate)],
        common,
        siblingRoot(root)
      );
      assert.strictEqual(result.kind, WORKTREE_DIRECTORY_KINDS.EXISTING);
      if (result.kind === WORKTREE_DIRECTORY_KINDS.EXISTING)
        assert.strictEqual(result.entry.worktreePath, candidate);
    }
    await assert.rejects(
      resolveWorktreeDirectory(
        source,
        "bug-fix",
        [entry(exact), entry(namedHash)],
        common,
        siblingRoot(root)
      ),
      /matches multiple registered worktrees/
    );
    const planned = await resolveWorktreeDirectory(
      source,
      "bug-fix",
      [],
      common,
      siblingRoot(root)
    );
    assert.deepStrictEqual(planned, {
      kind: WORKTREE_DIRECTORY_KINDS.PLANNED,
      path: exact,
    });
    for (const invalid of [".", "..", "a:b", "trailing."]) {
      await assert.rejects(
        resolveWorktreeDirectory(
          source,
          invalid,
          [],
          common,
          siblingRoot(root)
        ),
        new RegExp(`Directory "${invalid.replace(/\./g, "\\.")}"`)
      );
    }
  });

  test("bare names do not match the main checkout from a linked worktree", async () => {
    const parent = await makeDirectory("main-checkout-match");
    const main = path.join(parent, "main-checkout");
    const linked = path.join(parent, "linked-checkout");
    const root = path.join(parent, "worktrees");
    await fs.mkdir(root);
    execFileSync("git", ["init", "-b", "main", main], { stdio: "ignore" });
    execFileSync("git", [
      "-C",
      main,
      "config",
      "user.email",
      "test@example.com",
    ]);
    execFileSync("git", ["-C", main, "config", "user.name", "Test"]);
    await fs.writeFile(path.join(main, "README.md"), "main\n");
    execFileSync("git", ["-C", main, "add", "README.md"]);
    execFileSync("git", ["-C", main, "commit", "-m", "initial"], {
      stdio: "ignore",
    });
    execFileSync(
      "git",
      ["-C", main, "worktree", "add", "-b", "feature", linked],
      { stdio: "ignore" }
    );

    const common = await gitCommonDir(linked);
    assert.ok(common);
    const result = await resolveWorktreeDirectory(
      linked,
      path.basename(main),
      await listWorktrees(linked),
      common!,
      siblingRoot(root)
    );

    assert.deepStrictEqual(result, {
      kind: WORKTREE_DIRECTORY_KINDS.PLANNED,
      path: path.join(root, path.basename(main)),
    });
  });

  test("rejects unsafe and prunable directory paths", async () => {
    const parent = await makeDirectory("directory-paths");
    const source = path.join(parent, "repo");
    const root = path.join(parent, "worktrees");
    const common = path.join(source, ".git");
    const existing = path.join(parent, "unregistered");
    await fs.mkdir(source);
    await fs.mkdir(root);
    await fs.mkdir(existing);
    await assert.rejects(
      resolveWorktreeDirectory(source, existing, [], common, siblingRoot(root)),
      /not a registered worktree/
    );
    await assert.rejects(
      resolveWorktreeDirectory(
        source,
        "relative/path",
        [],
        common,
        siblingRoot(root)
      ),
      /absolute path/
    );
    await assert.rejects(
      resolveWorktreeDirectory(
        source,
        "stale",
        [
          {
            worktreePath: path.join(root, "stale"),
            headCommit: "abc",
            branchName: "old",
            detached: false,
            bare: false,
            prunable: true,
          },
        ],
        common,
        siblingRoot(root)
      ),
      /Repair or Prune/
    );
  });

  test("resolves explicit, sibling, and filesystem-fallback roots", async () => {
    const parent = await makeDirectory("roots");
    const source = path.join(parent, "repo");
    await fs.mkdir(source);
    const home = path.join(parent, "home");
    await fs.mkdir(home);

    assert.strictEqual(
      (
        await resolveWorktreeRoot({
          sourceCheckoutRoot: source,
          explicitRoot: "~/configured",
          homeDirectory: home,
        })
      ).tier,
      "explicit"
    );
    assert.strictEqual(
      (await fs.stat(path.join(home, "configured"))).isDirectory(),
      true
    );

    const sibling = await resolveWorktreeRoot({ sourceCheckoutRoot: source });
    assert.strictEqual(sibling.tier, "sibling");
    assert.strictEqual(sibling.root, path.join(parent, "repo.worktrees"));

    const calls: string[] = [];
    const fallback = await resolveWorktreeRoot({
      sourceCheckoutRoot: source,
      homeDirectory: home,
      commonDirectory: path.join(source, ".git"),
      createDirectory: async (root) => {
        calls.push(root);
        if (root.endsWith("repo.worktrees")) {
          const error = new Error("read-only") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        await fs.mkdir(root, { recursive: true });
      },
    });
    assert.strictEqual(fallback.tier, "fallback");
    assert.strictEqual(calls.length, 2);
    assert.ok(
      fallback.root.startsWith(path.join(home, ".ctrlyoke", "worktrees"))
    );
  });

  test("keeps the lexical path when not even the drive root exists", async function () {
    // An unmounted drive (a cloud drive that has not mounted yet) used to
    // throw `realpath 'Z:\'` out of worktree setup.
    if (process.platform !== "win32") this.skip();
    let unmounted: string | undefined;
    for (const letter of "ZYXWVUTSRQPONMLKJIHG") {
      const root = `${letter}:\\`;
      try {
        await fs.stat(root);
      } catch {
        unmounted = root;
        break;
      }
    }
    if (!unmounted) this.skip();
    const candidate = path.join(unmounted, "My Drive", "Legal");
    assert.strictEqual(
      await resolveThroughNearestExistingAncestor(candidate),
      path.normalize(candidate)
    );
  });

  test("never falls through an invalid explicit root", async () => {
    const parent = await makeDirectory("explicit");
    const source = path.join(parent, "repo");
    await fs.mkdir(source);
    await assert.rejects(
      resolveWorktreeRoot({
        sourceCheckoutRoot: source,
        explicitRoot: "relative",
      }),
      /absolute path or begin with ~/
    );
  });

  test("enforces symlink-aware placement guards", async () => {
    const parent = await makeDirectory("guards");
    const source = path.join(parent, "repo");
    await fs.mkdir(source);
    const root = path.join(parent, "repo.worktrees");
    await fs.mkdir(root);

    await assert.rejects(
      assertWorktreePlacement({
        sourceCheckoutRoot: source,
        worktreeRoot: source,
      }),
      /inside the source checkout/
    );
    await assert.rejects(
      assertWorktreePlacement({
        sourceCheckoutRoot: source,
        worktreeRoot: path.join(source, "nested"),
      }),
      /inside the source checkout/
    );
    await assert.rejects(
      assertWorktreePlacement({
        sourceCheckoutRoot: source,
        worktreeRoot: path.join(parent, "outer", "existing", "nested"),
        discoveredWorktrees: [
          {
            worktreePath: path.join(parent, "outer", "existing"),
            headCommit: "abc",
            detached: true,
            bare: false,
          },
        ],
      }),
      /existing worktree/
    );
    await assert.rejects(
      assertWorktreePlacement({
        sourceCheckoutRoot: source,
        worktreeRoot: root,
        worktreePath: path.join(parent, "escape"),
      }),
      /inside its resolved root/
    );
  });

  test("accepts a multi-root monorepo and refuses the other shapes", async () => {
    const parent = await makeDirectory("eligibility");
    const repoRoot = path.join(parent, "mono");
    await fs.mkdir(repoRoot);
    execFileSync("git", ["init", repoRoot], { stdio: "ignore" });
    const first = path.join(repoRoot, "frontend");
    const second = path.join(repoRoot, "backend");
    await fs.mkdir(first);
    await fs.mkdir(second);
    const folder = (name: string, fsPath: string): ResolverWorkspaceFolder => ({
      name,
      fsPath,
    });

    const accepted = await evaluateWorkspaceEligibility([
      folder("frontend", first),
      folder("backend", second),
    ]);
    assert.strictEqual(accepted.eligible, true);

    const other = path.join(parent, "other");
    await fs.mkdir(other);
    execFileSync("git", ["init", other], { stdio: "ignore" });
    assert.strictEqual(
      (
        await evaluateWorkspaceEligibility([
          folder("mono", repoRoot),
          folder("other", other),
        ])
      ).eligible,
      false
    );
    assert.strictEqual(
      (
        await evaluateWorkspaceEligibility([
          folder("docs", path.join(parent, "docs")),
        ])
      ).eligible,
      false
    );
    const outside = path.join(parent, "outside");
    await fs.mkdir(outside);
    assert.strictEqual(
      (
        await evaluateWorkspaceEligibility([
          folder("frontend", first),
          folder("outside", outside),
        ])
      ).eligible,
      false
    );
  });

  test("uses a bounded safe name and validates branches semantically", async () => {
    assert.strictEqual(
      slugifyWorktreeName("  C résumé / a\\b  "),
      "c-resume-a-b"
    );
    const name = createWorktreeDirectoryName(
      "feature/with a very long readable name that must be bounded",
      "/repo/.git",
      { kind: WORKTREE_IDENTITY_KINDS.NAMED, branchRef: "feature/../../escape" }
    );
    assert.match(name, /^[a-z0-9-]+-[0-9a-f]{12}$/);
    assert.ok(!name.includes("/"));
    assert.ok(name.length <= 53);
    await validateWorktreeBranchName("feature/safe");
    await validateWorktreeBranchName("auto");
    await assert.rejects(
      validateWorktreeBranchName("../escape"),
      /Invalid branch name/
    );
    await assert.rejects(validateWorktreeBranchName(""), /Invalid branch name/);
    await assert.rejects(
      validateWorktreeBranchName("-bad"),
      /Invalid branch name/
    );
  });
});
