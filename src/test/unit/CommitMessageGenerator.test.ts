import * as assert from "assert";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { promisify } from "util";
import {
  buildCommitMessagePrompt,
  buildCommitWorkflowOverrides,
  CommitMessageGenerator,
  CommitMessageGenerationError,
  getCommitMessageStatePaths,
  MAX_DIFF_BYTES,
} from "../../git/CommitMessageGenerator";
import { parseSecretReferences } from "../../utils/SecretReferenceParser";
import {
  parseAtReferences,
  parseInlinePriorContextRefs,
} from "../../utils/FileReferenceParser";
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
  test("keeps commit state under state root while retaining repository cwd", () => {
    const repositoryRoot = path.join(os.tmpdir(), "repo-b");
    const stateRoot = path.join(os.tmpdir(), "workspace-state");

    assert.deepStrictEqual(
      getCommitMessageStatePaths(repositoryRoot, stateRoot),
      {
        cwd: repositoryRoot,
        stateRoot,
        tempDir: path.join(stateRoot, ".ctrlyoke", "temp"),
      }
    );
    assert.deepStrictEqual(getCommitMessageStatePaths(repositoryRoot), {
      cwd: repositoryRoot,
      stateRoot: repositoryRoot,
      tempDir: path.join(repositoryRoot, ".ctrlyoke", "temp"),
    });
  });

  test("keeps references inside a staged Markdown code block inert in the prompt", async () => {
    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-commit-prompt-fence-")
    );
    try {
      const runGit = async (args: string[]): Promise<void> => {
        await execFileAsync("git", args, { cwd, encoding: "utf8" });
      };

      await runGit(["init"]);
      await runGit(["config", "user.email", "test@example.com"]);
      await runGit(["config", "user.name", "CtrlYoke Test"]);
      await runGit(["config", "commit.gpgsign", "false"]);
      const markdown = [
        "# Added example",
        "",
        "```html",
        `<${"!DOCTYPE"} html>`,
        "<p>See @src/x.ts and $previous.</p>",
        "```",
        "",
      ].join("\n");
      await fs.writeFile(path.join(cwd, "README.md"), markdown);
      await runGit(["add", "README.md"]);

      const stagedDiff = await new CommitMessageGenerator().getDiff(cwd);
      assert.ok(stagedDiff?.staged);
      const prompt = buildCommitMessagePrompt(
        stagedDiff.diff,
        "Write a concise commit message."
      );

      assert.deepStrictEqual(parseSecretReferences(prompt), []);
      assert.deepStrictEqual(parseAtReferences(prompt), []);
      assert.deepStrictEqual(parseInlinePriorContextRefs(prompt), []);
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

  test("ignores diff.external while gathering commit-message diffs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cy-commit-ext-diff-"));
    try {
      const runGit = async (args: string[]): Promise<void> => {
        await execFileAsync("git", args, { cwd, encoding: "utf8" });
      };
      await runGit(["init"]);
      await runGit(["config", "user.email", "test@example.com"]);
      await runGit(["config", "user.name", "CtrlYoke Test"]);
      await fs.writeFile(path.join(cwd, "tracked.txt"), "base\n");
      const externalDiffPath = path.join(cwd, "external-diff.js");
      await fs.writeFile(
        externalDiffPath,
        'process.stdout.write("EXTERNAL-DIFF-TOOL OUTPUT\\n");\n',
        "utf8"
      );
      await runGit(["add", "."]);
      await runGit(["commit", "-m", "initial"]);

      await runGit([
        "config",
        "diff.external",
        `node "${externalDiffPath}"`,
      ]);
      await fs.writeFile(path.join(cwd, "tracked.txt"), "staged change\n");
      await runGit(["add", "tracked.txt"]);

      const generator = new CommitMessageGenerator();
      const stagedResult = await generator.getDiff(cwd);

      assert.ok(stagedResult);
      assert.ok(stagedResult.diff.includes("@@"), stagedResult.diff);
      assert.ok(
        !stagedResult.diff.includes("EXTERNAL-DIFF-TOOL OUTPUT"),
        stagedResult.diff
      );

      await runGit(["commit", "-m", "staged change"]);
      await fs.writeFile(path.join(cwd, "tracked.txt"), "unstaged change\n");
      const workingTreeResult = await generator.getDiff(cwd);
      assert.ok(workingTreeResult);
      assert.ok(workingTreeResult.diff.includes("@@"), workingTreeResult.diff);
      assert.ok(
        !workingTreeResult.diff.includes("EXTERNAL-DIFF-TOOL OUTPUT"),
        workingTreeResult.diff
      );

      await runGit(["add", "tracked.txt"]);
      await fs.writeFile(path.join(cwd, "tracked.txt"), "head diff change\n");
      const headDiffResult = await generator.getDiff(cwd, {
        includeUnstaged: true,
      });
      assert.ok(headDiffResult);
      assert.ok(headDiffResult.diff.includes("@@"), headDiffResult.diff);
      assert.ok(
        !headDiffResult.diff.includes("EXTERNAL-DIFF-TOOL OUTPUT"),
        headDiffResult.diff
      );
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

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
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

  test("does not treat git execution failures as an empty staged diff", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `ctrlyoke-missing-git-dir-${Date.now()}`
    );

    await assert.rejects(new CommitMessageGenerator().getDiff(cwd));
  });

  test("includes an untracked non-ASCII filename in the generated diff", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cy-commit-cafe-"));
    try {
      await execFileAsync("git", ["init"], { cwd });
      await execFileAsync("git", ["config", "user.name", "CtrlYoke Test"], {
        cwd,
      });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd,
      });
      await fs.writeFile(path.join(cwd, "café.txt"), "hello\n", "utf8");

      const diff = await new CommitMessageGenerator().getDiff(cwd);

      assert.ok(diff);
      assert.strictEqual(diff.staged, false);
      assert.strictEqual(diff.includesUntrackedFiles, true);
      assert.ok(diff.diff.includes("café.txt"));
      assert.ok(diff.diff.includes("+hello"));
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

  test("lists untracked files from the repository root when cwd is a subdirectory", async () => {
    const repositoryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-commit-subdirectory-")
    );
    const subdirectory = path.join(repositoryRoot, "sub");
    try {
      await fs.mkdir(subdirectory);
      await execFileAsync("git", ["init"], { cwd: repositoryRoot });
      await fs.writeFile(path.join(repositoryRoot, "root-new.txt"), "root\n");
      await fs.writeFile(path.join(subdirectory, "sub-new.txt"), "sub\n");

      const result = await new CommitMessageGenerator().getDiff(subdirectory);

      assert.ok(result);
      assert.strictEqual(result.includesUntrackedFiles, true);
      assert.ok(
        result.diff.includes("diff --git a/root-new.txt b/root-new.txt"),
        result.diff
      );
      assert.ok(
        result.diff.includes("diff --git a/sub/sub-new.txt b/sub/sub-new.txt"),
        result.diff
      );
    } finally {
      await fs
        .rm(repositoryRoot, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

  test("bounds an oversized untracked file by the diff budget", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cy-commit-large-untracked-"));
    try {
      await execFileAsync("git", ["init"], { cwd });
      await fs.writeFile(
        path.join(cwd, "large.txt"),
        "large untracked line\n".repeat(40_000)
      );

      const result = await new CommitMessageGenerator().getDiff(cwd);

      assert.ok(result);
      assert.strictEqual(result.truncated, true);
      assert.ok(Buffer.byteLength(result.diff, "utf8") <= MAX_DIFF_BYTES);
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

  test("represents untracked binary files without decoding their contents", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cy-commit-binary-"));
    try {
      await execFileAsync("git", ["init"], { cwd });
      const binaryContents = Buffer.from([0x41, 0x00, 0xff, 0x42]);
      await fs.writeFile(path.join(cwd, "image.bin"), binaryContents);

      const result = await new CommitMessageGenerator().getDiff(cwd);

      assert.ok(result);
      assert.ok(result.diff.includes("Binary file b/image.bin added"));
      assert.ok(!result.diff.includes(binaryContents.toString("utf8")));
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });
});
