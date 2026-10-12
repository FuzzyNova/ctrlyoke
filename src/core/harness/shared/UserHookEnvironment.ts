import * as crypto from "crypto";
import * as path from "path";
import type {
  OpenCodeUserHookConfig,
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

export function hasUserHookEnvironment(
  hooks: UserHookConfig[] | undefined
): boolean {
  return Boolean(hooks?.some((hook) => Object.keys(hook.env ?? {}).length > 0));
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
  if (!hooks || !hasUserHookEnvironment(hooks)) {
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
      return { ...hook, env: undefined, envFile: tempFilePath, envId: hookId };
    }

    const encodedCommand = Buffer.from(hook.command, "utf8").toString("base64");
    const launcherCommand = buildLauncherCommand(
      launcherPath,
      tempFilePath,
      hookId,
      encodedCommand,
      CliNotificationMonitor.shouldQuoteNodeCommand(params.harnessId)
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
  encodedCommand: string,
  quoted: boolean
): string {
  return CliNotificationMonitor.buildNodeCommand(
    launcherPath,
    [envFilePath, hookId, encodedCommand],
    quoted
  );
}
