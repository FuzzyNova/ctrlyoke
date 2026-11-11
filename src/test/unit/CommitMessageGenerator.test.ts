import * as assert from "assert";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { promisify } from "util";
import {
  buildCommitMessagePrompt,
  buildCommitSubmitInstruction,
  buildCommitWorkflowOverrides,
  CommitMessageGenerator,
  CommitMessageGenerationError,
  getCommitMessageStatePaths,
  getCommitSubmissionChannels,
  MAX_DIFF_BYTES,
  readSubmittedCommitMessage,
  submitThroughCommitChannels,
  type CommitSubmissionAttempt,
} from "../../git/CommitMessageGenerator";
import {
  MCP_STARTUP_RETRY_INSTRUCTION,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
} from "../../utils/McpToolDefinitions";
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
  COMMIT_SUBMISSION_CHANNELS,
  type CommitSubmissionChannel,
} from "../../types/DashboardConstants";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import type {
  McpServerConfig,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";

const execFileAsync = promisify(execFile);

suite("CommitMessageGenerator", () => {
  test("tries MCP first in native mode and picks the no-MCP channel by harness", () => {
    const { MCP_TOOL, FILE, SKILL_COMMAND } = COMMIT_SUBMISSION_CHANNELS;
    assert.deepStrictEqual(
      getCommitSubmissionChannels(CTRLYOKE_MCP_MODES.NATIVE, true),
      [MCP_TOOL, FILE]
    );
    assert.deepStrictEqual(
      getCommitSubmissionChannels(CTRLYOKE_MCP_MODES.NATIVE, false),
      [MCP_TOOL, SKILL_COMMAND]
    );
    assert.deepStrictEqual(
      getCommitSubmissionChannels(CTRLYOKE_MCP_MODES.SKILL, true),
      [FILE]
    );
    assert.deepStrictEqual(
      getCommitSubmissionChannels(CTRLYOKE_MCP_MODES.SKILL, false),
      [SKILL_COMMAND]
    );
  });

  test("only the harnesses verified to scope a write to one file use the file channel", () => {
    const scoped = Object.values(HARNESS_IDS).filter(
      (harness) =>
        IntegrationFactory.createCapabilityProvider(harness)
          .toolPermissionMapper.allowsSingleFileWrite === true
    );
    assert.deepStrictEqual(scoped.sort(), [
      HARNESS_IDS.ANTIGRAVITY_CLI,
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ]);
  });

  test("tells the model how to submit through each channel", () => {
    const outputPath = path.join(os.tmpdir(), "commit-output.txt");
    const mcp = buildCommitSubmitInstruction(
      COMMIT_SUBMISSION_CHANNELS.MCP_TOOL,
      outputPath
    );
    assert.ok(mcp.includes(`\`${MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME}\` tool`));
    assert.ok(mcp.includes(MCP_STARTUP_RETRY_INSTRUCTION));

    const file = buildCommitSubmitInstruction(
      COMMIT_SUBMISSION_CHANNELS.FILE,
      outputPath
    );
    assert.ok(file.includes(`\`${outputPath}\``));
    assert.ok(!file.includes(MCP_STARTUP_RETRY_INSTRUCTION));

    const skill = buildCommitSubmitInstruction(
      COMMIT_SUBMISSION_CHANNELS.SKILL_COMMAND,
      outputPath
    );
    assert.ok(skill.includes(MCP_SKILL_NAMES.COMMIT_MESSAGE));
    assert.ok(skill.includes(`--commit-output "${outputPath}"`));
  });

  test("reads only a non-empty submitted message", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cy-commit-output-"));
    try {
      const outputPath = path.join(dir, "commit-output.txt");
      assert.strictEqual(
        await readSubmittedCommitMessage(outputPath),
        undefined
      );
      await fs.writeFile(outputPath, "  \n");
      assert.strictEqual(
        await readSubmittedCommitMessage(outputPath),
        undefined
      );
      await fs.writeFile(outputPath, "\nfix: handle empty input\n");
      assert.strictEqual(
        await readSubmittedCommitMessage(outputPath),
        "fix: handle empty input"
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  suite("submitThroughCommitChannels", () => {
    const { MCP_TOOL, FILE } = COMMIT_SUBMISSION_CHANNELS;
    const channels = getCommitSubmissionChannels(
      CTRLYOKE_MCP_MODES.NATIVE,
      true
    );
    const workflowKey = "commit-message-generation-1" as WorkflowKey;
    const attemptFor = (
      channel: CommitSubmissionChannel,
      message?: string
    ): CommitSubmissionAttempt => ({
      channel,
      message,
      prompt: `prompt for ${channel}`,
      workflowKey,
      runRef: `run-${channel}` as RunRef,
    });

    test("returns the MCP submission without a second run", async () => {
      const tried: CommitSubmissionChannel[] = [];
      const result = await submitThroughCommitChannels(
        channels,
        HARNESS_IDS.OPENCODE_CLI,
        async (channel) => {
          tried.push(channel);
          return attemptFor(channel, "feat: from mcp");
        }
      );
      assert.deepStrictEqual(tried, [MCP_TOOL]);
      assert.strictEqual(result.message, "feat: from mcp");
    });

    test("falls back when the MCP run submits nothing", async () => {
      const tried: CommitSubmissionChannel[] = [];
      const result = await submitThroughCommitChannels(
        channels,
        HARNESS_IDS.OPENCODE_CLI,
        async (channel) => {
          tried.push(channel);
          return attemptFor(
            channel,
            channel === FILE ? "fix: from file" : undefined
          );
        }
      );
      assert.deepStrictEqual(tried, [MCP_TOOL, FILE]);
      assert.strictEqual(result.message, "fix: from file");
      assert.strictEqual(result.prompt, `prompt for ${FILE}`);
    });

    test("fails with the last run's address when no channel submits", async () => {
      await assert.rejects(
        submitThroughCommitChannels(
          getCommitSubmissionChannels(CTRLYOKE_MCP_MODES.NATIVE, false),
          HARNESS_IDS.QWEN_CLI,
          async (channel) => attemptFor(channel)
        ),
        (error: unknown) =>
          error instanceof CommitMessageGenerationError &&
          /never submitted a commit message/.test(error.message) &&
          error.message.includes(MCP_SKILL_NAMES.COMMIT_MESSAGE) &&
          error.workflowKey === workflowKey &&
          error.runRef === `run-${COMMIT_SUBMISSION_CHANNELS.SKILL_COMMAND}`
      );
    });

    test("does not fall back after a run that failed outright", async () => {
      const tried: CommitSubmissionChannel[] = [];
      await assert.rejects(
        submitThroughCommitChannels(
          channels,
          HARNESS_IDS.CODEX_CLI,
          async (channel) => {
            tried.push(channel);
            throw new CommitMessageGenerationError(
              "Commit message generation did not complete successfully"
            );
          }
        ),
        /did not complete successfully/
      );
      assert.deepStrictEqual(tried, [MCP_TOOL]);
    });

    test("stops before the fallback run when generation was cancelled", async () => {
      const controller = new AbortController();
      const tried: CommitSubmissionChannel[] = [];
      await assert.rejects(
        submitThroughCommitChannels(
          channels,
          HARNESS_IDS.CLAUDE_CLI,
          async (channel) => {
            tried.push(channel);
            controller.abort();
            return attemptFor(channel);
          },
          controller.signal
        ),
        /Commit message generation cancelled/
      );
      assert.deepStrictEqual(tried, [MCP_TOOL]);
    });
  });

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

  test("does not start a run when generation is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let instanceCreated = false;
    const generator = new CommitMessageGenerator({
      createWorkflowInstance() {
        instanceCreated = true;
        throw new Error("A cancelled generation must not create a run");
      },
    });

    await assert.rejects(
      () => generator.generateMessage("diff", process.cwd(), controller.signal),
      /Commit message generation cancelled/
    );
    assert.strictEqual(instanceCreated, false);
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

      await runGit(["config", "diff.external", `node "${externalDiffPath}"`]);
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
      COMMIT_SUBMISSION_CHANNELS.MCP_TOOL
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
      mode: PERMISSION_MODES.CUSTOM,
      allowedTools: [
        "read",
        "grep",
        "glob",
        "mcp__ctrlyoke-commit__submit_commit_message",
      ],
      deniedTools: ["shell", "write", "edit", "multiedit"],
    });
    assert.strictEqual(overrides.hooks, null);
  });

  test("allows writing only the output file on the file channel", () => {
    const outputPath = path.join(os.tmpdir(), "commit-output-file.txt");
    const overrides = buildCommitWorkflowOverrides(
      HARNESS_IDS.COPILOT_CLI,
      undefined,
      undefined,
      COMMIT_SUBMISSION_CHANNELS.FILE,
      outputPath
    );

    assert.strictEqual(overrides.mcpServers, null);
    assert.strictEqual(overrides.skills, null);
    // No write/edit deny: on harnesses where deny wins it would override the
    // single-file allow. Every other write is denied as not allowed.
    assert.deepStrictEqual(overrides.toolPermissions, {
      mode: PERMISSION_MODES.CUSTOM,
      allowedTools: ["read", "grep", "glob", `write(${outputPath})`],
      deniedTools: ["shell"],
    });
  });

  test("uses the commit-message skill on the skill-command channel", () => {
    const overrides = buildCommitWorkflowOverrides(
      HARNESS_IDS.CODEX_CLI,
      undefined,
      undefined,
      COMMIT_SUBMISSION_CHANNELS.SKILL_COMMAND
    );

    assert.strictEqual(overrides.mcpServers, null);
    assert.deepStrictEqual(overrides.skills, [MCP_SKILL_NAMES.COMMIT_MESSAGE]);
    assert.deepStrictEqual(overrides.toolPermissions, {
      mode: PERMISSION_MODES.CUSTOM,
      allowedTools: [
        "read",
        "grep",
        "glob",
        "shell(node:*--tool*submit_commit_message*)",
      ],
      deniedTools: ["write", "edit", "multiedit"],
    });
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

  test("reports a clear error when the working directory is outside a git repo", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-non-repo-"));
    try {
      await assert.rejects(
        new CommitMessageGenerator().getDiff(cwd),
        (error: unknown) =>
          error instanceof Error &&
          error.message === `Not a git repository: ${cwd}`
      );
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
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

  test("emits separate untracked file hunks with accurate line counts", async () => {
    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-commit-multiple-untracked-")
    );
    try {
      await execFileAsync("git", ["init"], { cwd });
      await fs.writeFile(path.join(cwd, "a.txt"), "one\ntwo\n");
      await fs.writeFile(path.join(cwd, "b.txt"), "three\n");

      const result = await new CommitMessageGenerator().getDiff(cwd);

      assert.ok(result);
      assert.match(result.diff, /(^|\n)diff --git a\/a\.txt b\/a\.txt\n/);
      assert.match(result.diff, /(^|\n)diff --git a\/b\.txt b\/b\.txt\n/);
      assert.match(result.diff, /@@ -0,0 \+1,2 @@\n\+one\n\+two\n/);
      assert.match(result.diff, /@@ -0,0 \+1,1 @@\n\+three\n/);
      assert.ok(!result.diff.split("\n").includes("+"), result.diff);
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

  test("marks an untracked file that lacks a trailing newline", async () => {
    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-commit-no-final-newline-")
    );
    try {
      await execFileAsync("git", ["init"], { cwd });
      await fs.writeFile(path.join(cwd, "no-newline.txt"), "single line");

      const result = await new CommitMessageGenerator().getDiff(cwd);

      assert.ok(result);
      assert.match(
        result.diff,
        /@@ -0,0 \+1,1 @@\n\+single line\n\\ No newline at end of file\n/
      );
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

  test("lists an empty untracked file without a hunk", async () => {
    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-commit-empty-untracked-")
    );
    try {
      await execFileAsync("git", ["init"], { cwd });
      await fs.writeFile(path.join(cwd, "empty.txt"), "");

      const result = await new CommitMessageGenerator().getDiff(cwd);

      assert.ok(result);
      assert.strictEqual(
        result.diff,
        "diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n"
      );
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
    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-commit-large-untracked-")
    );
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
