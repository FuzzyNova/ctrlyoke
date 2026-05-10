import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { CliAdapter } from "../platform/CliAdapter";
import type { ResolvedCliConfig } from "../platform/CliAdapter";
import { IntegrationFactory } from "../flightpath/IntegrationFactory";
import { WorkflowInstance } from "../flightpath/WorkflowInstance";
import { EXECUTION_MODES } from "../types/DashboardConstants";
import type { HarnessId } from "../types/DashboardConstants";
import { isScriptStep } from "../types/FlightPathTypes";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 8 * 1024;

export interface DiffResult {
  diff: string;
  staged: boolean;
  truncated: boolean;
}

export interface CommitResult {
  message: string;
  staged: boolean;
  truncated: boolean;
}

export class CommitMessageGenerator {
  async getDiff(cwd: string): Promise<DiffResult | null> {
    // Primary: staged changes
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
        };
      }
    } catch {
      // git not available or not a repo — fall through
    }

    // Fallback: unstaged tracked + untracked files
    const parts: string[] = [];
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
      const { stdout: untrackedOut } = await execFileAsync(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        { cwd, encoding: "utf8" }
      );
      const untrackedFiles = untrackedOut.trim().split("\n").filter(Boolean);
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
    };
  }

  async generateMessage(
    diff: string,
    cwd: string,
    token?: AbortSignal
  ): Promise<string> {
    const rawHarness =
      ConfigurationUtils.getCommitHarness() ||
      ConfigurationUtils.getIntegrationMode();
    const harness = rawHarness as HarnessId;
    const model = ConfigurationUtils.getCommitModel() || undefined;
    const commitPrompt = ConfigurationUtils.getCommitPrompt();

    const fullPrompt = `${commitPrompt}\n\n${diff}`;

    const config: ResolvedCliConfig = {
      harness,
      model,
      cwd,
      timeout: 120_000,
      scriptTimeout: 30_000,
      allowedTools: [],
      deniedTools: [],
      allowAllTools: true,
      additionalDirs: [],
      vars: {},
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

    instance.loadPromptString(fullPrompt);

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

    const responseText = firstStep._runtime?.responseText;
    if (!responseText?.trim()) {
      throw new Error("Commit message generation produced an empty response");
    }

    return responseText.trim();
  }

  async generate(
    cwd: string,
    token?: AbortSignal
  ): Promise<CommitResult | null> {
    const diffResult = await this.getDiff(cwd);
    if (!diffResult) {
      return null;
    }

    const message = await this.generateMessage(diffResult.diff, cwd, token);
    return {
      message,
      staged: diffResult.staged,
      truncated: diffResult.truncated,
    };
  }
}
