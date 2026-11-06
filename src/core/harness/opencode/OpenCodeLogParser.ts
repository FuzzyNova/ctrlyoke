import { execFile } from "child_process";
import * as fsSync from "fs";
import * as path from "path";
import { promisify } from "util";
import type * as fs from "fs";
import { BaseLogParser } from "../shared/BaseLogParser";
import {
  BaseCliEvent,
  UserEventClassification,
} from "../shared/interfaces/ILogParser";
import {
  UniversalCliOutput,
  CliEvent,
  TokenUsage,
  CompactionData,
  type BackgroundTaskSummary,
  type BackgroundWorkHoldSnapshot,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  COMPACTION_TRIGGERS,
  HARNESS_IDS,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";
import {
  mapOpenCodeToolPartToCliEvent,
  accumulateOpenCodeStepTokens,
  normalizeOpenCodeToolPart,
  openCodeStepTotal,
} from "./OpenCodeEventMapper";
import {
  OPENCODE_EVENT_TYPES,
  OPENCODE_PART_TYPES,
  OPENCODE_STEP_FINISH_REASONS,
  OPENCODE_MESSAGE_ROLES,
  OPENCODE_TOOL_NAMES,
  OPENCODE_TOOL_STATUS,
  OPENCODE_SUBAGENT_RECORD_TYPES,
  OPENCODE_EXPORT_COMMANDS,
  OPENCODE_SUBAGENT_TOOL_NAMES,
  OPENCODE_V2_CONTENT_TYPES,
  OPENCODE_V2_MESSAGE_TYPES,
  OPENCODE_BACKGROUND_TOOL_STATUS,
  OPENCODE_IMAGE_TOOL_NAME,
  OPENCODE_SHELL_TOOL_NAMES,
} from "./OpenCodeProtocolConstants";
import { detectOpenCodeV2 } from "./OpenCodeVersion";
import { BackgroundFollowUpState } from "../shared/BackgroundFollowUpState";
import { Log } from "../../../utils/Log";
import { resolveCliCommand } from "../shared/CliLauncherResolver";
import { PollingFsWatcher } from "../shared/FsWatcherHandles";
import { SubagentSourceFollower } from "../shared/SubagentSourceFollower";
import { readIncrementalJsonl } from "../shared/IncrementalJsonlReader";
import {
  SESSION_AVAILABILITY,
  type SessionProbeResult,
} from "../../../types/DashboardConstants";

const execFileAsync = promisify(execFile);

/** Polling interval (ms) between `opencode export` calls in interactive mode */
const EXPORT_POLL_INTERVAL_MS = 1000;

/**
 * `opencode export` dumps the *entire* session transcript (every message and
 * tool-call part) on every poll, not just the new tail. Node's execFile
 * default maxBuffer is 1 MiB, which long-running sessions with large tool
 * outputs/diffs blow past well before completion. When that happens execFile
 * throws ERR_CHILD_PROCESS_STDIO_MAXBUFFER on *every subsequent poll* (the
 * transcript only grows), silently dropping all events from that point on
 * until the session's Stop notification fires — producing a "completed"
 * result missing everything the model did afterward. 100 MiB comfortably
 * covers realistic long sessions; see the OpenCode missing-output
 * investigation for the reproducing case.
 */
const OPENCODE_EXPORT_MAX_BUFFER = 100 * 1024 * 1024;
const OPENCODE_SUBAGENT_SIDECAR_SUFFIX = "-subagents.jsonl";

type OpenCodeExportRunner = (
  sessionId: string,
  workspaceRoot?: string
) => Promise<string>;

/**
 * Run OpenCode's export command through the same platform-aware launcher used
 * to spawn the interactive TUI. On Windows, calling a bare `opencode` through
 * a shell depends on the extension host's PATH, which may not include npm's
 * shim directory even when the TUI itself launched successfully.
 */
async function runOpenCodeExport(
  sessionId: string,
  workspaceRoot?: string
): Promise<string> {
  // OpenCode 2 moved the command to `session export`. It goes through the
  // shared background service rather than --standalone: export is read-only,
  // needs none of the launch's environment, and the service reads the same
  // session store a standalone TUI writes, without a server spawn per poll.
  const subcommand = (await detectOpenCodeV2())
    ? OPENCODE_EXPORT_COMMANDS.V2
    : OPENCODE_EXPORT_COMMANDS.V1;
  const command = await resolveCliCommand("opencode", [
    ...subcommand,
    sessionId,
  ]);
  const { stdout } = await execFileAsync(command.command, command.args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: OPENCODE_EXPORT_MAX_BUFFER,
    windowsHide: true,
    windowsVerbatimArguments: command.requiresShellVerbatimArgs,
  });
  return stdout;
}

// ──────────────────────────────────────────────────────────────────
// Local type aliases for the opencode export JSON structure
// ──────────────────────────────────────────────────────────────────

interface OpenCodeExport {
  info: { id: string; [key: string]: unknown };
  messages: Array<OpenCodeExportMessage | OpenCodeV2ExportMessage>;
}

/**
 * An OpenCode 2 `session export` message: flat, typed by `type`, with assistant
 * output in `content[]` and the step's finish/tokens on the message itself.
 * Content items carry no ids of their own.
 */
interface OpenCodeV2ExportMessage {
  id: string;
  type: string;
  time?: { created?: number; completed?: number };
  text?: string;
  content?: Array<Record<string, any>>;
  finish?: string;
  tokens?: Record<string, unknown>;
  cost?: number;
  model?: { id?: string; providerID?: string };
  error?: unknown;
  retry?: { attempt?: number; error?: unknown };
  status?: string;
  reason?: string;
  /** A `synthetic` message's origin; background jobs name themselves here. */
  metadata?: Record<string, unknown>;
}

/** A background job a completed tool call started, keyed by its job id. */
interface OpenCodeBackgroundLaunch {
  taskId: string;
  summary: BackgroundTaskSummary;
}

/**
 * The background job a completed OpenCode 2 tool call left running, if any.
 * The job id is the id OpenCode's completion notice names: a shell's
 * `shellID`, a subagent's child session id, an image job's `jobID`.
 */
function openCodeBackgroundLaunch(
  rawItem: Record<string, any>
): OpenCodeBackgroundLaunch | undefined {
  const part = normalizeOpenCodeToolPart(rawItem);
  if (part.state?.status !== OPERATION_STATUS.COMPLETED) return undefined;
  const tool = typeof part.tool === "string" ? part.tool : undefined;
  const input = isObject(part.state.input) ? part.state.input : {};
  const metadata = isObject(part.state.metadata) ? part.state.metadata : {};
  const running = metadata.status === OPENCODE_BACKGROUND_TOOL_STATUS;
  const stringField = (value: unknown): string | undefined =>
    typeof value === "string" && value ? value : undefined;

  let taskId: string | undefined;
  const summary: BackgroundTaskSummary = { toolName: tool };
  if (tool && OPENCODE_SHELL_TOOL_NAMES.has(tool) && running) {
    taskId = stringField(metadata.shellID);
    summary.command = stringField(input.command);
  } else if (tool && OPENCODE_SUBAGENT_TOOL_NAMES.has(tool) && running) {
    taskId = stringField(metadata.sessionId);
    summary.description = stringField(input.description);
  } else if (tool === OPENCODE_IMAGE_TOOL_NAME) {
    taskId = stringField(metadata.jobID);
    summary.description = stringField(input.prompt);
  }
  return taskId ? { taskId, summary: { ...summary, taskId } } : undefined;
}

/** The job a `synthetic` completion notice reports, if it is one. */
function openCodeBackgroundNoticeTaskId(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  const id = metadata?.jobID ?? metadata?.shellID ?? metadata?.childID;
  return typeof id === "string" && id ? id : undefined;
}

function isOpenCodeV2ExportMessage(
  message: OpenCodeExportMessage | OpenCodeV2ExportMessage
): message is OpenCodeV2ExportMessage {
  return (
    !("info" in message && isObject(message.info)) &&
    typeof (message as OpenCodeV2ExportMessage).type === "string"
  );
}

interface OpenCodeExportMessage {
  info: {
    role: string;
    time?: { created?: number; completed?: number };
    [key: string]: unknown;
  };
  parts: OpenCodeExportPart[];
}

interface OpenCodeExportPart {
  type: string;
  id: string;
  sessionID: string;
  messageID: string;
  state?: {
    status?: string;
    metadata?: { sessionId?: string };
    [key: string]: unknown;
  };
  tokens?: Record<string, unknown>;
  text?: string;
  [key: string]: unknown;
}

type OpenCodeSidecarPart = OpenCodeExportPart & {
  callID?: string;
  tool?: string;
  modelID?: string;
};

type OpenCodeSubagentSidecarRecord =
  | {
      kind: typeof OPENCODE_SUBAGENT_RECORD_TYPES.PART;
      childSessionId: string;
      part: OpenCodeSidecarPart;
    }
  | {
      kind: typeof OPENCODE_SUBAGENT_RECORD_TYPES.TASK_RUNNING;
      childSessionId: string;
      part: OpenCodeSidecarPart;
    }
  | {
      kind: typeof OPENCODE_SUBAGENT_RECORD_TYPES.CHILD_IDLE;
      childSessionId: string;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOpenCodeSubagentSidecarRecord(
  value: unknown
): value is OpenCodeSubagentSidecarRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!isObject(value) || typeof value.childSessionId !== "string")
    return false;
  if (value.kind === OPENCODE_SUBAGENT_RECORD_TYPES.CHILD_IDLE) return true;
  if (
    value.kind !== OPENCODE_SUBAGENT_RECORD_TYPES.PART &&
    value.kind !== OPENCODE_SUBAGENT_RECORD_TYPES.TASK_RUNNING
  )
    return false;
  const part = value.part;
  return (
    isObject(part) &&
    typeof part.type === "string" &&
    typeof part.id === "string" &&
    typeof part.sessionID === "string" &&
    typeof part.messageID === "string"
  );
}

/**
 * OpenCode CLI Log Parser
 *
 * OpenCode does not write session log files like Copilot or Claude.
 * Instead, this parser polls `opencode export <sessionId>` on a fixed interval
 * and converts the returned JSON into JSONL-style BaseCliEvents — matching the
 * same event shape produced by `opencode run --format json`.
 *
 * The "log path" passed through CliIntegration and CliLogMonitor is the session
 * ID itself (e.g. `ses_340325359ffejJqLbgD9CkEEq3`), obtained from the
 * OpenCodeNotificationMonitor completion plugin.
 *
 * Flow:
 *   discoverSessionLog(...)       → returns sessionId (or null if unknown)
 *   watchLogFile(sessionId, ...)  → polls opencode export, emits new events
 *   readNewLines(sessionId)       → single export call, returns new events
 *   isComplete(event)             → detects step_finish with reason === "stop"
 *   extractResponse(events)       → assembles UniversalCliOutput from events
 */
export class OpenCodeLogParser extends BaseLogParser {
  private readonly subagentFollower = new SubagentSourceFollower();
  private subagentNotifyDir?: string;
  private subagentRunId?: string;
  getSubagentFollower(): SubagentSourceFollower {
    return this.subagentFollower;
  }
  /** Where the plugin writes this launch's subagent records. */
  setSubagentSidecar(directory: string | undefined, runId: string): void {
    this.subagentNotifyDir = directory;
    this.subagentRunId = runId;
  }
  async cleanupSubagentSidecar(): Promise<void> {
    if (this.subagentNotifyDir && this.subagentRunId) {
      await fsSync.promises
        .unlink(
          path.join(
            this.subagentNotifyDir,
            `${this.subagentRunId}${OPENCODE_SUBAGENT_SIDECAR_SUFFIX}`
          )
        )
        .catch(() => {});
    }
  }

  /**
   * OpenCode 2 background jobs (shells, subagents, image jobs) that wake the
   * session again when they finish. See `trackBackgroundWorkState`.
   */
  private readonly backgroundFollowUpState = new BackgroundFollowUpState();

  async beginMonitoringTurn(): Promise<void> {
    this.subagentFollower.reset();
    // See ILogParser.trackBackgroundWorkState's session-reset contract. Every
    // OpenCode prompt, launched or sent to a running TUI, starts a monitored
    // turn here, and the previous turn's hold has already settled.
    this.backgroundFollowUpState.reset();
  }

  /**
   * Track OpenCode 2 background jobs from the export-derived lifecycle
   * events (`extractNewEventsFromV2Message`). A job is pending from its
   * launching tool call until its `synthetic` completion notice; the notice
   * starts a resumed execution (or joins the one running), and the next
   * `idle` closes it. Every execution ends with exactly one `idle`, whatever
   * its outcome, so it is the closing signal rather than an assistant step.
   *
   * Only the interactive export carries notices and idles. Headless
   * `opencode run --format json` reports neither, so its events never reach
   * here: tracking its launches would leave them pending forever.
   */
  override trackBackgroundWorkState(event: BaseCliEvent): void {
    const e = event as Record<string, any>;
    switch (event.type) {
      case OPENCODE_EVENT_TYPES.BACKGROUND_LAUNCH:
        if (typeof e.taskId === "string") {
          this.backgroundFollowUpState.launch(e.taskId, e.summary);
        }
        break;
      case OPENCODE_EVENT_TYPES.BACKGROUND_NOTICE:
        if (typeof e.taskId === "string") {
          this.backgroundFollowUpState.consumeNotification(e.taskId);
        }
        break;
      case OPENCODE_EVENT_TYPES.IDLE:
        this.backgroundFollowUpState.resumedTurnClosed();
        break;
    }
  }

  override hasPendingBackgroundWork(): boolean {
    return this.backgroundFollowUpState.isCompletionBlocked();
  }

  override getBackgroundWorkHoldSnapshot(): BackgroundWorkHoldSnapshot {
    return this.backgroundFollowUpState.snapshot();
  }

  /** Part IDs already emitted — prevents re-emitting on re-poll */
  private readonly seenPartIds = new Set<string>();
  /** MCP server ids attached to the execution whose output is being parsed. */
  private attachedMcpServerIds: ReadonlySet<string> = new Set();

  /**
   * Returns the context window size (in tokens) for the current model.
   * Injected from OpenCodeCliProvider so parsers don't call the CLI themselves.
   */
  private readonly contextWindowSizeFn: () => number | undefined;

  /** Probe OpenCode's own session store through its ID-addressed export API. */
  async probeSessionId(
    sessionId: string,
    workspaceRoot: string
  ): Promise<SessionProbeResult> {
    try {
      const parsed = JSON.parse(
        await this.runExport(sessionId, workspaceRoot)
      ) as OpenCodeExport;
      if (!parsed?.info || typeof parsed.info.id !== "string") {
        return SESSION_AVAILABILITY.UNKNOWN;
      }
      return parsed?.info?.id === sessionId
        ? SESSION_AVAILABILITY.AVAILABLE
        : SESSION_AVAILABILITY.MISSING;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Session not found"))
        return SESSION_AVAILABILITY.MISSING;
      return SESSION_AVAILABILITY.UNKNOWN;
    }
  }

  constructor(
    contextWindowSizeFn: () => number | undefined = () => undefined,
    private readonly runExport: OpenCodeExportRunner = runOpenCodeExport
  ) {
    super();
    this.contextWindowSizeFn = contextWindowSizeFn;
  }

  /** Set the exact MCP server ids attached to the current execution. */
  setAttachedMcpServerIds(serverIds: ReadonlySet<string>): void {
    this.attachedMcpServerIds = new Set(serverIds);
  }

  // ──────────────────────────────────────────────────────────────────
  // ILogParser contract
  // ──────────────────────────────────────────────────────────────────

  /**
   * For OpenCode, the "log path" is the session ID.
   * Session IDs arrive via the notification monitor plugin.
   * If no session ID is available, returns null (monitoring cannot proceed).
   */
  discoverSessionLog(
    _promptText: string,
    _startTime: Date,
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    return Promise.resolve(signal?.aborted ? null : (sessionId ?? null));
  }

  /**
   * Override: instead of reading a file, call `opencode export <sessionId>`
   * and return any parts not yet emitted.
   *
   * @param sessionId The "log path" — actually the session ID for this harness
   */
  async readNewLines(sessionId: string): Promise<BaseCliEvent[]> {
    return this.fetchNewEvents(sessionId);
  }

  /**
   * Override: poll `opencode export <sessionId>` without overlapping exports
   * instead of watching a file with fs.watch.
   *
   * @param sessionId The "log path" — actually the session ID for this harness
   * @param callback  Called for each new BaseCliEvent
   * @param startTime Only emit events with timestamps >= startTime
   * @returns A PollingFsWatcher (implements fs.FSWatcher); call .close() to stop
   */
  watchLogFile(
    sessionId: string,
    callback: (entry: BaseCliEvent) => void,
    startTime: Date
  ): fs.FSWatcher {
    let closed = false;
    let timeout: NodeJS.Timeout | undefined;
    const poll = async (): Promise<void> => {
      if (closed) return;
      try {
        const newEvents = await this.fetchNewEvents(sessionId);
        for (const event of newEvents) {
          const entryTime = this.extractTimestamp(event);
          if (entryTime && entryTime < startTime) {
            continue;
          }
          callback(event);
        }
      } catch (error) {
        Log.trace(`[OpenCodeLogParser] Export poll error: ${error}`);
      } finally {
        if (!closed) {
          timeout = setTimeout(() => void poll(), EXPORT_POLL_INTERVAL_MS);
        }
      }
    };

    const watcher = new PollingFsWatcher(() => {
      closed = true;
      if (timeout) clearTimeout(timeout);
    });
    void poll();
    return watcher;
  }

  /** Running total from the most recent step_finish token event — updated in extractLiveContextWindow. */
  private liveLastStepTotal: number | undefined;

  /**
   * A session is complete when a step_finish event carries reason === "stop".
   * This mirrors the final event emitted by `opencode run --format json`.
   */
  isComplete(event: BaseCliEvent): boolean {
    return (
      event.type === OPENCODE_EVENT_TYPES.STEP_FINISH &&
      (event as Record<string, any>).part?.reason ===
        OPENCODE_STEP_FINISH_REASONS.STOP
    );
  }

  override extractLiveContextWindow(
    event: BaseCliEvent,
    _modelId: string
  ): { used: number; size: number } | null {
    if (event.type === OPENCODE_EVENT_TYPES.STEP_FINISH) {
      const tokens = (event as Record<string, any>).part?.tokens as
        Record<string, any> | undefined;
      if (tokens !== undefined) {
        const total = openCodeStepTotal(tokens);
        if (total !== undefined) {
          this.liveLastStepTotal = total;
        }
      }
    }
    const size = this.contextWindowSizeFn();
    if (
      this.liveLastStepTotal !== undefined &&
      this.liveLastStepTotal > 0 &&
      size
    ) {
      return { used: this.liveLastStepTotal, size };
    }
    return null;
  }

  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events) {
      const sessionID = (event as Record<string, any>).sessionID;
      if (typeof sessionID === "string") {
        return sessionID;
      }
    }
    return null;
  }

  /**
   * Classify a synthetic `user_text` event (see `extractNewEventsFromExport`,
   * which emits these for `user`-role message text parts — a shape OpenCode's
   * export never mixes with tool results or resume signals, so the only
   * distinction needed is against ctrlyoke's own sent prompt).
   */
  override classifyUserEvent(
    event: BaseCliEvent,
    ctx: { dispatchedPromptText?: string }
  ): UserEventClassification {
    if (event.type === OPENCODE_EVENT_TYPES.BACKGROUND_NOTICE) {
      return "resume-signal";
    }
    if (event.type !== OPENCODE_EVENT_TYPES.USER_TEXT) {
      return "other";
    }
    const text = (
      (event as Record<string, any>).text as string | undefined
    )?.trim();
    if (!text) {
      return "other";
    }

    if (ctx.dispatchedPromptText) {
      const normalizedDispatched = this.normalizePromptForMatching(
        ctx.dispatchedPromptText.substring(0, 100)
      );
      const normalizedLogged = this.normalizePromptForMatching(
        text.substring(0, 100)
      );
      if (normalizedLogged.includes(normalizedDispatched)) {
        return "injected-prompt";
      }
    }

    return "human-steer";
  }

  override extractUserSteerText(event: BaseCliEvent): string | undefined {
    if (event.type !== OPENCODE_EVENT_TYPES.USER_TEXT) {
      return undefined;
    }
    const text = (
      (event as Record<string, any>).text as string | undefined
    )?.trim();
    return text || undefined;
  }

  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    if (event.type !== OPENCODE_EVENT_TYPES.TEXT) {
      return undefined;
    }
    return (event as Record<string, any>).part?.text as string | undefined;
  }

  /**
   * Extract structured CliEvents from a single OpenCode log event for streaming.
   *
   * OpenCode events are already strongly typed by `convertPartToEvent`, so this
   * mirrors the `extractResponse` switch exactly but for a single event:
   * - `text`               → TEXT CliEvent
   * - `thinking`           → THINKING CliEvent
   * - `tool_use`           → semantic tool/question event via mapOpenCodeToolPartToCliEvent
   *
   * step_start and step_finish carry no displayable content and produce no events.
   */
  extractStructuredEventsFromEvent(event: BaseCliEvent): CliEvent[] {
    this.registerTaskSpawn(event);
    const e = event as Record<string, any>;
    const cliEvents: CliEvent[] = [];
    const timestamp = e.timestamp as number | undefined;

    switch (event.type) {
      case OPENCODE_EVENT_TYPES.TEXT: {
        const text = e.part?.text as string | undefined;
        if (text) {
          cliEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: { text },
          });
        }
        break;
      }
      case CLI_EVENT_TYPES.THINKING: {
        const text = e.part?.text as string | undefined;
        if (text) {
          cliEvents.push({
            type: CLI_EVENT_TYPES.THINKING,
            timestamp,
            data: { text },
          });
        }
        break;
      }
      case OPENCODE_EVENT_TYPES.TOOL_USE: {
        const part = e.part as Record<string, any> | undefined;
        if (part) {
          const toolEvent = mapOpenCodeToolPartToCliEvent(
            timestamp,
            part,
            this.attachedMcpServerIds
          );
          if (toolEvent) {
            cliEvents.push(toolEvent);
          }
        }
        break;
      }
      case OPENCODE_EVENT_TYPES.ERROR: {
        const message = getOpenCodeErrorMessage(e.error);
        if (message) {
          cliEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp,
            data: { text: message },
          });
        }
        break;
      }
      case OPENCODE_EVENT_TYPES.COMPACTION: {
        // Context was compacted to free up the context window
        cliEvents.push({
          type: CLI_EVENT_TYPES.COMPACTION,
          timestamp,
          data: {
            trigger:
              e.part?.auto === false
                ? COMPACTION_TRIGGERS.MANUAL
                : COMPACTION_TRIGGERS.AUTO,
            overflow: e.part?.overflow,
          } as CompactionData,
        });
        break;
      }
      case OPENCODE_EVENT_TYPES.SUBTASK: {
        const taskEvent = mapOpenCodeToolPartToCliEvent(timestamp, e.part);
        if (taskEvent) cliEvents.push(taskEvent);
        break;
      }
      case OPENCODE_EVENT_TYPES.RETRY: {
        // Retry attempt — surface as text so the user sees it
        const attempt = e.part?.attempt as number | undefined;
        const errMsg = e.part?.error as string | undefined;
        const text = errMsg
          ? `\u26a0\ufe0f Retry attempt ${attempt ?? ""}: ${errMsg}`
          : `\u26a0\ufe0f Retry attempt ${attempt ?? ""}`;
        cliEvents.push({
          type: CLI_EVENT_TYPES.TEXT,
          timestamp,
          data: { text },
        });
        break;
      }
    }

    return cliEvents;
  }

  /**
   * Follow the child session of a `task` spawn. Called from both the streaming
   * and the final extraction path: a headless run that does not stream still
   * drains the follower after extractResponse(). `opencode run --format json`
   * reports a spawn as a `tool_use` event for the `task` tool (once it
   * completes), never as a `subtask`.
   */
  private registerTaskSpawn(event: BaseCliEvent): void {
    const rawPart = (event as Record<string, any>).part as
      Record<string, any> | undefined;
    const part = rawPart ? normalizeOpenCodeToolPart(rawPart) : undefined;
    const isTaskSpawn =
      event.type === OPENCODE_EVENT_TYPES.SUBTASK ||
      (event.type === OPENCODE_EVENT_TYPES.TOOL_USE &&
        OPENCODE_SUBAGENT_TOOL_NAMES.has(part?.tool));
    const childSessionId = part?.state?.metadata?.sessionId;
    if (
      !isTaskSpawn ||
      typeof childSessionId !== "string" ||
      typeof part?.callID !== "string" ||
      typeof part?.sessionID !== "string"
    ) {
      return;
    }
    const childModel = part.state?.metadata?.model?.modelID;
    this.registerSubagentSource(
      childSessionId,
      part.callID,
      typeof part.model === "string"
        ? part.model
        : typeof childModel === "string"
          ? childModel
          : "unknown"
    );
  }

  private registerSubagentSource(
    childSessionId: string,
    parentToolCallId: string,
    model: string
  ): void {
    const directory = this.subagentNotifyDir;
    const runId = this.subagentRunId;
    if (!directory || !runId) return;
    const sidecarPath = path.join(
      directory,
      `${runId}${OPENCODE_SUBAGENT_SIDECAR_SUFFIX}`
    );
    this.subagentFollower.register({
      key: childSessionId,
      attribution: { parentToolCallId, agentId: childSessionId },
      read: async (fromOffset) => {
        const result = await readIncrementalJsonl(
          sidecarPath,
          fromOffset,
          isOpenCodeSubagentSidecarRecord
        );
        return {
          ...result,
          records: result.records.filter(
            (record) => record.childSessionId === childSessionId
          ),
        };
      },
      map: (record) => {
        if (record.kind === OPENCODE_SUBAGENT_RECORD_TYPES.CHILD_IDLE)
          return [];
        const part = record.part;
        if (
          record.kind === OPENCODE_SUBAGENT_RECORD_TYPES.TASK_RUNNING &&
          typeof part.state?.metadata?.sessionId === "string" &&
          typeof part.callID === "string"
        ) {
          this.registerSubagentSource(
            part.state.metadata.sessionId,
            part.callID,
            typeof part.modelID === "string" ? part.modelID : model
          );
          return [];
        }
        if (record.kind !== OPENCODE_SUBAGENT_RECORD_TYPES.PART) return [];
        if (part.type === OPENCODE_PART_TYPES.STEP_FINISH) return [];
        if (part.type === OPENCODE_PART_TYPES.TOOL) {
          if (
            typeof part.tool === "string" &&
            OPENCODE_SUBAGENT_TOOL_NAMES.has(part.tool) &&
            typeof part.state?.metadata?.sessionId === "string" &&
            typeof part.callID === "string"
          ) {
            this.registerSubagentSource(
              part.state.metadata.sessionId,
              part.callID,
              typeof part.modelID === "string" ? part.modelID : model
            );
            const taskEvent = mapOpenCodeToolPartToCliEvent(undefined, part);
            return taskEvent ? [taskEvent] : [];
          }
          const event = mapOpenCodeToolPartToCliEvent(undefined, part);
          return event ? [event] : [];
        }
        if (
          (part.type === OPENCODE_PART_TYPES.TEXT ||
            part.type === OPENCODE_PART_TYPES.REASONING) &&
          typeof part.text === "string"
        ) {
          return [
            {
              type:
                part.type === OPENCODE_PART_TYPES.TEXT
                  ? CLI_EVENT_TYPES.TEXT
                  : CLI_EVENT_TYPES.THINKING,
              data: { text: part.text },
            },
          ];
        }
        return [];
      },
      usage: (record) => {
        if (
          record.kind !== OPENCODE_SUBAGENT_RECORD_TYPES.PART ||
          record.part?.type !== OPENCODE_PART_TYPES.STEP_FINISH
        )
          return undefined;
        const tokens = record.part.tokens;
        if (!tokens || typeof tokens !== "object") return undefined;
        const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
        accumulateOpenCodeStepTokens(tokens, usage);
        return {
          model:
            typeof record.part.modelID === "string"
              ? record.part.modelID
              : model,
          recordId: record.part.id,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cachedInputTokens,
        };
      },
      isComplete: (record) =>
        record.kind === OPENCODE_SUBAGENT_RECORD_TYPES.CHILD_IDLE ||
        (record.kind === OPENCODE_SUBAGENT_RECORD_TYPES.TASK_RUNNING &&
          record.part?.state?.status === OPERATION_STATUS.COMPLETED),
    });
  }

  extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
    const cliEvents: CliEvent[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    let sawStepUsage = false;
    let harnessReportedCostUsd = 0;
    let sawHarnessReportedCost = false;
    let responseError: string | undefined;
    const tokenUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let lastStepTotal: number | undefined;

    for (const event of events) {
      const e = event as Record<string, any>;
      this.registerTaskSpawn(event);

      if (typeof e.sessionID === "string" && !sessionId) {
        sessionId = e.sessionID;
      }
      if (typeof e.model === "string" && !model) {
        model = e.model;
      }
      if (typeof e.info?.model === "string" && !model) {
        model = e.info.model;
      }
      if (typeof e.part?.model === "string" && !model) {
        model = e.part.model;
      }

      switch (event.type) {
        case OPENCODE_EVENT_TYPES.TEXT: {
          const text = e.part?.text as string | undefined;
          if (text) {
            cliEvents.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp: e.timestamp as number | undefined,
              data: { text },
            });
          }
          break;
        }
        case CLI_EVENT_TYPES.THINKING: {
          const text = e.part?.text as string | undefined;
          if (text) {
            cliEvents.push({
              type: CLI_EVENT_TYPES.THINKING,
              timestamp: e.timestamp as number | undefined,
              data: { text },
            });
          }
          break;
        }
        case OPENCODE_EVENT_TYPES.TOOL_USE: {
          const part = e.part as Record<string, any> | undefined;
          if (part) {
            const toolEvent = mapOpenCodeToolPartToCliEvent(
              e.timestamp as number | undefined,
              part,
              this.attachedMcpServerIds
            );
            if (toolEvent) {
              cliEvents.push(toolEvent);
            }
          }
          break;
        }
        case OPENCODE_EVENT_TYPES.ERROR: {
          responseError = getOpenCodeErrorMessage(e.error);
          if (responseError) {
            cliEvents.push({
              type: CLI_EVENT_TYPES.TEXT,
              timestamp: e.timestamp as number | undefined,
              data: { text: responseError },
            });
          }
          break;
        }
        case OPENCODE_EVENT_TYPES.COMPACTION: {
          cliEvents.push({
            type: CLI_EVENT_TYPES.COMPACTION,
            timestamp: e.timestamp as number | undefined,
            data: {
              trigger:
                e.part?.auto === false
                  ? COMPACTION_TRIGGERS.MANUAL
                  : COMPACTION_TRIGGERS.AUTO,
              overflow: e.part?.overflow,
            } as CompactionData,
          });
          break;
        }
        case OPENCODE_EVENT_TYPES.SUBTASK: {
          cliEvents.push({
            type: CLI_EVENT_TYPES.TOOL_CALL,
            timestamp: e.timestamp as number | undefined,
            data: {
              name: OPENCODE_TOOL_NAMES.TASK,
              parameters: {
                description: e.part?.description,
                agent: e.part?.agent,
                model: e.part?.model,
              },
            },
          });
          break;
        }
        case OPENCODE_EVENT_TYPES.RETRY: {
          const attempt = e.part?.attempt as number | undefined;
          const errMsg = e.part?.error as string | undefined;
          const text = errMsg
            ? `\u26a0\ufe0f Retry attempt ${attempt ?? ""}: ${errMsg}`
            : `\u26a0\ufe0f Retry attempt ${attempt ?? ""}`;
          cliEvents.push({
            type: CLI_EVENT_TYPES.TEXT,
            timestamp: e.timestamp as number | undefined,
            data: { text },
          });
          break;
        }
        case OPENCODE_EVENT_TYPES.STEP_FINISH: {
          const tokens = e.part?.tokens as Record<string, any> | undefined;
          if (tokens) {
            sawStepUsage = true;
            const stepTotal = accumulateOpenCodeStepTokens(tokens, tokenUsage);
            if (stepTotal !== undefined) lastStepTotal = stepTotal;
          }
          if (
            typeof e.part?.cost === "number" &&
            Number.isFinite(e.part.cost) &&
            e.part.cost >= 0
          ) {
            harnessReportedCostUsd += e.part.cost;
            sawHarnessReportedCost = true;
          }
          break;
        }
      }
    }

    if (lastStepTotal !== undefined) {
      tokenUsage.contextWindowUsedTokens = lastStepTotal;
    }
    const contextWindowSize = this.contextWindowSizeFn();
    if (contextWindowSize !== undefined) {
      tokenUsage.contextWindowSize = contextWindowSize;
    }

    return {
      events: cliEvents,
      metadata: {
        sessionId,
        model: (model ?? this.resolvedModel) || undefined,
        harness: HARNESS_IDS.OPENCODE_CLI,
        ...(responseError ? { error: responseError } : {}),
        ...(sawHarnessReportedCost ? { harnessReportedCostUsd } : {}),
        usage: sawStepUsage ? tokenUsage : undefined,
      },
    };
  }

  formatStatistics(metadata: BaseCliEvent): string {
    const parts = this.buildCommonStatisticsParts(metadata, 8, "...");
    return parts.join(" | ");
  }

  async getFinalEventsOnCompletion(sessionId: string): Promise<BaseCliEvent[]> {
    return this.fetchNewEvents(sessionId);
  }

  // ──────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Run `opencode export <sessionId>` and return only parts not yet seen.
   * Updates seenPartIds so repeated calls are incremental.
   */
  private async fetchNewEvents(sessionId: string): Promise<BaseCliEvent[]> {
    try {
      const stdout = await this.runExport(sessionId);
      const exportData = JSON.parse(stdout) as OpenCodeExport;
      return this.extractNewEventsFromExport(exportData);
    } catch (error) {
      // Every failed poll here means the session's events since the last
      // successful export are silently dropped (the next successful export
      // only yields parts newer than seenPartIds, so nothing is retried).
      // Surface at warn — this is data loss, not routine noise.
      Log.warn(`[OpenCodeLogParser] opencode export failed: ${error}`);
      return [];
    }
  }

  /**
   * Walk export messages in chronological order and emit events for
   * any parts not already tracked in seenPartIds.
   *
   * Parts are only marked seen once they are in a final/completed state.
   * OpenCode writes parts incrementally (same ID, status pending → completed),
   * so a part polled while still running would have empty input/text.
   * Skipping incomplete parts lets the next poll pick them up when finished.
   */
  private extractNewEventsFromExport(
    exportData: OpenCodeExport
  ): BaseCliEvent[] {
    const newEvents: BaseCliEvent[] = [];

    for (const message of exportData.messages) {
      if (isOpenCodeV2ExportMessage(message)) {
        newEvents.push(
          ...this.extractNewEventsFromV2Message(message, exportData.info.id)
        );
        continue;
      }
      const messageTimestamp = message.info.time?.created ?? Date.now();

      // User messages carry no displayable AI output, but their `text` parts
      // are candidate user-steer events (ctrlyoke's own sent prompt, or a
      // genuine follow-up typed into the live TUI) — see classifyUserEvent.
      // Unlike assistant parts, user text is already final the moment it
      // appears in the export, so isPartCompleted's streaming check doesn't apply.
      if (message.info.role === OPENCODE_MESSAGE_ROLES.USER) {
        for (const part of message.parts) {
          if (
            this.seenPartIds.has(part.id) ||
            part.type !== OPENCODE_EVENT_TYPES.TEXT
          ) {
            continue;
          }
          this.seenPartIds.add(part.id);
          const text = (part as any).text as string | undefined;
          if (text && text.trim()) {
            newEvents.push({
              type: OPENCODE_EVENT_TYPES.USER_TEXT,
              sessionID: part.sessionID,
              timestamp: (part as any).time?.start ?? messageTimestamp,
              text: text.trim(),
            });
          }
        }
        continue;
      }

      // Only assistant messages contain displayable AI-output events
      if (message.info.role !== OPENCODE_MESSAGE_ROLES.ASSISTANT) {
        continue;
      }

      for (const part of message.parts) {
        if (this.seenPartIds.has(part.id)) {
          continue;
        }

        // Skip parts that are still in-progress so we don't capture partial data.
        // They will be picked up on the next poll once finalized.
        if (!this.isPartCompleted(part)) {
          continue;
        }

        this.seenPartIds.add(part.id);

        const event = this.convertPartToEvent(part, messageTimestamp);
        if (event) {
          newEvents.push(event);
        }
      }
    }

    return newEvents;
  }

  /**
   * Convert one OpenCode 2 export message into the same JSONL-style events
   * `opencode run --format json` emits, skipping anything already emitted.
   *
   * Content items have no ids, so each is keyed by message id and position;
   * OpenCode appends content and never reorders it. A text or reasoning item
   * is only final once a later item follows it or the message completes, and
   * a tool item once its state is completed or error, matching the
   * partial-data rule isPartCompleted() applies to OpenCode 1 parts.
   */
  private extractNewEventsFromV2Message(
    message: OpenCodeV2ExportMessage,
    sessionID: string
  ): BaseCliEvent[] {
    const events: BaseCliEvent[] = [];
    const created = message.time?.created ?? Date.now();
    const claim = (key: string): boolean => {
      if (this.seenPartIds.has(key)) return false;
      this.seenPartIds.add(key);
      return true;
    };

    if (message.type === OPENCODE_V2_MESSAGE_TYPES.USER) {
      if (message.text?.trim() && claim(message.id)) {
        events.push({
          type: OPENCODE_EVENT_TYPES.USER_TEXT,
          sessionID,
          timestamp: created,
          text: message.text.trim(),
        });
      }
      return events;
    }

    if (message.type === OPENCODE_V2_MESSAGE_TYPES.COMPACTION) {
      if (message.status === OPERATION_STATUS.COMPLETED && claim(message.id)) {
        events.push({
          type: OPENCODE_EVENT_TYPES.COMPACTION,
          sessionID,
          timestamp: created,
          part: { auto: message.reason !== COMPACTION_TRIGGERS.MANUAL },
        });
      }
      return events;
    }

    // A background job's completion notice. Synthetic messages from other
    // sources (plans, goals, instructions) name no job and are skipped.
    if (message.type === OPENCODE_V2_MESSAGE_TYPES.SYNTHETIC) {
      const taskId = openCodeBackgroundNoticeTaskId(message.metadata);
      if (taskId && claim(message.id)) {
        events.push({
          type: OPENCODE_EVENT_TYPES.BACKGROUND_NOTICE,
          sessionID,
          timestamp: created,
          taskId,
        });
      }
      return events;
    }

    if (message.type === OPENCODE_V2_MESSAGE_TYPES.IDLE) {
      if (claim(message.id)) {
        events.push({
          type: OPENCODE_EVENT_TYPES.IDLE,
          sessionID,
          timestamp: created,
        });
      }
      return events;
    }

    if (message.type !== OPENCODE_V2_MESSAGE_TYPES.ASSISTANT) {
      return events;
    }

    const completed = message.time?.completed !== undefined;
    const content = message.content ?? [];
    content.forEach((item, index) => {
      const key = `${message.id}:${index}`;
      if (this.seenPartIds.has(key)) return;
      if (item.type === OPENCODE_V2_CONTENT_TYPES.TOOL) {
        const status = item.state?.status;
        if (
          status !== OPERATION_STATUS.COMPLETED &&
          status !== OPENCODE_TOOL_STATUS.ERROR
        ) {
          return;
        }
        claim(key);
        const timestamp = item.time?.created ?? created;
        events.push({
          type: OPENCODE_EVENT_TYPES.TOOL_USE,
          sessionID,
          timestamp,
          part: normalizeOpenCodeToolPart(item),
        });
        const launch = openCodeBackgroundLaunch(item);
        if (launch) {
          events.push({
            type: OPENCODE_EVENT_TYPES.BACKGROUND_LAUNCH,
            sessionID,
            timestamp,
            ...launch,
          });
        }
        return;
      }
      const isText = item.type === OPENCODE_V2_CONTENT_TYPES.TEXT;
      const isReasoning = item.type === OPENCODE_V2_CONTENT_TYPES.REASONING;
      if (!isText && !isReasoning) return;
      if (!completed && index === content.length - 1) return;
      claim(key);
      events.push({
        type: isText ? OPENCODE_EVENT_TYPES.TEXT : CLI_EVENT_TYPES.THINKING,
        sessionID,
        timestamp: item.time?.created ?? created,
        part: { text: item.text },
      });
    });

    if (
      message.retry &&
      claim(`${message.id}:retry:${message.retry.attempt}`)
    ) {
      events.push({
        type: OPENCODE_EVENT_TYPES.RETRY,
        sessionID,
        timestamp: created,
        part: {
          attempt: message.retry.attempt,
          error: getOpenCodeErrorMessage(message.retry.error),
        },
      });
    }

    if (completed && claim(`${message.id}:finish`)) {
      if (message.error !== undefined) {
        events.push({
          type: OPENCODE_EVENT_TYPES.ERROR,
          sessionID,
          timestamp: message.time?.completed ?? created,
          error: message.error,
        });
      }
      events.push({
        type: OPENCODE_EVENT_TYPES.STEP_FINISH,
        sessionID,
        timestamp: message.time?.completed ?? created,
        ...(message.model?.id ? { model: message.model.id } : {}),
        part: {
          reason: message.finish,
          tokens: message.tokens,
          cost: message.cost,
        },
      });
    }

    return events;
  }

  /**
   * Returns true when a part has reached its final state and its data is safe
   * to capture. OpenCode updates parts in-place as they progress, so we must
   * wait for completion before recording to avoid empty/partial fields.
   */
  private isPartCompleted(part: OpenCodeExportPart): boolean {
    const p = part as any;
    switch (part.type) {
      case OPENCODE_PART_TYPES.TOOL:
        // Tool parts transition through pending and a terminal completed/error state.
        return (
          p.state?.status === OPERATION_STATUS.COMPLETED ||
          p.state?.status === OPENCODE_TOOL_STATUS.ERROR
        );
      case OPENCODE_EVENT_TYPES.TEXT:
      case OPENCODE_PART_TYPES.REASONING:
        // Text/reasoning parts are finalized when time.end is set.
        return p.time?.end !== undefined;
      default:
        // step-start, step-finish, patch, etc. are atomic and always final.
        return true;
    }
  }

  /**
   * Convert an opencode export part to a JSONL-style BaseCliEvent.
   *
   * The resulting event shape matches what `opencode run --format json` emits,
   * so extractResponse / isComplete / extractContentFromEvent work uniformly
   * for both headless (streaming) and interactive (export-polled) modes.
   *
   * Part type mapping:
   *   step-start   → step_start
   *   step-finish  → step_finish  (carries reason + tokens)
   *   text         → text         (carries part.text)
   *   tool         → tool_use     (carries part.tool + part.state; `question`
   *                                becomes ASK_USER_QUESTION)
   *   reasoning    → thinking     (carries part.text — extended thinking content)
   *   compaction   → compaction   (carries auto + overflow flags)
   *   subtask      → subtask      (carries description + agent + model)
   *   retry        → retry        (carries attempt + error message)
   *   patch        → (skipped)
   *   snapshot     → (skipped)
   *   file         → (skipped — user file attachments, not AI output)
   *   agent        → (skipped — internal routing metadata)
   */
  private convertPartToEvent(
    part: OpenCodeExportPart,
    messageTimestamp: number
  ): BaseCliEvent | null {
    const { sessionID } = part;

    switch (part.type) {
      case OPENCODE_PART_TYPES.STEP_START:
        return {
          type: OPENCODE_EVENT_TYPES.STEP_START,
          sessionID,
          timestamp: messageTimestamp,
          part,
        };

      case OPENCODE_PART_TYPES.STEP_FINISH:
        return {
          type: OPENCODE_EVENT_TYPES.STEP_FINISH,
          sessionID,
          timestamp: messageTimestamp,
          part: {
            reason: (part as any).reason,
            tokens: (part as any).tokens,
            cost: (part as any).cost,
          },
        };

      case OPENCODE_EVENT_TYPES.TEXT:
        return {
          type: OPENCODE_EVENT_TYPES.TEXT,
          sessionID,
          timestamp: (part as any).time?.start ?? messageTimestamp,
          part: { text: (part as any).text },
        };

      case OPENCODE_PART_TYPES.REASONING:
        return {
          type: CLI_EVENT_TYPES.THINKING,
          sessionID,
          timestamp: (part as any).time?.start ?? messageTimestamp,
          part: { text: (part as any).text },
        };

      case OPENCODE_PART_TYPES.TOOL:
        return {
          type: OPENCODE_EVENT_TYPES.TOOL_USE,
          sessionID,
          timestamp: (part as any).state?.time?.start ?? messageTimestamp,
          part: {
            tool: (part as any).tool,
            callID: (part as any).callID,
            state: (part as any).state,
          },
        };

      case OPENCODE_PART_TYPES.COMPACTION:
        // Context was compacted to free up the context window
        return {
          type: OPENCODE_EVENT_TYPES.COMPACTION,
          sessionID,
          timestamp: messageTimestamp,
          part: {
            auto: (part as any).auto,
            overflow: (part as any).overflow,
          },
        };

      case OPENCODE_PART_TYPES.SUBTASK:
        // A subagent was spawned via the task tool
        return {
          type: OPENCODE_EVENT_TYPES.SUBTASK,
          sessionID,
          timestamp: messageTimestamp,
          part: {
            description: (part as any).description,
            agent: (part as any).agent,
            model: (part as any).model,
            prompt: (part as any).prompt,
          },
        };

      case OPENCODE_EVENT_TYPES.RETRY:
        // Retry attempt — surface as a visible event
        return {
          type: "retry",
          sessionID,
          timestamp: (part as any).time?.created ?? messageTimestamp,
          part: {
            attempt: (part as any).attempt,
            error: (part as any).error,
          },
        };

      default:
        return null;
    }
  }
}

/**
 * OpenCode 1 errors are `{ name, data: { message } }`; OpenCode 2 errors are
 * `{ type, message }`.
 */
function getOpenCodeErrorMessage(error: unknown): string | undefined {
  const details = error as
    | { name?: unknown; message?: unknown; data?: { message?: unknown } }
    | undefined;
  const message = details?.data?.message ?? details?.message ?? details?.name;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : undefined;
}
