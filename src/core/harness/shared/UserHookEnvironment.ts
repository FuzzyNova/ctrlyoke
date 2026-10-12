import * as crypto from "crypto";
import * as path from "path";
import type { UserHookConfig } from "../../../types/CtrlYokeTypes";
import { HARNESS_IDS } from "../../../types/DashboardConstants";
import { escapeCmdArgument } from "./WindowsCmdEscaping";
import type { PreparedMutation } from "./interfaces/PreparedMutation";

export interface PreparedUserHookEnvironments {
  readonly hooks: UserHookConfig[] | undefined;
  readonly tempFilePath?: string;
  readonly mutation?: PreparedMutation;
}

/**
 * Keeps resolved hook variables out of the harness process. Each hook gets an
 * ID in one per-step file; the launcher selects only that hook's environment.
 */
export function prepareUserHookEnvironments(params: {
  hooks: UserHookConfig[] | undefined;
  harnessId: string | undefined;
  extensionPath: string;
  hookTempDirectory: string;
  promptIndex: number;
}): PreparedUserHookEnvironments {
  const { hooks } = params;
  if (!hooks?.some((hook) => Object.keys(hook.env ?? {}).length > 0)) {
    return { hooks };
  }

  const fileName = `user-hook-env-${params.promptIndex}-${crypto.randomUUID()}.json`;
  const tempFilePath = path.join(params.hookTempDirectory, fileName);
  const launcherPath = path.join(
    params.extensionPath,
    "out",
    "scripts",
    "ctrlyoke-hook-run.js"
  );
  const envByHookId: Record<string, Record<string, string>> = {};
  const wrappedHooks = hooks.map((hook, index) => {
    const env = hook.env;
    if (!env || Object.keys(env).length === 0) {
      return hook;
    }
    const hookId = `hook-${index}`;
    envByHookId[hookId] = env;
    if (params.harnessId === HARNESS_IDS.OPENCODE_CLI) {
      return { ...hook, env: undefined, envFile: tempFilePath, envId: hookId } as UserHookConfig;
    }

    const encodedCommand = Buffer.from(hook.command, "utf8").toString("base64");
    const launcherCommand = buildLauncherCommand(
      launcherPath,
      tempFilePath,
      hookId,
      encodedCommand
    );
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
  encodedCommand: string
): string {
  if (process.platform === "win32") {
    return ["node", launcherPath, envFilePath, hookId, encodedCommand]
      .map((argument) => escapeCmdArgument(argument, false))
      .join(" ");
  }
  return ["node", launcherPath, envFilePath, hookId, encodedCommand]
    .map(quotePosixShellArgument)
    .join(" ");
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
