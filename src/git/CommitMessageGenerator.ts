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
import { fenceLiteral } from "../utils/FileReferenceParser";
import {
  GIT_DIFF_NO_EXT_DIFF_OPTION,
  parseGitNulSeparatedPaths,
  repoToplevel,
} from "../utils/GitUtils";
import {
  CLI_EVENT_TYPES,
  EXECUTION_MODES,
  CTRLYOKE_MCP_MODES,
  MCP_SERVER_IDS,
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

function gitDiffArgs(...args: string[]): string[] {
  return ["diff", ...args, GIT_DIFF_NO_EXT_DIFF_OPTION];
}

function gitDiffCommand(...args: string[]): string {
  return `git ${gitDiffArgs(...args).join(" ")}`;
}
// ~200k tokens at ~4 bytes/token; leaves room for system prompt and instructions.
// The harness handles actual context-window limits natively — this is just a safeguard
// against truly pathological diffs (e.g. generated files, minified bundles).
export const MAX_DIFF_BYTES = 750 * 1024;
const GIT_DIFF_MAX_BUFFER = 100 * 1024 * 1024;
const BINARY_DETECTION_BYTES = 8 * 1024;
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

export function getMaxDiffSizeLabel(): string {
  return `${Math.floor(MAX_DIFF_BYTES / 1024)} KB`;
}

export function getCommitMessageStatePaths(
  cwd: string,
  stateRoot: string = cwd
): { cwd: string; stateRoot: string; tempDir: string } {
  return {
    cwd,
    stateRoot,
    tempDir: path.join(
      stateRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR
    ),
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return value;
  }
  let truncated = buffer.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

async function readFilePrefix(
  filePath: string,
  maxBytes: number,
  position = 0
): Promise<Buffer> {
  if (maxBytes <= 0) {
    return Buffer.alloc(0);
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function buildCommitMessagePrompt(
  diff: string,
  commitPrompt: string,
  instructionsSection = "",
  mcpInstruction = ""
): string {
  const fencedDiff = fenceLiteral(diff, "diff");
  return `${commitPrompt}\n\n${fencedDiff}${instructionsSection}${mcpInstruction}`;
}

function isNotGitRepositoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    /fatal: not a git repository/i.test(error.stderr)
  );
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

  async getDiff(
    cwd: string,
    options: { includeUnstaged?: boolean } = {}
  ): Promise<DiffResult | null> {
    // Primary: staged changes
    const stagedCommand = gitDiffCommand("--cached");
    let stagedDiff = "";
    try {
      const result = await execFileAsync("git", gitDiffArgs("--cached"), {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_DIFF_MAX_BUFFER,
      });
      stagedDiff = result.stdout;
      if (stagedDiff.trim() && !options.includeUnstaged) {
        const diff = truncateUtf8(stagedDiff, MAX_DIFF_BYTES);
        return {
          diff,
          staged: true,
          truncated: Buffer.byteLength(stagedDiff, "utf8") > MAX_DIFF_BYTES,
          commands: [stagedCommand],
          includesUntrackedFiles: false,
        };
      }
    } catch (error) {
      if (!isNotGitRepositoryError(error)) {
        throw error;
      }
    }

    // Fallback: unstaged tracked + untracked files
    let diff = "";
    let usedBytes = 0;
    let truncated = false;
    const append = (part: string): void => {
      const remaining = MAX_DIFF_BYTES - usedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const bounded = truncateUtf8(part, remaining);
      diff += bounded;
      usedBytes += Buffer.byteLength(bounded, "utf8");
      if (
        Buffer.byteLength(part, "utf8") > Buffer.byteLength(bounded, "utf8")
      ) {
        truncated = true;
      }
    };
    const commands = [
      stagedCommand,
      gitDiffCommand(...(options.includeUnstaged ? ["HEAD"] : [])),
    ];
    let includesUntrackedFiles = false;
    let hasStagedChanges = false;
    const repositoryRoot = (await repoToplevel(cwd)) ?? cwd;
    try {
      if (stagedDiff.trim()) {
        hasStagedChanges = true;
      }
      if (options.includeUnstaged) {
        try {
          const { stdout: headDiff } = await execFileAsync(
            "git",
            gitDiffArgs("HEAD"),
            { cwd, encoding: "utf8", maxBuffer: GIT_DIFF_MAX_BUFFER }
          );
          if (headDiff.trim()) {
            append(headDiff);
          }
        } catch (error) {
          const stderr =
            typeof error === "object" && error !== null && "stderr" in error
              ? String(error.stderr)
              : "";
          if (
            !/ambiguous argument 'HEAD'|unknown revision.*HEAD/i.test(stderr)
          ) {
            throw error;
          }
          commands.push(gitDiffCommand());
          // An unborn repository has no HEAD comparison; combine its staged
          // additions with the regular unstaged diff instead.
          if (stagedDiff.trim()) {
            append(stagedDiff);
          }
          const { stdout: trackedDiff } = await execFileAsync(
            "git",
            gitDiffArgs(),
            {
              cwd,
              encoding: "utf8",
              maxBuffer: GIT_DIFF_MAX_BUFFER,
            }
          );
          if (trackedDiff.trim()) {
            append(trackedDiff);
          }
        }
      } else {
        const { stdout: trackedDiff } = await execFileAsync(
          "git",
          gitDiffArgs(),
          {
            cwd,
            encoding: "utf8",
            maxBuffer: GIT_DIFF_MAX_BUFFER,
          }
        );
        if (trackedDiff.trim()) {
          append(trackedDiff);
        }
      }
    } catch (error) {
      if (!isNotGitRepositoryError(error)) {
        throw error;
      }
    }

    try {
      commands.push("git ls-files --others --exclude-standard -z");
      const { stdout: untrackedOut } = await execFileAsync(
        "git",
        ["ls-files", "--others", "--exclude-standard", "-z"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          maxBuffer: GIT_DIFF_MAX_BUFFER,
        }
      );
      const untrackedFiles = parseGitNulSeparatedPaths(untrackedOut);
      includesUntrackedFiles = untrackedFiles.length > 0;
      for (const filePath of untrackedFiles) {
        const remaining = MAX_DIFF_BYTES - usedBytes;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        try {
          const absolutePath = path.join(repositoryRoot, filePath);
          const stat = await fs.lstat(absolutePath);
          if (!stat.isFile()) {
            continue;
          }

          const header = `diff --git a/${filePath} b/${filePath}\n`;
          const binaryHeader = `${header}new file mode 100644\nBinary file b/${filePath} added\n`;
          const sample = await readFilePrefix(
            absolutePath,
            Math.min(BINARY_DETECTION_BYTES, remaining)
          );
          if (sample.includes(0)) {
            append(binaryHeader);
            continue;
          }

          const fileBudget = Math.max(
            0,
            remaining - Buffer.byteLength(header, "utf8")
          );
          if (fileBudget === 0) {
            append(header);
            truncated = true;
            break;
          }
          const restBuffer = await readFilePrefix(
            absolutePath,
            Math.max(0, fileBudget - sample.length),
            sample.length
          );
          const contentBuffer = Buffer.concat([sample, restBuffer]);
          const content = contentBuffer.toString("utf8");
          const lines = content.split("\n");
          const prefix =
            `${header}new file mode 100644\n` +
            `--- /dev/null\n` +
            `+++ b/${filePath}\n` +
            `@@ -0,0 +1,${lines.length} @@\n`;
          append(prefix);
          append(lines.map((line) => `+${line}`).join("\n"));
          if (contentBuffer.length < stat.size || usedBytes >= MAX_DIFF_BYTES) {
            truncated = true;
            break;
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch (error) {
      if (!isNotGitRepositoryError(error)) {
        throw error;
      }
    }

    if (!diff.trim()) {
      return null;
    }
    return {
      diff,
      staged: hasStagedChanges,
      truncated,
      commands,
      includesUntrackedFiles,
    };
  }

  async generateMessage(
    diff: string,
    cwd: string,
    token?: AbortSignal,
    instructions?: string,
    stateRoot: string = cwd
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
    const commitPrompt = ConfigurationUtils.getCommitSystemPrompt();

    const instructionsSection = instructions?.trim()
      ? `\n\nUser's starting draft or instructions — use as a guide for the message:\n${instructions.trim()}`
      : "";

    const config: ResolvedCliConfig = {
      model,
      cwd,
      vars: {},
      resumeSession: false,
      verbose: false,
      quiet: true,
      json: false,
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
    const roots = getCommitMessageStatePaths(cwd, stateRoot);
    const { tempDir } = roots;
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
    // Keep diff content inert for every prompt-reference parser, even when
    // added Markdown contains its own fenced code blocks.
    const fullPrompt = buildCommitMessagePrompt(
      diff,
      commitPrompt,
      instructionsSection,
      mcpInstruction
    );

    const mcpServerConfig: McpServerConfig | undefined = useMcpCapture
      ? {
          id: MCP_SERVER_IDS.CTRLYOKE_COMMIT,
          command: "node",
          args: [mcpServerPath.replace(/\\/g, "/")],
          env: {
            CTRLYOKE_WORKSPACE: roots.stateRoot.replace(/\\/g, "/"),
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

    const existingWorkflowKey = await readCommitMessageLineageKey(
      roots.stateRoot
    );

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
        roots.stateRoot,
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
      workspaceRoot: roots.stateRoot,
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
        await writeCommitMessageLineageKey(
          roots.stateRoot,
          resolvedWorkflowKey
        );
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
