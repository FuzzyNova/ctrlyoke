import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { CliAdapter } from "../platform/CliAdapter";
import type { ResolvedCliConfig } from "../platform/CliAdapter";
import { IntegrationFactory } from "../core/IntegrationFactory";
import { CliIntegration } from "../core/harness/CliIntegration";
import { WorkflowInstance } from "../core/WorkflowInstance";
import { Log } from "../utils/Log";
import { EXECUTION_MODES, PERMISSION_MODES } from "../types/DashboardConstants";
import type { HarnessId } from "../types/DashboardConstants";
import { isScriptStep, type McpServerConfig } from "../types/CtrlYokeTypes";

const execFileAsync = promisify(execFile);
// ~200k tokens at ~4 bytes/token; leaves room for system prompt and instructions.
// The harness handles actual context-window limits natively — this is just a safeguard
// against truly pathological diffs (e.g. generated files, minified bundles).
const MAX_DIFF_BYTES = 750 * 1024;

export interface DiffResult {
  diff: string;
  staged: boolean;
  truncated: boolean;
  commands: string[];
  includesUntrackedFiles: boolean;
}

export interface CommitResult {
  message: string;
  staged: boolean;
  truncated: boolean;
}

export class CommitMessageGenerator {
  async getDiff(cwd: string): Promise<DiffResult | null> {
    // Primary: staged changes
    const stagedCommand = "git diff --cached";
    try {
      const { stdout: stagedDiff } = await execFileAsync(
        "git",
        ["diff", "--cached"],
        { cwd, encoding: "utf8" }
      );
      if (stagedDiff.trim()) {
        const truncated = stagedDiff.length > MAX_DIFF_BYTES;
        return {
          diff: stagedDiff.slice(0, MAX_DIFF_BYTES),
          staged: true,
          truncated,
          commands: [stagedCommand],
          includesUntrackedFiles: false,
        };
      }
    } catch {
      // git not available or not a repo — fall through
    }

    // Fallback: unstaged tracked + untracked files
    const parts: string[] = [];
    const commands = [stagedCommand, "git diff"];
    let includesUntrackedFiles = false;
    try {
      const { stdout: trackedDiff } = await execFileAsync("git", ["diff"], {
        cwd,
        encoding: "utf8",
      });
      if (trackedDiff.trim()) {
        parts.push(trackedDiff);
      }
    } catch {
      // ignore
    }

    try {
      commands.push("git ls-files --others --exclude-standard");
      const { stdout: untrackedOut } = await execFileAsync(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        { cwd, encoding: "utf8" }
      );
      const untrackedFiles = untrackedOut.trim().split("\n").filter(Boolean);
      includesUntrackedFiles = untrackedFiles.length > 0;
      for (const filePath of untrackedFiles) {
        try {
          const content = await fs.readFile(path.join(cwd, filePath), "utf8");
          const lines = content.split("\n");
          parts.push(
            `diff --git a/${filePath} b/${filePath}\n` +
              `new file mode 100644\n` +
              `--- /dev/null\n` +
              `+++ b/${filePath}\n` +
              `@@ -0,0 +1,${lines.length} @@\n` +
              lines.map((l) => `+${l}`).join("\n")
          );
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // ignore
    }

    const combined = parts.join("\n");
    if (!combined.trim()) {
      return null;
    }
    const truncated = combined.length > MAX_DIFF_BYTES;
    return {
      diff: combined.slice(0, MAX_DIFF_BYTES),
      staged: false,
      truncated,
      commands,
      includesUntrackedFiles,
    };
  }

  async generateMessage(
    diff: string,
    cwd: string,
    token?: AbortSignal,
    instructions?: string
  ): Promise<{ message: string; prompt: string; cliCommand?: string }> {
    const rawHarness =
      ConfigurationUtils.getCommitHarness() ||
      ConfigurationUtils.getIntegrationMode();
    const harness = rawHarness as HarnessId;
    const model = ConfigurationUtils.getCommitModel() || undefined;
    const commitPrompt = ConfigurationUtils.getCommitPrompt();

    const instructionsSection = instructions?.trim()
      ? `\n\nUser's starting draft or instructions — use as a guide for the message:\n${instructions.trim()}`
      : "";

    const config: ResolvedCliConfig = {
      harness,
      model,
      cwd,
      permissionMode: PERMISSION_MODES.ALLOW_ALL,
      allowedTools: [],
      deniedTools: [],
      additionalDirs: [],
      vars: {},
      resumeSession: false,
      timeout: 120_000,
      scriptTimeout: 30_000,
      verbose: false,
      quiet: true,
      json: false,
      color: false,
      cliExecutionMode: EXECUTION_MODES.HEADLESS,
    };

    const platform = new CliAdapter(config);

    // Probe for the MCP server so we can capture the commit message via a structured tool call
    // rather than parsing prose response text. This eliminates "I'm going to read the prompt..."
    // preamble from polluting the commit message.
    const mcpServerPath = path.join(
      platform.getExtensionPath(),
      "out",
      "mcp-server.js"
    );
    const tempDir = path.join(
      cwd,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR
    );
    const commitOutputPath = path.join(
      tempDir,
      `commit-output-${Date.now()}.txt`
    );

    let useMcpCapture = false;
    try {
      await fs.access(mcpServerPath);
      useMcpCapture = true;
    } catch {
      // MCP server not found (e.g. dev environment without a build) — fall back to text extraction
    }

    if (useMcpCapture) {
      await fs.mkdir(tempDir, { recursive: true });
    }

    // When MCP capture is active, append a single instruction line telling the AI to use the tool.
    // The tool description already says "do not output as plain text", but an explicit instruction
    // in the prompt reinforces it and prevents the AI from outputting the message twice.
    const mcpInstruction = useMcpCapture
      ? "\n\nSubmit the commit message using the `ctrlyoke_submit_commit_message` tool. Do not output it as text."
      : "";
    const fullPrompt = `${commitPrompt}\n\n${diff}${instructionsSection}${mcpInstruction}`;

    const mcpServerConfig: McpServerConfig | undefined = useMcpCapture
      ? {
          id: "ctrlyoke-commit",
          command: "node",
          args: [mcpServerPath.replace(/\\/g, "/")],
          env: {
            CTRLYOKE_WORKSPACE: cwd.replace(/\\/g, "/"),
            CTRLYOKE_COMMIT_OUTPUT: commitOutputPath.replace(/\\/g, "/"),
          },
          autoApprove: true,
          // Deny all queue-management tools — the AI only needs submit_commit_message.
          deniedTools: [
            "ctrlyoke_queue_status",
            "ctrlyoke_append_queue",
            "ctrlyoke_capabilities",
            "ctrlyoke_read_output",
            "ctrlyoke_global_status",
          ],
        }
      : undefined;

    if (useMcpCapture && mcpServerConfig) {
      Log.debug(
        `[CommitMessageGenerator] MCP capture enabled for ${harness} via ${mcpServerConfig.id}`
      );
    }

    const factory = new IntegrationFactory(platform);
    const detectorIntegration = factory.createForExecution(harness);

    const instance = new WorkflowInstance(
      platform,
      undefined,
      factory,
      () => detectorIntegration,
      () => {},
      () => {},
      cwd
    );

    // Suppress all VS Code global settings that could bleed into this one-shot call:
    // mcpServers, agent, skills, additionalArgs, and hooks all have VS Code tier-3
    // fallbacks in PropertyResolver — null/empty sentinels stop resolution at tier-2.
    instance.loadPromptString(fullPrompt, {
      harness,
      model,
      resumeSession: false,
      mcpServers: mcpServerConfig ? [mcpServerConfig] : null,
      agent: null,
      skills: null,
      additionalArgs: null,
      hooks: null,
    });

    let abortListener: (() => void) | undefined;
    if (token) {
      abortListener = () => {
        void instance.stop();
      };
      token.addEventListener("abort", abortListener);
    }

    try {
      await instance.executeLoadedPromptFile(harness);
    } finally {
      if (token && abortListener) {
        token.removeEventListener("abort", abortListener);
      }
    }

    if (token?.aborted) {
      throw new Error("Commit message generation cancelled");
    }

    const cliCommand =
      detectorIntegration instanceof CliIntegration
        ? detectorIntegration.getLastSpawnedCommand()
        : undefined;

    // Primary path: read the commit message written by ctrlyoke_submit_commit_message.
    if (useMcpCapture) {
      let mcpMessage: string | undefined;
      try {
        const raw = await fs.readFile(commitOutputPath, "utf8");
        mcpMessage = raw.trim() || undefined;
      } catch {
        // Tool was not called — fall through to text extraction below
      }
      try {
        await fs.unlink(commitOutputPath);
      } catch {
        // Best-effort cleanup
      }
      if (mcpMessage) {
        Log.debug(
          `[CommitMessageGenerator] Captured commit message via MCP tool for ${harness}`
        );
        return { message: mcpMessage, prompt: fullPrompt, cliCommand };
      }

      Log.warn(
        `[CommitMessageGenerator] MCP capture was enabled for ${harness} but no commit message was submitted; falling back to response text extraction`
      );
    }

    // Fallback: extract from response text (MCP unavailable or tool not called).
    const state = instance.promptQueue.getState();
    const firstStep = state.steps[0];
    if (!firstStep || isScriptStep(firstStep)) {
      throw new Error(
        "Commit message generation failed: no prompt step executed"
      );
    }

    const rawResponse = firstStep._runtime?.responseText;
    if (!rawResponse?.trim()) {
      throw new Error("Commit message generation produced an empty response");
    }

    // Strip thinking blocks and file-operation annotations — for a commit message we
    // only want the pure assistant text, not reasoning traces or tool-call summaries.
    // These formats are defined by CliResponseTextExtractor.extractTextFromEvents().
    let responseText = rawResponse
      .replace(/\n?\[Thinking\][\s\S]*?\[\/Thinking\]/g, "")
      .replace(/\n\[(Created|Edited|Deleted):[^\]]*\]/g, "")
      .trim();

    // Strip wrapper code fences (e.g. ```commit\n...\n``` or ```\n...\n```)
    responseText = responseText
      .replace(/^```[a-z]*\n?([\s\S]*?)\n?```$/i, "$1")
      .trim();
    // Strip single-backtick wrapping
    responseText = responseText.replace(/^`([\s\S]*)`$/, "$1").trim();
    // Strip surrounding double or single quotes (only when the entire message is wrapped)
    responseText = responseText.replace(/^"([\s\S]*)"$/, "$1").trim();
    responseText = responseText.replace(/^'([\s\S]*)'$/, "$1").trim();

    return { message: responseText, prompt: fullPrompt, cliCommand };
  }

  async generate(
    cwd: string,
    token?: AbortSignal,
    instructions?: string
  ): Promise<CommitResult | null> {
    const diffResult = await this.getDiff(cwd);
    if (!diffResult) {
      return null;
    }

    const { message } = await this.generateMessage(
      diffResult.diff,
      cwd,
      token,
      instructions
    );
    return {
      message,
      staged: diffResult.staged,
      truncated: diffResult.truncated,
    };
  }
}
