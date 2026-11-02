import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, suiteSetup, suiteTeardown, setup, teardown, test } from "mocha";
import { RunChangesPlacer } from "../../core/orchestration/RunChangesPlacer";
import { WorktreeManager } from "../../core/orchestration/WorktreeManager";
import { execGit, setGitTimeoutOverridesForTests } from "../../utils/GitUtils";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("RunChangesPlacer", function () {
  let temp: string;
  let workspace: string;
  let patchFile: string;
  let baseCommit: string;
  let restoreGitTimeouts: (() => void) | undefined;

  this.timeout(120_000);
  suiteSetup(() => {
    restoreGitTimeouts = setGitTimeoutOverridesForTests({
      shortTimeoutMs: 60_000,
      mutationTimeoutMs: 60_000,
    });
  });
  suiteTeardown(() => restoreGitTimeouts?.());

  setup(async () => {
    temp = makeTempDir("ctrlyoke-run-changes-");
    workspace = path.join(temp, "repo");
    await fs.mkdir(workspace, { recursive: true });
    await execGit(["init"], { cwd: workspace });
    await execGit(["config", "user.email", "test@example.com"], {
      cwd: workspace,
    });
    await execGit(["config", "user.name", "Test"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "tracked.txt"), "base\n");
    await execGit(["add", "tracked.txt"], { cwd: workspace });
    await execGit(["commit", "-m", "base"], { cwd: workspace });
    baseCommit = (
      await execGit(["rev-parse", "HEAD"], { cwd: workspace })
    ).stdout.trim();
    await fs.writeFile(path.join(workspace, "tracked.txt"), "changed\n");
    const patch = await execGit(["diff", "--binary"], { cwd: workspace });
    patchFile = path.join(temp, "changes.patch");
    await fs.writeFile(patchFile, patch.stdout);
    await execGit(["reset", "--hard", baseCommit], { cwd: workspace });
  });

  teardown(async () => removeTempDir(temp));

  test("creates a managed worktree at base and applies the patch", async () => {
    const result = await placer().place(options("worktree", "managed"));
    assert.strictEqual(result.applied, true);
    assert.ok(result.worktreePath);
    assert.strictEqual(
      (
        await fs.readFile(
          path.join(result.worktreePath!, "tracked.txt"),
          "utf8"
        )
      ).replace(/\r\n/g, "\n"),
      "changed\n"
    );
    assert.ok(result.worktreeRuntime?.worktreePath === result.worktreePath);
    assert.strictEqual(
      (await fs.readFile(path.join(workspace, "tracked.txt"), "utf8")).replace(
        /\r\n/g,
        "\n"
      ),
      "base\n"
    );
  });

  test("applies to a clean checkout at base", async () => {
    const result = await placer().place(options("checkout", "none"));
    assert.strictEqual(result.applied, true);
    assert.strictEqual(
      (await fs.readFile(path.join(workspace, "tracked.txt"), "utf8")).replace(
        /\r\n/g,
        "\n"
      ),
      "changed\n"
    );
  });

  test("rejects dirty checkout with recovery guidance", async () => {
    await fs.writeFile(path.join(workspace, "tracked.txt"), "dirty\n");
    await assert.rejects(
      placer().place(options("checkout", "none")),
      /--changes worktree.*--changes skip/
    );
    assert.strictEqual(
      await fs.readFile(path.join(workspace, "tracked.txt"), "utf8"),
      "dirty\n"
    );
  });

  test("skip warns when the exported patch is not already present", async () => {
    const result = await placer().place(options("skip", "none"));
    assert.strictEqual(result.applied, false);
    assert.match(result.warning ?? "", /does not appear to contain/);
  });

  test("missing base commit produces a view-only fetch instruction", async () => {
    const result = await placer().place({
      ...options("checkout", "none"),
      baseCommit: "deadbeef".repeat(5),
    });
    assert.strictEqual(result.applied, false);
    assert.match(result.warning ?? "", /push\/fetch commit deadbee/);
  });

  test("a bundle without a patch requires explicit skip to continue", async () => {
    const optionsWithoutPatch = {
      ...options("worktree", "managed"),
      patchPath: undefined,
    };
    const result = await placer().place(optionsWithoutPatch);
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.canContinue, false);
    assert.match(result.warning ?? "", /--changes skip/);
    const worktrees = (
      await execGit(["worktree", "list", "--porcelain"], { cwd: workspace })
    ).stdout;
    assert.strictEqual((worktrees.match(/^worktree /gm) ?? []).length, 1);
  });

  test("a rejected patch restores the checkout and removes its new worktree", async () => {
    await fs.writeFile(
      patchFile,
      "diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-not-the-base\n+changed\n"
    );
    const checkoutResult = await placer().place(options("checkout", "none"));
    assert.strictEqual(checkoutResult.applied, false);
    assert.strictEqual(
      (
        await execGit(["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: workspace,
        })
      ).stdout.trim(),
      ""
    );
    assert.strictEqual(
      (await execGit(["diff", "--cached"], { cwd: workspace })).stdout.trim(),
      ""
    );
    const result = await placer().place(options("worktree", "managed"));
    assert.strictEqual(result.applied, false);
    assert.match(result.warning ?? "", /view-only/);
    assert.strictEqual(
      (await fs.readFile(path.join(workspace, "tracked.txt"), "utf8")).replace(
        /\r\n/g,
        "\n"
      ),
      "base\n"
    );
    const worktrees = (
      await execGit(["worktree", "list", "--porcelain"], { cwd: workspace })
    ).stdout;
    assert.strictEqual((worktrees.match(/^worktree /gm) ?? []).length, 1);
  });

  function placer(): RunChangesPlacer {
    return new RunChangesPlacer(
      new WorktreeManager({ worktreeRoot: path.join(temp, "managed") })
    );
  }

  function options(
    target: "worktree" | "checkout" | "skip",
    worktreeMode: "managed" | "none"
  ) {
    return {
      workspaceRoot: workspace,
      patchPath: patchFile,
      baseCommit,
      target,
      worktreeMode,
      workflowKey: "imported-workflow" as WorkflowKey,
      runRef: "run-2026-11-01T00-00-00-000Z" as RunRef,
      workflowName: "Imported run",
    };
  }
});
