import { TOOL_PERMISSION_CATEGORIES } from "../../../types/DashboardConstants";

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
} as const;

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
} as const;

/** Content item types inside an OpenCode 2 assistant message. */
export const OPENCODE_V2_CONTENT_TYPES = {
  TEXT: "text",
  REASONING: "reasoning",
  TOOL: "tool",
} as const;

/** First OpenCode release with the V2 CLI, plugin API and server. */
export const OPENCODE_V2_MIN_VERSION = "2.0.0";

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
