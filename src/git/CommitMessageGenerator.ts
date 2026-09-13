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
import { WorkflowLineageRepository } from "../core/orchestration/WorkflowLineageRepository";
import { Log } from "../utils/Log";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { writeFileAtomic } from "../utils/AtomicFileUtils";
import {
  MCP_COMMIT_MESSAGE_DENIED_TOOL_NAMES,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
} from "../utils/McpToolDefinitions";
import {
  CLI_EVENT_TYPES,
  EXECUTION_MODES,
  CTRLYOKE_MCP_MODES,
  PERMISSION_MODES,
} from "../types/DashboardConstants";
import {
  MCP_SKILL_NAMES,
  type HarnessId,
  type CtrlYokeMcpMode,
} from "../types/DashboardConstants";
import {
  isScriptStep,
  type McpServerConfig,
  type PromptFile,
  type RunRef,
  type RunnerHostIdentity,
  type WorkflowKey,
} from "../types/CtrlYokeTypes";

const execFileAsync = promisify(execFile);
// ~200k tokens at ~4 bytes/token; leaves room for system prompt and instructions.
// The harness handles actual context-window limits natively — this is just a safeguard
// against truly pathological diffs (e.g. generated files, minified bundles).
const MAX_DIFF_BYTES = 750 * 1024;
const COMMIT_MESSAGE_MCP_TOOL = MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME;
const COMMIT_MESSAGE_LINEAGE_POINTER = ".commit-message-lineage.json";
const COMMIT_MESSAGE_WORKFLOW_NAME = "commit-message-generation";

async function readCommitMessageLineageKey(
  stateRoot: string
): Promise<WorkflowKey | undefined> {
  const pointerPath = path.join(
    WorkflowPaths.runsRoot(stateRoot),
    COMMIT_MESSAGE_LINEAGE_POINTER
  );
  try {
    const parsed = JSON.parse(await fs.readFile(pointerPath, "utf8")) as {
      workflowKey?: unknown;
    };
    if (typeof parsed.workflowKey !== "string") {
      return undefined;
    }

    WorkflowPaths.assertValidWorkflowKey(parsed.workflowKey);
    const descriptor = await new WorkflowLineageRepository().tryReadDescriptor(
      stateRoot,
      parsed.workflowKey
    );
    return descriptor?.workflowKey === parsed.workflowKey &&
      descriptor.isSystemGenerated
      ? parsed.workflowKey
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeCommitMessageLineageKey(
  stateRoot: string,
  workflowKey: WorkflowKey
): Promise<void> {
  const runsRoot = WorkflowPaths.runsRoot(stateRoot);
  await fs.mkdir(runsRoot, { recursive: true });
  await writeFileAtomic(
    path.join(runsRoot, COMMIT_MESSAGE_LINEAGE_POINTER),
    JSON.stringify({ workflowKey }, null, 2)
  );
}

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

export class CommitMessageGenerationError extends Error {
  constructor(
    message: string,
    public readonly workflowKey?: WorkflowKey,
    public readonly runRef?: RunRef,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CommitMessageGenerationError";
  }
}

export interface CommitMessageWorkflowHost {
  createWorkflowInstance(): WorkflowInstance;
}

export function buildCommitWorkflowOverrides(
  harness: HarnessId,
  model: string | undefined,
  mcpServerConfig: McpServerConfig | undefined,
  ctrlyokeMcpMode: CtrlYokeMcpMode = CTRLYOKE_MCP_MODES.NATIVE
): Partial<PromptFile> {
  return {
    harness,
    // Persist the resolved harness default as well as an explicit override so
    // the read-only dashboard view shows the model this run actually used when
    // commit.model is unset.
    model: model ?? ConfigurationUtils.getModelForHarness(harness),
    executionMode: EXECUTION_MODES.HEADLESS,
    resumeSession: false,
    // The diff this prompt reasons about is always computed against the real
    // workspace root, before this run is even loaded — a worktree here would
    // run the harness against a different directory than the diff describes.
    worktree: false,
    mcpServers: mcpServerConfig ? [mcpServerConfig] : null,
    agent: null,
    skills:
      ctrlyokeMcpMode === CTRLYOKE_MCP_MODES.SKILL
        ? [MCP_SKILL_NAMES.COMMIT_MESSAGE]
        : null,
    additionalArgs: null,
    hooks: null,
    toolPermissions: {
      mode: PERMISSION_MODES.ALLOW_ALL,
      allowedTools: [],
      deniedTools: [],
    },
  };
}

export class CommitMessageGenerator {
  constructor(
    private readonly workflowHost?: CommitMessageWorkflowHost,
    private readonly runnerHostIdentity?: RunnerHostIdentity
  ) {}

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
  ): Promise<{
    message: string;
    prompt: string;
    cliCommand?: string;
    workflowKey?: string;
    runRef?: string;
  }> {
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
    const ctrlyokeMcpMode = ConfigurationUtils.getCtrlYokeMcpMode();
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
    if (ctrlyokeMcpMode !== CTRLYOKE_MCP_MODES.SKILL) {
      try {
        await fs.access(mcpServerPath);
        useMcpCapture = true;
      } catch {
        // MCP server not found (e.g. dev environment without a build) — fall back to text extraction
      }
    }

    if (useMcpCapture) {
      await fs.mkdir(tempDir, { recursive: true });
    }

    // When MCP capture is active, append a single instruction line telling the AI to use the tool.
    // The tool description already says "do not output as plain text", but an explicit instruction
    // in the prompt reinforces it and prevents the AI from outputting the message twice.
    const mcpInstruction = useMcpCapture
      ? `\n\nSubmit the commit message using the \`${COMMIT_MESSAGE_MCP_TOOL}\` tool. Do not output it as text.`
      : "";
    // Fence the diff so its literal content (e.g. an added file's leading
    // `<!DOCTYPE html>`) is never mistaken for a ctrlyoke reference trigger
    // (`@`/`#`/`~`/`!`) by the context-expansion or secret-grant parsers,
    // which both treat fenced blocks as suppressed. An unfenced diff line
    // like `+<!DOCTYPE html>` previously parsed as an inline `!DOCTYPE`
    // secret grant and hard-failed the run at preflight.
    const fencedDiff = "```diff\n" + diff + "\n```";
    const fullPrompt = `${commitPrompt}\n\n${fencedDiff}${instructionsSection}${mcpInstruction}`;

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
          deniedTools: [...MCP_COMMIT_MESSAGE_DENIED_TOOL_NAMES],
        }
      : undefined;

    if (useMcpCapture && mcpServerConfig) {
      Log.debug(
        `[CommitMessageGenerator] MCP capture enabled for ${harness} via ${mcpServerConfig.id}`
      );
    }

    const stateRoot = cwd;
    const existingWorkflowKey = await readCommitMessageLineageKey(stateRoot);

    const factory = new IntegrationFactory(platform);
    const detectorIntegration = factory.createForExecution(harness);

    const instance =
      this.workflowHost?.createWorkflowInstance() ??
      new WorkflowInstance(
        platform,
        undefined,
        factory,
        () => detectorIntegration,
        () => {},
        () => {},
        cwd,
        true,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        this.runnerHostIdentity
      );
    instance.setMcpToolSkillContext({
      mcpServerPath,
      workspaceRoot: stateRoot,
      commitOutputPath,
    });

    // Force headless execution at the workflow tier and suppress VS Code globals
    // that could bleed into this one-shot call. PropertyResolver materializes
    // settings into resolved step properties, which take precedence over the
    // CliAdapter fallback used by CliIntegration.
    let capturedResponseText: string | undefined;
    let mcpToolCalled = false;
    let responseCompleteDisposable: { dispose(): void } | undefined;
    let streamingChunkDisposable: { dispose(): void } | undefined;
    let streamingEventsDisposable: { dispose(): void } | undefined;
    let abortListener: (() => void) | undefined;

    try {
      const workflowOverrides = buildCommitWorkflowOverrides(
        harness,
        model,
        mcpServerConfig,
        ctrlyokeMcpMode
      );
      await instance.loadPromptStringAsRun(
        fullPrompt,
        COMMIT_MESSAGE_WORKFLOW_NAME,
        workflowOverrides,
        {
          existingWorkflowKey,
          isSystemGenerated: existingWorkflowKey === undefined,
        }
      );

      // Commit generation runs with feature-owned overrides that are stronger
      // than the normal VS Code/global settings. Persist those values on the
      // draft before promotion so a later RUN_VIEW_LOADED snapshot gives the
      // read-only WorkflowPropertiesPanel the exact settings used by this run.
      await instance.updateWorkingFileProperties(workflowOverrides);

      const resolvedWorkflowKey = instance.promptQueue.getState().workflowKey;
      if (resolvedWorkflowKey && existingWorkflowKey === undefined) {
        await writeCommitMessageLineageKey(stateRoot, resolvedWorkflowKey);
      }

      // Captured directly from the integration rather than read back from a
      // persisted run history file: the response-complete listener is the fallback
      // text source even though this run now persists normal timeline artifacts.
      responseCompleteDisposable = instance.onResponseComplete((response) => {
        capturedResponseText = response;
      });
      streamingChunkDisposable = instance.onStreamingChunk((chunk) => {
        Log.debug(
          `[CommitMessageGenerator] Streaming chunk received during commit generation: length=${chunk.length}`
        );
      });
      streamingEventsDisposable = instance.onStreamingEvents((events) => {
        const summaries = events.map((event) => {
          if (
            event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL &&
            "tool" in event.data &&
            typeof event.data.tool === "string"
          ) {
            if (event.data.tool === COMMIT_MESSAGE_MCP_TOOL) {
              mcpToolCalled = true;
            }
            return `${event.type}:${event.data.tool}`;
          }
          if ("name" in event.data && typeof event.data.name === "string") {
            return `${event.type}:${event.data.name}`;
          }
          return event.type;
        });
        Log.debug(
          `[CommitMessageGenerator] Streaming events during commit generation: count=${events.length}, types=${summaries.join(",")}`
        );
      });

      if (token) {
        abortListener = () => {
          void instance.stop();
        };
        token.addEventListener("abort", abortListener);
      }

      await instance.executeLoadedPromptFile(harness);

      if (token?.aborted) {
        throw new Error("Commit message generation cancelled");
      }

      const cliCommand =
        detectorIntegration instanceof CliIntegration
          ? detectorIntegration.getLastSpawnedCommand()
          : undefined;
      const generationState = instance.promptQueue.getState();
      const workflowKey = generationState.workflowKey;
      const runRef = generationState.runRef;

      // Primary path: read the commit message written by submit_commit_message.
      if (useMcpCapture) {
        let mcpMessage: string | undefined;
        try {
          const raw = await fs.readFile(commitOutputPath, "utf8");
          mcpToolCalled = true;
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
            `[CommitMessageGenerator] MCP capture resolved: enabled=${useMcpCapture}, toolCalled=${mcpToolCalled}, outcome=message-captured`
          );
          return {
            message: mcpMessage,
            prompt: fullPrompt,
            cliCommand,
            workflowKey,
            runRef,
          };
        }

        Log.debug(
          `[CommitMessageGenerator] MCP capture resolved: enabled=${useMcpCapture}, toolCalled=${mcpToolCalled}, outcome=falling-through-to-response-text`
        );

        Log.warn(
          `[CommitMessageGenerator] MCP capture was enabled for ${harness} but no commit message was submitted; falling back to response text extraction`
        );
      } else {
        Log.debug(
          `[CommitMessageGenerator] MCP capture resolved: enabled=${useMcpCapture}, toolCalled=${mcpToolCalled}, outcome=falling-through-to-response-text`
        );
      }

      // Fallback: extract from response text (MCP unavailable or tool not called).
      const firstStep = generationState.steps[0];
      if (!firstStep || isScriptStep(firstStep)) {
        throw new CommitMessageGenerationError(
          "Commit message generation failed: no prompt step executed",
          workflowKey,
          runRef
        );
      }

      const rawResponse = capturedResponseText;
      Log.debug(
        `[CommitMessageGenerator] Raw captured response before empty-response check: ${rawResponse === undefined ? "undefined" : `length=${rawResponse.length}, state=${rawResponse === "" ? "empty-string" : "non-empty"}`}`
      );
      if (!rawResponse?.trim()) {
        throw new CommitMessageGenerationError(
          "Commit message generation produced an empty response",
          workflowKey,
          runRef
        );
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

      return {
        message: responseText,
        prompt: fullPrompt,
        cliCommand,
        workflowKey,
        runRef,
      };
    } catch (error) {
      if (error instanceof CommitMessageGenerationError) {
        throw error;
      }
      const state = instance.promptQueue.getState();
      throw new CommitMessageGenerationError(
        error instanceof Error ? error.message : String(error),
        state.workflowKey ?? existingWorkflowKey,
        state.runRef,
        { cause: error }
      );
    } finally {
      instance.setMcpToolSkillContext(undefined);
      responseCompleteDisposable?.dispose();
      streamingChunkDisposable?.dispose();
      streamingEventsDisposable?.dispose();
      if (token && abortListener) {
        token.removeEventListener("abort", abortListener);
      }
    }
  }
}
