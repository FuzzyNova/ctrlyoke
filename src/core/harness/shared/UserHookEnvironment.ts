import * as crypto from "crypto";
import * as path from "path";
import type {
  OpenCodeUserHookConfig,
  PreparedUserHookConfig,
  UserHookConfig,
} from "../../../types/CtrlYokeTypes";
import { HARNESS_IDS } from "../../../types/DashboardConstants";
import { CliNotificationMonitor } from "./CliNotificationMonitor";
import type { PreparedMutation } from "./interfaces/PreparedMutation";

export interface PreparedUserHookEnvironments {
  readonly hooks: OpenCodeUserHookConfig[] | undefined;
  readonly tempFilePath?: string;
  readonly mutation?: PreparedMutation;
}

/** Per-hook data written to the temporary environment file for the launcher. */
export interface UserHookEnvironmentEntry {
  env: Record<string, string>;
  timeoutSec?: number;
}

function hasHookEnvironment(hook: UserHookConfig): boolean {
  return Object.keys(hook.env ?? {}).length > 0;
}

/**
 * On Windows, Qwen Code runs a command hook as
 * `spawn(ComSpec, ["/d", "/s", "/c", command], { shell: false })` unless it was
 * itself started from Git Bash. Node escapes every `"` in that argument to
 * `\"`, which cmd.exe passes on literally, so a hook such as
 * `node "C:/my scripts/hook.js"` silently never runs. The launcher spawns the
 * command with `shell: true`, whose cmd.exe quoting is correct.
 */
function harnessBreaksQuotedHookCommands(
  harnessId: string | undefined
): boolean {
  return process.platform === "win32" && harnessId === HARNESS_IDS.QWEN_CLI;
}

/**
 * Whether `hook` must run through `ctrlyoke-hook-run.js` instead of being handed
 * to the harness verbatim: it carries resolved environment values, or the
 * harness's own launch would mangle its quoting.
 */
function hookNeedsLauncher(
  hook: UserHookConfig,
  harnessId: string | undefined
): boolean {
  return (
    hasHookEnvironment(hook) ||
    (harnessBreaksQuotedHookCommands(harnessId) && hook.command.includes('"'))
  );
}

export function needsUserHookLauncher(
  hooks: UserHookConfig[] | undefined,
  harnessId: string | undefined
): boolean {
  return Boolean(hooks?.some((hook) => hookNeedsLauncher(hook, harnessId)));
}

/**
 * Routes hooks that need it through `ctrlyoke-hook-run.js`
 * (see `hookNeedsLauncher`). This keeps resolved hook variables out of the
 * harness process: each wrapped hook gets an ID in one per-step file, and the
 * launcher selects only that hook's environment.
 */
export function prepareUserHookLaunchers(params: {
  hooks: UserHookConfig[] | undefined;
  harnessId: string | undefined;
  extensionPath: string;
  hookTempDirectory: string;
  promptIndex: number;
  /** Stable run identity for harnesses that persist hook commands as trust keys. */
  stableFileStem?: string;
}): PreparedUserHookEnvironments {
  const { hooks } = params;
  if (!hooks || !needsUserHookLauncher(hooks, params.harnessId)) {
    return { hooks };
  }

  const fileName = params.stableFileStem
    ? `user-hook-env-${params.stableFileStem}.json`
    : `user-hook-env-${params.promptIndex}-${crypto.randomUUID()}.json`;
  const tempFilePath = path.join(params.hookTempDirectory, fileName);
  const launcherPath = path.join(
    params.extensionPath,
    "out",
    "scripts",
    "ctrlyoke-hook-run.js"
  );
  const envByHookId: Record<string, UserHookEnvironmentEntry> = {};
  const wrappedHooks: PreparedUserHookConfig[] = hooks.map((hook, index) => {
    if (!hookNeedsLauncher(hook, params.harnessId)) {
      return hook;
    }
    const hookId = `hook-${index}`;
    envByHookId[hookId] = {
      env: hook.env ?? {},
      ...(hook.timeoutSec === undefined ? {} : { timeoutSec: hook.timeoutSec }),
    };
    if (params.harnessId === HARNESS_IDS.OPENCODE_CLI) {
      return { ...hook, env: undefined, envFile: tempFilePath, envId: hookId };
    }

    const encodedCommand = Buffer.from(hook.command, "utf8").toString("base64");
    const quoted = CliNotificationMonitor.shouldQuoteNodeCommand(
      params.harnessId
    );
    const shell = resolveHookShell(params.harnessId);
    const bashCommand =
      params.harnessId === HARNESS_IDS.COPILOT_CLI
        ? buildLauncherCommand(
            launcherPath,
            tempFilePath,
            hookId,
            encodedCommand,
            "bash",
            quoted
          )
        : undefined;
    const launcherCommand = buildLauncherCommand(
      launcherPath,
      tempFilePath,
      hookId,
      encodedCommand,
      shell,
      quoted
    );
    if (params.harnessId === HARNESS_IDS.COPILOT_CLI) {
      return {
        ...hook,
        command: bashCommand ?? launcherCommand,
        bashCommand,
        powershellCommand: buildLauncherCommand(
          launcherPath,
          tempFilePath,
          hookId,
          encodedCommand,
          "powershell.exe",
          quoted
        ),
        env: undefined,
      };
    }
    return { ...hook, command: launcherCommand, env: undefined };
  });

  const mode = process.platform === "win32" ? undefined : 0o600;
  return {
    hooks: wrappedHooks,
    tempFilePath,
    mutation: {
      path: tempFilePath,
      description: "Write per-hook environment values",
      apply: async () => {
        const fs = await import("fs/promises");
        await fs.mkdir(params.hookTempDirectory, { recursive: true });
        // Windows ignores POSIX file modes; on POSIX, keep secret-bearing data owner-only.
        await fs.writeFile(tempFilePath, JSON.stringify(envByHookId), {
          encoding: "utf8",
          ...(mode === undefined ? {} : { mode }),
        });
        if (mode !== undefined) {
          await fs.chmod(tempFilePath, mode);
        }
      },
    },
  };
}

function buildLauncherCommand(
  launcherPath: string,
  envFilePath: string,
  hookId: string,
  encodedCommand: string,
  shell: string,
  quoted: boolean
): string {
  return CliNotificationMonitor.buildNodeCommand(
    launcherPath,
    [envFilePath, hookId, shell, encodedCommand],
    quoted
  );
}

function resolveHookShell(harnessId: string | undefined): string {
  if (process.platform === "win32" && harnessId === HARNESS_IDS.CLAUDE_CLI) {
    return "bash";
  }
  return "default";
}
