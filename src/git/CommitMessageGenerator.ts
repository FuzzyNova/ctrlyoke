import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { NodePlatformAdapter } from "../platform/NodePlatformAdapter";
import type { ResolvedCliConfig } from "../platform/NodePlatformAdapter";
import { IntegrationFactory } from "../core/IntegrationFactory";
import { CliIntegration } from "../core/harness/CliIntegration";
import { WorkflowInstance } from "../core/WorkflowInstance";
import { WorkflowLineageRepository } from "../core/orchestration/WorkflowLineageRepository";
import { Log } from "../utils/Log";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { writeFileAtomic } from "../utils/AtomicFileUtils";
import {
  MCP_COMMIT_MESSAGE_DENIED_TOOL_NAMES,
  MCP_STARTUP_RETRY_INSTRUCTION,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
} from "../utils/McpToolDefinitions";
import { buildCommitMessageSkillCommandPrefix } from "../utils/McpToolSkillGenerator";
import { fenceLiteral } from "../utils/FileReferenceParser";
import {
  GIT_DIFF_NO_EXT_DIFF_OPTION,
  parseGitNulSeparatedPaths,
  repoToplevel,
} from "../utils/GitUtils";
import {
  CLI_EVENT_TYPES,
  COMMIT_SUBMISSION_CHANNELS,
  EXECUTION_MODES,
  CTRLYOKE_MCP_MODES,
  FINAL_STEP_PHASES,
  MCP_SERVER_IDS,
  PERMISSION_MODES,
  TOOL_PERMISSION_CATEGORIES,
  type CommitSubmissionChannel,
} from "../types/DashboardConstants";
import type { ToolPermissionConfig } from "../types/ExecutionPropertyTypes";
import { TIMELINE_ATTEMPT_TERMINAL_STATES } from "../types/WorkflowTimelineTypes";
import type { ResolvedRunAttemptValue } from "../core/orchestration/RunOutputResolver";
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
import { getErrorMessage } from "../utils/ErrorUtils";
import { truncateUtf8 } from "../utils/Utf8Truncate";

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
const COMMIT_MESSAGE_ALLOWED_READ_TOOLS = ["read", "grep", "glob"];
const COMMIT_MESSAGE_MCP_PERMISSION_PATTERN = `mcp__${MCP_SERVER_IDS.CTRLYOKE_COMMIT}__${COMMIT_MESSAGE_MCP_TOOL}`;
const COMMIT_MESSAGE_DENIED_TOOLS = ["write", "edit", "multiedit"];
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

/**
 * The submission channels a commit generation tries, one headless run each,
 * in order. Native mode tries the MCP tool first and falls back to a run
 * without ctrlyoke's MCP server when the first run ends without a
 * submission; skill mode never attaches the server, so only that second kind
 * of run happens. Without MCP, a harness that can scope a write to one file
 * writes the output file directly; any other uses the skill's shell command.
 */
export function getCommitSubmissionChannels(
  ctrlyokeMcpMode: CtrlYokeMcpMode,
  allowsSingleFileWrite: boolean
): readonly CommitSubmissionChannel[] {
  const withoutMcp = allowsSingleFileWrite
    ? COMMIT_SUBMISSION_CHANNELS.FILE
    : COMMIT_SUBMISSION_CHANNELS.SKILL_COMMAND;
  return ctrlyokeMcpMode === CTRLYOKE_MCP_MODES.SKILL
    ? [withoutMcp]
    : [COMMIT_SUBMISSION_CHANNELS.MCP_TOOL, withoutMcp];
}

/**
 * The prompt text that tells the model how to submit through `channel`.
 * `skillCommandPrefix` (from {@link buildCommitMessageSkillCommandPrefix}) is
 * required for the skill-command channel.
 */
export function buildCommitSubmitInstruction(
  channel: CommitSubmissionChannel,
  commitOutputPath: string,
  skillCommandPrefix?: string
): string {
  switch (channel) {
    case COMMIT_SUBMISSION_CHANNELS.MCP_TOOL:
      return `\n\nSubmit the commit message using the \`${COMMIT_MESSAGE_MCP_TOOL}\` tool. Do not output it as text. ${MCP_STARTUP_RETRY_INSTRUCTION}`;
    case COMMIT_SUBMISSION_CHANNELS.FILE:
      return `\n\nSubmit the commit message by writing it, and nothing else, to the file \`${commitOutputPath}\` with your file-writing tool. That is the only file you are allowed to write. Do not output the message as text.`;
    case COMMIT_SUBMISSION_CHANNELS.SKILL_COMMAND:
      // The skill's example already carries this command, but Qwen sometimes
      // invents its own paths, and only this exact prefix is allowed to run.
      if (!skillCommandPrefix) {
        throw new Error(
          "A skill-command submission needs the skill command prefix"
        );
      }
      return `\n\nSubmit the commit message by running the \`${COMMIT_MESSAGE_MCP_TOOL}\` command from the \`${MCP_SKILL_NAMES.COMMIT_MESSAGE}\` skill. Run it exactly as \`${skillCommandPrefix} '<JSON>'\`, where \`<JSON>\` is \`{"message":"<the commit message>"}\`, as a single command with nothing before or after it; any other command is denied. Do not output the message as text.`;
  }
}

function describeCommitSubmissionChannel(
  channel: CommitSubmissionChannel
): string {
  switch (channel) {
    case COMMIT_SUBMISSION_CHANNELS.MCP_TOOL:
      return `the ${COMMIT_MESSAGE_MCP_TOOL} MCP tool`;
    case COMMIT_SUBMISSION_CHANNELS.FILE:
      return "writing the commit message file";
    case COMMIT_SUBMISSION_CHANNELS.SKILL_COMMAND:
      return `the ${MCP_SKILL_NAMES.COMMIT_MESSAGE} skill`;
  }
}

/** The trimmed message a submission wrote, or undefined when none was. */
export async function readSubmittedCommitMessage(
  commitOutputPath: string
): Promise<string | undefined> {
  try {
    return (await fs.readFile(commitOutputPath, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

interface CommitSubmissionRequest {
  channel: CommitSubmissionChannel;
  harness: HarnessId;
  model: string | undefined;
  diff: string;
  commitPrompt: string;
  instructionsSection: string;
  platform: NodePlatformAdapter;
  mcpServerPath: string;
  roots: ReturnType<typeof getCommitMessageStatePaths>;
  token: AbortSignal | undefined;
}

/** One headless commit generation run through a single submission channel. */
export interface CommitSubmissionAttempt {
  channel: CommitSubmissionChannel;
  /** Undefined when the run completed without submitting a message. */
  message?: string;
  prompt: string;
  cliCommand?: string;
  workflowKey?: WorkflowKey;
  runRef?: RunRef;
}

/**
 * Run `attempt` for each channel in turn until one submits a message. A run
 * that throws (harness failure, cancellation) stops the sequence. When no
 * channel submits, the error names every channel tried and carries the last
 * run's address so the caller can point at its events.
 */
export async function submitThroughCommitChannels(
  channels: readonly CommitSubmissionChannel[],
  harness: HarnessId,
  attempt: (
    channel: CommitSubmissionChannel
  ) => Promise<CommitSubmissionAttempt>,
  token?: AbortSignal
): Promise<CommitSubmissionAttempt & { message: string }> {
  let last: CommitSubmissionAttempt | undefined;
  for (const channel of channels) {
    if (token?.aborted) {
      throw new Error("Commit message generation cancelled");
    }
    if (last) {
      Log.warn(
        `[CommitMessageGenerator] ${harness} did not submit a commit message through ${describeCommitSubmissionChannel(last.channel)}; retrying through ${describeCommitSubmissionChannel(channel)}`
      );
    }
    last = await attempt(channel);
    const { message } = last;
    if (message) {
      return { ...last, message };
    }
  }
  throw new CommitMessageGenerationError(
    `Commit message generation failed: ${harness} never submitted a commit message (tried ${channels.map(describeCommitSubmissionChannel).join(", then ")}).`,
    last?.workflowKey,
    last?.runRef
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

/** The commit run's tool permissions for one submission channel. */
function commitToolPermissions(
  channel: CommitSubmissionChannel,
  commitOutputPath: string | undefined,
  skillCommandPrefix: string | undefined
): ToolPermissionConfig {
  switch (channel) {
    case COMMIT_SUBMISSION_CHANNELS.MCP_TOOL:
      return {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: [
          ...COMMIT_MESSAGE_ALLOWED_READ_TOOLS,
          COMMIT_MESSAGE_MCP_PERMISSION_PATTERN,
        ],
        deniedTools: ["shell", ...COMMIT_MESSAGE_DENIED_TOOLS],
      };
    case COMMIT_SUBMISSION_CHANNELS.FILE:
      if (!commitOutputPath) {
        throw new Error(
          "A file submission needs the commit message output path"
        );
      }
      // Writing is allowed for this one file only. Nothing else is allowed,
      // so a headless custom run still auto-denies every other write; a deny
      // rule for `write`/`edit` would also override this allow on harnesses
      // where deny wins.
      return {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: [
          ...COMMIT_MESSAGE_ALLOWED_READ_TOOLS,
          `${TOOL_PERMISSION_CATEGORIES.WRITE}(${commitOutputPath})`,
        ],
        deniedTools: ["shell"],
      };
    case COMMIT_SUBMISSION_CHANNELS.SKILL_COMMAND:
      if (!skillCommandPrefix) {
        throw new Error(
          "A skill-command submission needs the skill command prefix"
        );
      }
      // Only this run's exact command prefix is allowed; the message is the
      // trailing `--args` value. A wildcard inside the command would also
      // match `node -e <any code> --tool submit_commit_message`.
      return {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: [
          ...COMMIT_MESSAGE_ALLOWED_READ_TOOLS,
          `${TOOL_PERMISSION_CATEGORIES.SHELL}(${skillCommandPrefix}:*)`,
        ],
        deniedTools: COMMIT_MESSAGE_DENIED_TOOLS,
      };
  }
}

export function buildCommitWorkflowOverrides(
  harness: HarnessId,
  model: string | undefined,
  mcpServerConfig: McpServerConfig | undefined,
  channel: CommitSubmissionChannel = COMMIT_SUBMISSION_CHANNELS.MCP_TOOL,
  commitOutputPath?: string,
  skillCommandPrefix?: string
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
      channel === COMMIT_SUBMISSION_CHANNELS.SKILL_COMMAND
        ? [MCP_SKILL_NAMES.COMMIT_MESSAGE]
        : null,
    additionalArgs: null,
    hooks: null,
    toolPermissions: commitToolPermissions(
      channel,
      commitOutputPath,
      skillCommandPrefix
    ),
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
    const repositoryRoot = await repoToplevel(cwd);
    if (!repositoryRoot) {
      throw new Error(`Not a git repository: ${cwd}`);
    }

    // Primary: staged changes
    const stagedCommand = gitDiffCommand("--cached");
    const { stdout: stagedDiff } = await execFileAsync(
      "git",
      gitDiffArgs("--cached"),
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_DIFF_MAX_BUFFER,
      }
    );
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
        if (!/ambiguous argument 'HEAD'|unknown revision.*HEAD/i.test(stderr)) {
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
        const isTruncatedPrefix = contentBuffer.length < stat.size;
        if (contentBuffer.length === 0 && !isTruncatedPrefix) {
          // Git lists an empty new file with no hunk at all.
          append(`${header}new file mode 100644\n`);
          continue;
        }
        const content = contentBuffer.toString("utf8");
        const endsWithNewline = content.endsWith("\n");
        const lines = content.split("\n");
        if (endsWithNewline) {
          lines.pop();
        }
        const prefix =
          `${header}new file mode 100644\n` +
          `--- /dev/null\n` +
          `+++ b/${filePath}\n` +
          `@@ -0,0 +1,${lines.length} @@\n`;
        append(prefix);
        if (lines.length > 0) {
          append(`${lines.map((line) => `+${line}`).join("\n")}\n`);
        }
        if (!isTruncatedPrefix && !endsWithNewline) {
          append("\\ No newline at end of file\n");
        }
        if (isTruncatedPrefix || usedBytes >= MAX_DIFF_BYTES) {
          truncated = true;
          break;
        }
      } catch {
        // skip unreadable files
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
    if (token?.aborted) {
      throw new Error("Commit message generation cancelled");
    }

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

    const platform = new NodePlatformAdapter(config);

    // The message is only ever taken from a structured submission, which both
    // the MCP tool and the skill's CLI command write to a file. Response text
    // is never used: it can be a preamble, or the model explaining that the
    // tool was unavailable, and either would land in the commit box.
    const mcpServerPath = path.join(
      platform.getExtensionPath(),
      "out",
      "mcp-server.js"
    );
    try {
      await fs.access(mcpServerPath);
    } catch {
      throw new CommitMessageGenerationError(
        `Commit message generation needs ctrlyoke's MCP server at ${mcpServerPath}, which was not found. Build ctrlyoke (npm run compile) and try again.`
      );
    }
    const roots = getCommitMessageStatePaths(cwd, stateRoot);
    await fs.mkdir(roots.tempDir, { recursive: true });

    const allowsSingleFileWrite =
      IntegrationFactory.createCapabilityProvider(harness).toolPermissionMapper
        .allowsSingleFileWrite === true;
    const submitted = await submitThroughCommitChannels(
      getCommitSubmissionChannels(
        ConfigurationUtils.getCtrlYokeMcpMode(),
        allowsSingleFileWrite
      ),
      harness,
      (channel) =>
        this.runSubmissionAttempt({
          channel,
          harness,
          model,
          diff,
          commitPrompt,
          instructionsSection,
          platform,
          mcpServerPath,
          roots,
          token,
        }),
      token
    );
    return {
      message: submitted.message,
      prompt: submitted.prompt,
      cliCommand: submitted.cliCommand,
      workflowKey: submitted.workflowKey,
      runRef: submitted.runRef,
    };
  }

  /**
   * Run one headless commit generation that submits through `channel`, and
   * return the submitted message, or no message when nothing was submitted.
   * A run that fails outright (harness error, cancellation) throws instead.
   */
  private async runSubmissionAttempt(
    request: CommitSubmissionRequest
  ): Promise<CommitSubmissionAttempt> {
    const {
      channel,
      harness,
      model,
      diff,
      commitPrompt,
      instructionsSection,
      platform,
      mcpServerPath,
      roots,
      token,
    } = request;
    const commitOutputPath = path.join(
      roots.tempDir,
      `commit-output-${channel}-${Date.now()}.txt`
    );
    // The same paths go into the skill context below, so the command the
    // skill documents is exactly the one the run allows.
    const skillCommandPrefix = buildCommitMessageSkillCommandPrefix({
      mcpServerPath,
      workspaceRoot: roots.stateRoot,
      commitOutputPath,
    });

    // Keep diff content inert for every prompt-reference parser, even when
    // added Markdown contains its own fenced code blocks.
    const fullPrompt = buildCommitMessagePrompt(
      diff,
      commitPrompt,
      instructionsSection,
      buildCommitSubmitInstruction(
        channel,
        commitOutputPath,
        skillCommandPrefix
      )
    );

    const mcpServerConfig: McpServerConfig | undefined =
      channel === COMMIT_SUBMISSION_CHANNELS.MCP_TOOL
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

    Log.debug(
      `[CommitMessageGenerator] Generating a commit message with ${harness} through ${channel}`
    );

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
    // The read-only + submit-tool allow-list is deliberate, so the generic
    // "headless with limited permissions" warning would fire on every run.
    instance.setSuppressHeadlessPermissionWarning(true);

    // Force headless execution at the workflow tier and suppress VS Code globals
    // that could bleed into this one-shot call. SettingsPropertyResolver materializes
    // settings into resolved step properties, which take precedence over the
    // NodePlatformAdapter fallback used by CliIntegration.
    let streamingChunkDisposable: { dispose(): void } | undefined;
    let streamingEventsDisposable: { dispose(): void } | undefined;
    let abortListener: (() => void) | undefined;

    try {
      const workflowOverrides = buildCommitWorkflowOverrides(
        harness,
        model,
        mcpServerConfig,
        channel,
        commitOutputPath,
        skillCommandPrefix
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
        if (token.aborted) {
          abortListener();
        }
      }

      if (token?.aborted) {
        throw new Error("Commit message generation cancelled");
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

      // Both the MCP tool and the skill's CLI command write the submitted
      // message to commitOutputPath.
      const message = await readSubmittedCommitMessage(commitOutputPath);
      if (message) {
        Log.debug(
          `[CommitMessageGenerator] Commit message submitted through ${channel}: length=${message.length}`
        );
        return {
          channel,
          message,
          prompt: fullPrompt,
          cliCommand,
          workflowKey,
          runRef,
        };
      }

      const firstStep = generationState.steps[0];
      if (!firstStep || isScriptStep(firstStep)) {
        throw new CommitMessageGenerationError(
          "Commit message generation failed: no prompt step executed",
          workflowKey,
          runRef
        );
      }

      // Only a run that finished normally without submitting moves on to the
      // next submission mode. A run that failed (harness error, auth, crash)
      // would fail the same way again.
      const attempts =
        workflowKey && runRef
          ? await instance.outputHistoryManager
              .getRunOutputResolver()
              .resolveLatestAttempts(
                instance.outputHistoryManager.getHistoryFilePath(
                  workflowKey,
                  runRef
                ),
                [{ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 }]
              )
          : new Map();
      const firstAttempt: ResolvedRunAttemptValue | undefined =
        attempts.get("queue:0");
      if (
        firstAttempt?.terminalState !==
        TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED
      ) {
        throw new CommitMessageGenerationError(
          "Commit message generation did not complete successfully",
          workflowKey,
          runRef
        );
      }

      return {
        channel,
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
        getErrorMessage(error),
        state.workflowKey ?? existingWorkflowKey,
        state.runRef,
        { cause: error }
      );
    } finally {
      instance.setMcpToolSkillContext(undefined);
      instance.setSuppressHeadlessPermissionWarning(false);
      streamingChunkDisposable?.dispose();
      streamingEventsDisposable?.dispose();
      if (token && abortListener) {
        token.removeEventListener("abort", abortListener);
      }
      await fs.rm(commitOutputPath, { force: true }).catch(() => {});
    }
  }
}
