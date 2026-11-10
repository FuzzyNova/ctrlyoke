import { TOOL_PERMISSION_CATEGORIES } from "../../../types/DashboardConstants";
import { versionSatisfies } from "../../../utils/HarnessVersion";

/** Wire-level values from OpenCode's exported message/part protocol. */
export const OPENCODE_MESSAGE_ROLES = {
  USER: "user",
  ASSISTANT: "assistant",
} as const;

export const OPENCODE_EVENT_TYPES = {
  TEXT: "text",
  TOOL_USE: "tool_use",
  ERROR: "error",
  USER_TEXT: "user_text",
  RETRY: "retry",
  STEP_START: "step_start",
  STEP_FINISH: "step_finish",
  COMPACTION: "compaction",
  SUBTASK: "subtask",
  /**
   * ctrlyoke-synthesised from an OpenCode 2 export: a tool call started a
   * background job (`background_launch`), that job's completion notice was
   * delivered to the session (`background_notice`), or a session execution
   * ended (`idle`). They carry no display content; they drive
   * `OpenCodeLogParser.trackBackgroundWorkState`.
   */
  BACKGROUND_LAUNCH: "background_launch",
  BACKGROUND_NOTICE: "background_notice",
  IDLE: "idle",
  /**
   * ctrlyoke-synthesised, for subagent child sessions. A completed `subagent`
   * call names its child (`subagent_session`); the child's own export then
   * yields the same lifecycle as above, renamed so it never reads as the
   * parent's (`child_background_launch`, `child_background_notice`,
   * `child_idle`), plus `child_busy` when a read finds the child mid-execution.
   * A child wakes again for its own background work without telling its
   * parent, so the parent step has to watch it directly.
   */
  SUBAGENT_SESSION: "subagent_session",
  CHILD_BACKGROUND_LAUNCH: "child_background_launch",
  CHILD_BACKGROUND_NOTICE: "child_background_notice",
  CHILD_IDLE: "child_idle",
  CHILD_BUSY: "child_busy",
} as const;

/** Lifecycle events from a child's export, renamed to their child form. */
export const OPENCODE_CHILD_LIFECYCLE_EVENT_TYPES: Readonly<
  Record<string, string>
> = {
  [OPENCODE_EVENT_TYPES.BACKGROUND_LAUNCH]:
    OPENCODE_EVENT_TYPES.CHILD_BACKGROUND_LAUNCH,
  [OPENCODE_EVENT_TYPES.BACKGROUND_NOTICE]:
    OPENCODE_EVENT_TYPES.CHILD_BACKGROUND_NOTICE,
  [OPENCODE_EVENT_TYPES.IDLE]: OPENCODE_EVENT_TYPES.CHILD_IDLE,
  [OPENCODE_EVENT_TYPES.SUBAGENT_SESSION]:
    OPENCODE_EVENT_TYPES.SUBAGENT_SESSION,
};

/** Terminal states reported by OpenCode for tool parts. */
export const OPENCODE_TOOL_STATUS = {
  ERROR: "error",
} as const;

export const OPENCODE_PART_TYPES = {
  TOOL: "tool",
  TEXT: "text",
  REASONING: "reasoning",
  STEP_START: "step-start",
  STEP_FINISH: "step-finish",
  COMPACTION: "compaction",
  SUBTASK: "subtask",
} as const;

export const OPENCODE_TOOL_NAMES = {
  BASH: TOOL_PERMISSION_CATEGORIES.BASH,
  /** OpenCode 2 name for the shell tool (OpenCode 1 called it `bash`). */
  SHELL: "shell",
  WRITE: TOOL_PERMISSION_CATEGORIES.WRITE,
  EDIT: TOOL_PERMISSION_CATEGORIES.EDIT,
  READ: TOOL_PERMISSION_CATEGORIES.READ,
  /** Spawns a subagent in a child session. */
  TASK: "task",
  /** OpenCode 2 name for the subagent tool (OpenCode 1 called it `task`). */
  SUBAGENT: "subagent",
} as const;

/** OpenCode 1 and 2 names for the shell tool. */
export const OPENCODE_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  OPENCODE_TOOL_NAMES.BASH,
  OPENCODE_TOOL_NAMES.SHELL,
]);

/** OpenCode 1 and 2 names for the tool that spawns a child session. */
export const OPENCODE_SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  OPENCODE_TOOL_NAMES.TASK,
  OPENCODE_TOOL_NAMES.SUBAGENT,
]);

/**
 * Message `type` values in an OpenCode 2 `session export`. OpenCode 1 exports
 * `{ info: { role }, parts }` instead; parsers tell the two apart by shape.
 */
export const OPENCODE_V2_MESSAGE_TYPES = {
  USER: "user",
  ASSISTANT: "assistant",
  COMPACTION: "compaction",
  /**
   * Text OpenCode injects into the session itself. A finished background job
   * (shell, subagent, image) reports through one, naming the job in
   * `metadata`, and wakes the session for a resumed turn.
   */
  SYNTHETIC: "synthetic",
  /** Ends every session execution, whatever its `outcome`. */
  IDLE: "idle",
  /**
   * A notice OpenCode records itself, such as a changed tool catalog. It is
   * not tied to an execution, so it says nothing about whether one is running.
   */
  SYSTEM: "system",
} as const;

/**
 * `state.metadata.status` of a tool call whose work continues as a background
 * job after the call returns (OpenCode 2 `shell` with `background: true` or
 * moved to the background mid-run, and `subagent` with `background: true`).
 */
export const OPENCODE_BACKGROUND_TOOL_STATUS = "running";

/**
 * OpenCode 2's experimental image tool. It always runs as a background job
 * and reports `metadata.jobID` with no running status (read from source,
 * packages/core/src/tool/plugin/image-generate.ts; not yet captured).
 */
export const OPENCODE_IMAGE_TOOL_NAME = "experimental_image_generate";

/** Content item types inside an OpenCode 2 assistant message. */
export const OPENCODE_V2_CONTENT_TYPES = {
  TEXT: "text",
  REASONING: "reasoning",
  TOOL: "tool",
} as const;

/** First OpenCode release with the V2 CLI, plugin API and server. */
const OPENCODE_V2_MIN_VERSION = "2.0.0";

/** `opencode --version`: `1.19.5` on OpenCode 1, `opencode v2.2.5` on OpenCode 2. */
export const OPENCODE_VERSION_COMMAND = "opencode --version";

/**
 * Model discovery commands. OpenCode 1 prints each model ID followed by a JSON
 * block carrying `limit.context`. OpenCode 2 dropped `--verbose` (it exits 1
 * and prints the help text), and its `opencode models` prints bare IDs only,
 * so it is asked through the public `model.list` API operation instead: the
 * same list `opencode models` prints (`providerID/id` of each entry), with each
 * model's `limit.context`, for the same cost.
 */
export const OPENCODE_MODELS_COMMANDS = {
  V1: "opencode models --verbose",
  V2: "opencode api model.list",
} as const;

/**
 * Whether a raw `opencode --version` string is an OpenCode 2 release. Lives
 * here rather than in `OpenCodeVersion.ts` so `vscode`-free code such as
 * `ModelRegistry` can use it without loading the CLI provider utilities.
 */
export function isOpenCodeV2Version(rawVersion: string | undefined): boolean {
  return (
    rawVersion !== undefined &&
    versionSatisfies(rawVersion, `>=${OPENCODE_V2_MIN_VERSION}`)
  );
}

export const OPENCODE_STEP_FINISH_REASONS = {
  STOP: "stop",
} as const;

export const OPENCODE_SUBAGENT_RECORD_TYPES = {
  PART: "part",
  TASK_RUNNING: "task-running",
  CHILD_IDLE: "child-idle",
} as const;

/** OpenCode CLI flags that ctrlyoke both writes and reads back. */
export const OPENCODE_CLI_FLAGS = {
  MODEL: "-m",
  SESSION: "-s",
  PROMPT: "--prompt",
  /**
   * OpenCode 2 only. Without it the CLI attaches to a shared, long-lived
   * background service that never sees this launch's environment, so the
   * inline config (plugin, MCP, permissions) and `CTRLYOKE_*` variables would
   * be lost and one plugin instance would observe every session on the machine.
   */
  STANDALONE: "--standalone",
} as const;

/**
 * The ctrlyoke plugin as installed under `out/scripts/`: a single file for
 * OpenCode 1, and a directory for OpenCode 2, whose `index.ts` adapts the V2
 * plugin API onto the same file's handlers.
 */
export const OPENCODE_PLUGIN_PATHS = {
  V1_FILE: "ctrlyoke-opencode-plugin.ts",
  V2_DIRECTORY: "ctrlyoke-opencode-plugin-v2",
} as const;

/**
 * OpenCode permission keys that are not tools. `external_directory` gates any
 * tool's access to a path outside the launch directory: OpenCode 1 asks by
 * default, OpenCode 2 allows.
 */
export const OPENCODE_PERMISSION_KEYS = {
  EXTERNAL_DIRECTORY: "external_directory",
} as const;

/** OpenCode 1 `export <id>` vs OpenCode 2 `session export <id>`. */
export const OPENCODE_EXPORT_COMMANDS = {
  V1: ["export"],
  V2: ["session", "export"],
} as const;

/** OpenCode config filenames, in the load order used for each config directory. */
export const OPENCODE_CONFIG_FILENAMES = [
  "config.json",
  "opencode.json",
  "opencode.jsonc",
] as const;

/** Config filenames OpenCode loads from project and custom config directories. */
export const OPENCODE_PROJECT_CONFIG_FILENAMES = [
  "opencode.json",
  "opencode.jsonc",
] as const;

/**
 * How a resumed interactive launch (`--session`) hands its prompt to OpenCode.
 *
 * - `ARGUMENT`: pass `--prompt` alongside `--session`, as for a new session.
 * - `PLUGIN`: omit `--prompt`; the ctrlyoke plugin submits the prompt to the
 *   resumed session through OpenCode's server once that server is up.
 */
export const OPENCODE_RESUMED_PROMPT_DELIVERIES = {
  ARGUMENT: "argument",
  PLUGIN: "plugin",
} as const;

export type OpenCodeResumedPromptDelivery =
  (typeof OPENCODE_RESUMED_PROMPT_DELIVERIES)[keyof typeof OPENCODE_RESUMED_PROMPT_DELIVERIES];

/**
 * Environment the ctrlyoke plugin reads to submit a resumed session's prompt.
 * `src/scripts/ctrlyoke-opencode-plugin.ts` cannot import this module, so it
 * repeats these names; keep the two in step.
 */
export const OPENCODE_RESUME_PROMPT_ENV = {
  PROMPT: "CTRLYOKE_OPENCODE_RESUME_PROMPT",
  SESSION: "CTRLYOKE_OPENCODE_RESUME_SESSION",
  MODEL: "CTRLYOKE_OPENCODE_RESUME_MODEL",
} as const;
