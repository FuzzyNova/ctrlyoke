import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { CliAdapter } from "../platform/CliAdapter";
import type { ResolvedCliConfig } from "../platform/CliAdapter";
import { IntegrationFactory } from "../flightpath/IntegrationFactory";
import { WorkflowInstance } from "../flightpath/WorkflowInstance";
import { EXECUTION_MODES, PERMISSION_MODES } from "../types/DashboardConstants";
import type { HarnessId } from "../types/DashboardConstants";
import { isScriptStep } from "../types/FlightPathTypes";

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
  ): Promise<string> {
    const rawHarness =
      ConfigurationUtils.getCommitHarness() ||
      ConfigurationUtils.getIntegrationMode();
    const harness = rawHarness as HarnessId;
    const model = ConfigurationUtils.getCommitModel() || undefined;
    const commitPrompt = ConfigurationUtils.getCommitPrompt();

    const instructionsSection = instructions?.trim()
      ? `\n\nUser's starting draft or instructions — use as a guide for the message:\n${instructions.trim()}`
      : "";
    const fullPrompt = `${commitPrompt}\n\n${diff}${instructionsSection}`;

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
      mcpServers: null,
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

    return responseText;
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

    const message = await this.generateMessage(
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
