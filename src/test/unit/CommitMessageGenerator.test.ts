import * as assert from "assert";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { promisify } from "util";
import {
  buildCommitWorkflowOverrides,
  CommitMessageGenerator,
  CommitMessageGenerationError,
  MAX_DIFF_BYTES,
} from "../../git/CommitMessageGenerator";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  CTRLYOKE_MCP_MODES,
  MCP_SKILL_NAMES,
  PERMISSION_MODES,
} from "../../types/DashboardConstants";
import type {
  McpServerConfig,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";

const execFileAsync = promisify(execFile);

suite("CommitMessageGenerator", () => {
  test("carries the persisted run address on generation errors", () => {
    const workflowKey =
      "commit-message-generation-20260824-120000" as WorkflowKey;
    const runRef = "run-20260824-120000" as RunRef;
    const error = new CommitMessageGenerationError(
      "generation failed",
      workflowKey,
      runRef
    );

    assert.strictEqual(error.message, "generation failed");
    assert.strictEqual(error.workflowKey, workflowKey);
    assert.strictEqual(error.runRef, runRef);
    assert.strictEqual(error.name, "CommitMessageGenerationError");
  });

  test("forces its one-shot workflow to headless mode", () => {
    const mcpServer: McpServerConfig = {
      id: "ctrlyoke-commit",
      command: "node",
      args: ["mcp-server.js"],
    };

    const overrides = buildCommitWorkflowOverrides(
      HARNESS_IDS.OPENCODE_CLI,
      "test-model",
      mcpServer,
      CTRLYOKE_MCP_MODES.NATIVE
    );

    assert.strictEqual(overrides.executionMode, EXECUTION_MODES.HEADLESS);
    assert.strictEqual(overrides.resumeSession, false);
    assert.strictEqual(overrides.worktree, false);
    assert.strictEqual(overrides.harness, HARNESS_IDS.OPENCODE_CLI);
    assert.strictEqual(overrides.model, "test-model");
    assert.deepStrictEqual(overrides.mcpServers, [mcpServer]);
    assert.strictEqual(overrides.agent, null);
    assert.strictEqual(overrides.skills, null);
    assert.strictEqual(overrides.additionalArgs, null);
    assert.deepStrictEqual(overrides.toolPermissions, {
      mode: PERMISSION_MODES.ALLOW_ALL,
      allowedTools: [],
      deniedTools: [],
    });
    assert.strictEqual(overrides.hooks, null);
  });

  test("uses the commit-message skill in skill mode", () => {
    const overrides = buildCommitWorkflowOverrides(
      HARNESS_IDS.CLAUDE_CLI,
      undefined,
      undefined,
      CTRLYOKE_MCP_MODES.SKILL
    );

    assert.strictEqual(overrides.mcpServers, null);
    assert.deepStrictEqual(overrides.skills, [MCP_SKILL_NAMES.COMMIT_MESSAGE]);
  });

  test("explicitly disables inherited MCP servers without capture", () => {
    const overrides = buildCommitWorkflowOverrides(
      HARNESS_IDS.COPILOT_CLI,
      undefined,
      undefined
    );

    assert.strictEqual(overrides.executionMode, EXECUTION_MODES.HEADLESS);
    assert.strictEqual(overrides.worktree, false);
    assert.strictEqual(overrides.mcpServers, null);
  });

  test("returns a truncated staged diff larger than the exec buffer", async () => {
    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-large-staged-diff-")
    );
    try {
      const runGit = async (args: string[]): Promise<void> => {
        await execFileAsync("git", args, { cwd, encoding: "utf8" });
      };

      await runGit(["init"]);
      await runGit(["config", "user.email", "test@example.com"]);
      await runGit(["config", "user.name", "CtrlYoke Test"]);
      await runGit(["config", "commit.gpgsign", "false"]);
      await fs.writeFile(path.join(cwd, "large.txt"), "initial\n");
      await fs.writeFile(path.join(cwd, "unrelated.txt"), "original\n");
      await runGit(["add", "."]);
      await runGit(["commit", "-m", "initial"]);

      await fs.writeFile(
        path.join(cwd, "large.txt"),
        "staged line with enough content to exceed one mebibyte\n".repeat(
          30_000
        )
      );
      await runGit(["add", "large.txt"]);
      await fs.writeFile(
        path.join(cwd, "unrelated.txt"),
        "small unstaged edit\n"
      );

      const { stdout: stagedDiff } = await execFileAsync(
        "git",
        ["diff", "--cached"],
        { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
      );
      assert.ok(Buffer.byteLength(stagedDiff, "utf8") > 1024 * 1024);

      const result = await new CommitMessageGenerator().getDiff(cwd);

      assert.ok(result);
      assert.strictEqual(result.staged, true);
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.includesUntrackedFiles, false);
      assert.ok(Buffer.byteLength(result.diff, "utf8") >= MAX_DIFF_BYTES - 1);
      assert.ok(result.diff.includes("staged line"));
      assert.ok(!result.diff.includes("small unstaged edit"));
    } finally {
      await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }).catch(
        () => {}
      );
    }
  });

  test("does not treat git execution failures as an empty staged diff", async () => {
    const cwd = path.join(os.tmpdir(), `ctrlyoke-missing-git-dir-${Date.now()}`);

    await assert.rejects(new CommitMessageGenerator().getDiff(cwd));
  });
});
