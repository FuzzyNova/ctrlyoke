import * as os from "os";
import * as path from "path";

/**
 * The one place that knows where each harness CLI keeps its global
 * (per-user) config and state directory.
 *
 * Several CLIs let the user move that directory with an environment
 * variable. ctrlyoke spawns the CLI with its own environment, so the CLI uses
 * the moved directory, and every path ctrlyoke reads or writes beside it (log
 * transcripts, user settings, MCP and LSP config, agents, skills) has to
 * follow it too. Build those paths from these resolvers, never from
 * `os.homedir()` plus a `.claude`/`.qwen`/`.copilot`/`.codex` segment: a lint
 * test fails on such joins anywhere else in `src/`.
 *
 * None of the spawn envs ctrlyoke builds (`getHeadlessSpawnEnv`,
 * `getInteractiveSpawnEnv`) sets these variables, so the harness inherits
 * them from ctrlyoke's own `process.env`, which is what the resolvers default
 * to. Each takes `env` so tests can inject one.
 *
 * Deliberately dependency-free (no `vscode`, no config service) so the
 * real-harness test helpers, which run under plain Mocha, can import it.
 */

/** Environment a resolver reads. */
export type HarnessHomeEnv = Readonly<Record<string, string | undefined>>;

/** The environment variables the harness CLIs read to move their home. */
export const HARNESS_HOME_ENV_VARS = {
  /** Claude Code: replaces `~/.claude`, and moves `~/.claude.json` into it. */
  CLAUDE_CONFIG_DIR: "CLAUDE_CONFIG_DIR",
  /** Qwen Code: replaces `~/.qwen` (config, user settings, agents, skills). */
  QWEN_HOME: "QWEN_HOME",
  /** Qwen Code: moves runtime output (session transcripts under `projects/`). */
  QWEN_RUNTIME_DIR: "QWEN_RUNTIME_DIR",
  /** Copilot CLI: replaces `~/.copilot` (config and state). */
  COPILOT_HOME: "COPILOT_HOME",
  /** Codex: replaces `~/.codex`. */
  CODEX_HOME: "CODEX_HOME",
  /** XDG base directory; OpenCode keeps its global config under `opencode/`. */
  XDG_CONFIG_HOME: "XDG_CONFIG_HOME",
} as const;

const CLAUDE_DIR = ".claude";
const CLAUDE_GLOBAL_CONFIG_FILE = ".claude.json";
const QWEN_DIR = ".qwen";
const COPILOT_DIR = ".copilot";
const CODEX_DIR = ".codex";
const OPENCODE_DIR = "opencode";

/**
 * A configured directory override, or `undefined` when the variable is unset
 * or blank (every CLI treats an empty value as unset). A leading `~` is
 * expanded and a relative value resolved, matching Qwen's
 * `Storage.resolvePath`; the other CLIs normally receive a value the shell
 * already expanded, which this leaves unchanged.
 */
function readDirOverride(
  env: HarnessHomeEnv,
  name: (typeof HARNESS_HOME_ENV_VARS)[keyof typeof HARNESS_HOME_ENV_VARS]
): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    return undefined;
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(1));
  }
  return path.resolve(value);
}

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function getClaudeConfigDir(env: HarnessHomeEnv = process.env): string {
  return (
    readDirOverride(env, HARNESS_HOME_ENV_VARS.CLAUDE_CONFIG_DIR) ??
    path.join(os.homedir(), CLAUDE_DIR)
  );
}

/**
 * Claude Code's global config file (user MCP servers, folder trust):
 * `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when the config
 * directory is moved. Unlike everything else Claude keeps, the default lives
 * beside `~/.claude`, not inside it.
 */
export function getClaudeGlobalConfigPath(
  env: HarnessHomeEnv = process.env
): string {
  const configDir = readDirOverride(
    env,
    HARNESS_HOME_ENV_VARS.CLAUDE_CONFIG_DIR
  );
  return path.join(configDir ?? os.homedir(), CLAUDE_GLOBAL_CONFIG_FILE);
}

/**
 * Qwen Code's global directory (`Storage.getGlobalQwenDir`): `QWEN_HOME`,
 * else `~/.qwen`. User `settings.json`, agents and skills live here.
 */
export function getQwenHomeDir(env: HarnessHomeEnv = process.env): string {
  return (
    readDirOverride(env, HARNESS_HOME_ENV_VARS.QWEN_HOME) ??
    path.join(os.homedir(), QWEN_DIR)
  );
}

/**
 * Qwen Code's runtime output directory (`Storage.getRuntimeBaseDir`), which
 * holds session transcripts under `projects/`: `QWEN_RUNTIME_DIR`, else the
 * Qwen home. Qwen's `advanced.runtimeOutputDir` setting ranks between the
 * two; it is not read here.
 */
export function getQwenRuntimeDir(env: HarnessHomeEnv = process.env): string {
  return (
    readDirOverride(env, HARNESS_HOME_ENV_VARS.QWEN_RUNTIME_DIR) ??
    getQwenHomeDir(env)
  );
}

/**
 * Copilot CLI's config and state directory: `COPILOT_HOME`, else
 * `~/.copilot`. Copilot 1.0.x no longer reads `XDG_CONFIG_HOME` or
 * `XDG_STATE_HOME`; it migrates directories found there into `~/.copilot`.
 */
export function getCopilotHomeDir(env: HarnessHomeEnv = process.env): string {
  return (
    readDirOverride(env, HARNESS_HOME_ENV_VARS.COPILOT_HOME) ??
    path.join(os.homedir(), COPILOT_DIR)
  );
}

/** Codex's home directory: `CODEX_HOME`, else `~/.codex`. */
export function getCodexHomeDir(env: HarnessHomeEnv = process.env): string {
  return (
    readDirOverride(env, HARNESS_HOME_ENV_VARS.CODEX_HOME) ??
    path.join(os.homedir(), CODEX_DIR)
  );
}

/**
 * OpenCode's global config directory: `$XDG_CONFIG_HOME/opencode`, else
 * `~/.config/opencode`. `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` add
 * further config sources on top of it; callers that read those handle them.
 */
export function getOpenCodeGlobalConfigDir(
  env: HarnessHomeEnv = process.env
): string {
  const configHome =
    readDirOverride(env, HARNESS_HOME_ENV_VARS.XDG_CONFIG_HOME) ??
    path.join(os.homedir(), ".config");
  return path.join(configHome, OPENCODE_DIR);
}
