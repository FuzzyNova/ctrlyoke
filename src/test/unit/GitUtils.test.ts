import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test, setup, teardown } from "mocha";
import { gitRefExists } from "../../utils/GitUtils";

suite("GitUtils.gitRefExists", () => {
  let workspaceRoot: string;

  function runGit(args: string[]): string {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  }

  async function writeWorkspaceFile(
    relativePath: string,
    content: string
  ): Promise<void> {
    const absolutePath = path.join(workspaceRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fp-gitutils-"));
    runGit(["init"]);
    runGit(["config", "user.name", "ctrlyoke Tests"]);
    runGit(["config", "user.email", "ctrlyoke-tests@example.com"]);
    await writeWorkspaceFile("tracked.txt", "base\n");
    runGit(["add", "tracked.txt"]);
    runGit(["commit", "-m", "Initial commit"]);
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("reports the diff pseudo-ref as missing when the tree is clean", async () => {
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "diff"), {
      exists: false,
      message: "git diff not found",
    });
  });

  test("reports the diff pseudo-ref as present when the tree is dirty", async () => {
    await writeWorkspaceFile("tracked.txt", "changed\n");

    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "diff"), {
      exists: true,
    });
  });

  test("reports the staged pseudo-ref as missing when the index is empty", async () => {
    await writeWorkspaceFile("tracked.txt", "changed but unstaged\n");

    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "staged"), {
      exists: false,
      message: "staged changes not found",
    });
  });

  test("reports the staged pseudo-ref as present once changes are staged", async () => {
    await writeWorkspaceFile("tracked.txt", "changed\n");
    runGit(["add", "tracked.txt"]);

    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "staged"), {
      exists: true,
    });
  });

  test("resolves full and abbreviated commit hashes", async () => {
    const fullHash = runGit(["rev-parse", "HEAD"]);
    const shortHash = runGit(["rev-parse", "--short=8", "HEAD"]);

    assert.deepStrictEqual(await gitRefExists(workspaceRoot, fullHash), {
      exists: true,
    });
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, shortHash), {
      exists: true,
    });
  });

  test("reports an unknown commit hash as missing", async () => {
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "0".repeat(40)), {
      exists: false,
      message: "git context not found",
    });
  });

  test("reports an unrecognized ref as missing without invoking git", async () => {
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "stash:0"), {
      exists: false,
      message: "git context not found",
    });
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "not-a-ref"), {
      exists: false,
      message: "git context not found",
    });
  });

  test("swallows git failures and reports the ref as missing", async () => {
    const missingRoot = path.join(workspaceRoot, "does-not-exist");

    assert.deepStrictEqual(await gitRefExists(missingRoot, "diff"), {
      exists: false,
      message: "git context not found",
    });
  });
});
