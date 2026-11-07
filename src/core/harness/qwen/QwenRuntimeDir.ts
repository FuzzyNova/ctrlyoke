import * as fs from "fs";
import * as path from "path";
import { parse } from "jsonc-parser";
import {
  HARNESS_HOME_ENV_VARS,
  getQwenHomeDir,
  getQwenRuntimeDir,
  resolveConfiguredDir,
  type HarnessHomeEnv,
} from "../../../utils/HarnessHome";
import { pathsEqual } from "../../../utils/PathCasing";
import {
  defaultQwenSystemDefaultsPath,
  defaultQwenSystemSettingsPath,
} from "./QwenSystemSettings";

/**
 * Where Qwen Code writes session transcripts (`projects/<workspace>/chats/`),
 * resolved the way Qwen 0.26.9's `Storage.getRuntimeBaseDir` does after
 * `loadSettings`:
 *
 * 1. `QWEN_RUNTIME_DIR`;
 * 2. the merged `advanced.runtimeOutputDir` setting. Qwen merges system
 *    defaults < user < workspace < system settings, substitutes `$VAR` and
 *    `${VAR}` in the value, and resolves `~` and relative paths against the
 *    workspace. The workspace layer counts only for a trusted folder;
 * 3. the Qwen home (`QWEN_HOME`, else `~/.qwen`).
 *
 * ctrlyoke launches Qwen with its own system settings file, a copy of the
 * real one plus hooks, and points `QWEN_CODE_SYSTEM_DEFAULTS_PATH` at the real
 * defaults file (`QwenCliProvider`), so the layers read here are the ones the
 * launched Qwen reads.
 *
 * With `security.folderTrust.enabled`, whether the workspace layer counts
 * depends on Qwen's trusted-folder rules, which ctrlyoke does not reproduce.
 * If the workspace sets a different directory, both are returned, the
 * workspace's first, and the log reader looks in each. Session IDs are
 * unique, so looking in an extra directory never picks up another session.
 *
 * @returns One or two candidate directories, most likely first.
 */
export function resolveQwenRuntimeDirs(
  workspaceRoot: string | undefined,
  env: HarnessHomeEnv = process.env
): string[] {
  if (env[HARNESS_HOME_ENV_VARS.QWEN_RUNTIME_DIR]?.trim()) {
    return [getQwenRuntimeDir(env)];
  }

  const qwenHome = getQwenHomeDir(env);
  const cwd = workspaceRoot ?? process.cwd();
  const systemDefaults = readSettingsLayer(defaultQwenSystemDefaultsPath(env));
  const user = readSettingsLayer(path.join(qwenHome, "settings.json"));
  const system = readSettingsLayer(defaultQwenSystemSettingsPath(env));
  const workspaceSettingsPath = path.join(cwd, ".qwen", "settings.json");
  // With the workspace at the home directory, its `.qwen/settings.json` is
  // the user file, already read above.
  const workspace = pathsEqual(
    workspaceSettingsPath,
    path.join(qwenHome, "settings.json")
  )
    ? {}
    : readSettingsLayer(workspaceSettingsPath);

  const resolve = (layers: readonly SettingsLayer[]): string => {
    // A later layer wins. An empty value still wins and means "unset".
    let value: string | undefined;
    for (const layer of layers) {
      const candidate = layer.advanced?.runtimeOutputDir;
      if (typeof candidate === "string") value = candidate;
    }
    const substituted = value ? substituteEnvVars(value, env) : undefined;
    return substituted ? resolveConfiguredDir(substituted, cwd) : qwenHome;
  };

  const trusted = resolve([systemDefaults, user, workspace, system]);
  if (!isFolderTrustEnabled([systemDefaults, user, system])) {
    return [trusted];
  }
  const untrusted = resolve([systemDefaults, user, system]);
  return pathsEqual(trusted, untrusted) ? [trusted] : [trusted, untrusted];
}

interface SettingsLayer {
  advanced?: { runtimeOutputDir?: unknown };
  security?: { folderTrust?: { enabled?: unknown } };
}

/**
 * One settings file, or `{}` when it is missing or unreadable. Qwen refuses to
 * start on a malformed file, so a run never gets as far as needing its value.
 */
function readSettingsLayer(filePath: string): SettingsLayer {
  try {
    const parsed: unknown = parse(fs.readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as SettingsLayer)
      : {};
  } catch {
    return {};
  }
}

/** Qwen's `isFolderTrustEnabled`: system wins over user over system defaults. */
function isFolderTrustEnabled(layers: readonly SettingsLayer[]): boolean {
  let enabled = false;
  for (const layer of layers) {
    const value = layer.security?.folderTrust?.enabled;
    if (typeof value === "boolean") enabled = value;
  }
  return enabled;
}

/**
 * Qwen's `resolveEnvVarsInString`: `$NAME` and `${NAME}` become the variable's
 * value, and an unset variable is left as written.
 */
function substituteEnvVars(value: string, env: HarnessHomeEnv): string {
  return value.replace(
    /\$(?:(\w+)|{([^}]+)})/g,
    (match, bare: string | undefined, braced: string | undefined) => {
      const resolved = env[(bare ?? braced)!];
      return typeof resolved === "string" ? resolved : match;
    }
  );
}
