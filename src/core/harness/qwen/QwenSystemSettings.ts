import { isRecord } from "../../../utils/JsonTypeGuards";
import * as fs from "fs/promises";
import * as path from "path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { writeFileAtomic } from "../../../utils/AtomicFileUtils";
import { getErrorMessage, hasErrnoCode } from "../../../utils/ErrorUtils";
import { withFileLock } from "../../../utils/FileLockUtils";
import { isCtrlYokeQwenHookGroup } from "./QwenNotificationMonitor";
import { NODE_ERROR_CODES } from "../../../types/DashboardConstants";

/**
 * Qwen's system settings path override. Qwen reads hooks from its system,
 * user and project scopes separately, and since 0.26.9 it holds project
 * (`.qwen/settings.json`) hooks back until the folder is trusted or the user
 * approves them in its TUI, which a ctrlyoke step can never do. System-scope
 * hooks are not gated, so ctrlyoke gives each launch its own system settings
 * file: the real one plus the step's hooks. Supported since Qwen 0.15.5.
 */
export const QWEN_SYSTEM_SETTINGS_PATH_ENV = "QWEN_CODE_SYSTEM_SETTINGS_PATH";

/** The settings key Qwen reads hooks from, in every scope. */
const HOOKS_KEY = "hooks";

type HooksSection = Record<string, unknown[]>;

/**
 * The system settings file Qwen would read without ctrlyoke, resolved the way
 * Qwen 0.26.9's `getSystemSettingsPath()` does.
 */
export function defaultQwenSystemSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const configured = env[QWEN_SYSTEM_SETTINGS_PATH_ENV];
  if (configured) return configured;
  if (platform === "darwin") {
    return "/Library/Application Support/QwenCode/settings.json";
  }
  if (platform === "win32") return "C:\\ProgramData\\qwen-code\\settings.json";
  return "/etc/qwen-code/settings.json";
}

/**
 * Qwen's system defaults path override. Without it Qwen looks for
 * `system-defaults.json` beside the system settings file, which for a ctrlyoke
 * launch is the per-run copy in `.ctrlyoke/temp/`, so `QwenCliProvider` sets it
 * to the file Qwen would otherwise read.
 */
export const QWEN_SYSTEM_DEFAULTS_PATH_ENV = "QWEN_CODE_SYSTEM_DEFAULTS_PATH";

/**
 * The system defaults file Qwen would read without ctrlyoke, resolved the way
 * Qwen 0.26.9's `getSystemDefaultsPath()` does.
 */
export function defaultQwenSystemDefaultsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const configured = env[QWEN_SYSTEM_DEFAULTS_PATH_ENV];
  if (configured) return configured;
  // Qwen derives the folder with the host's path module.
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(
    pathApi.dirname(defaultQwenSystemSettingsPath(env, platform)),
    "system-defaults.json"
  );
}

/**
 * Read the real system settings so the per-run copy keeps everything an
 * administrator set. A missing file is an empty one. A file that exists but
 * cannot be read or parsed throws: writing hooks without it would silently
 * drop managed settings, which is worse than failing the step.
 */
async function readBaseSettings(
  settingsPath: string
): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if (hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) return {};
    throw new Error(
      `Cannot read Qwen system settings at ${settingsPath}: ${getErrorMessage(error)}`
    );
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || (parsed !== undefined && !isRecord(parsed))) {
    const reason = errors[0]
      ? `${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`
      : "not a JSON object";
    throw new Error(
      `Cannot read Qwen system settings at ${settingsPath}: ${reason}`
    );
  }
  return parsed ?? {};
}

/**
 * Append `extra`'s hook groups after the ones already in `base`, per event.
 * Non-event entries of `base` (Qwen's own `hooks` config fields) are kept.
 */
function mergeHooks(
  base: unknown,
  extra: HooksSection
): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  for (const [event, groups] of Object.entries(extra)) {
    const existing = merged[event];
    merged[event] = [...(Array.isArray(existing) ? existing : []), ...groups];
  }
  return merged;
}

/**
 * Content for a launch's system settings file: the settings at `basePath`
 * with `hooks` appended to theirs. Every other key is kept as is, so the
 * system scope's precedence over user and project settings is unchanged.
 */
export async function buildQwenSystemSettings(
  hooks: HooksSection,
  basePath: string = defaultQwenSystemSettingsPath()
): Promise<string> {
  const base = await readBaseSettings(basePath);
  return JSON.stringify(
    { ...base, hooks: mergeHooks(base.hooks, hooks) },
    null,
    2
  );
}

/**
 * Remove orphaned ctrlyoke hook groups from the workspace's
 * `.qwen/settings.json`. ctrlyoke 0.4 and earlier registered its hooks there,
 * and a run that was killed left them behind. Qwen 0.26.9 would hold every
 * project hook back for approval because of them, so each launch clears the
 * ones whose owning process is gone. The user's own hooks, other keys and
 * comments are left as they are.
 */
export async function removeOrphanedProjectHooks(
  workspaceRoot: string
): Promise<void> {
  const settingsPath = path.join(workspaceRoot, ".qwen", "settings.json");
  try {
    await fs.access(settingsPath);
  } catch {
    return;
  }
  await withFileLock(settingsPath, async () => {
    const content = await fs.readFile(settingsPath, "utf8");
    const errors: ParseError[] = [];
    const parsed: unknown = parse(content, errors, {
      allowTrailingComma: true,
    });
    if (errors.length > 0 || !isRecord(parsed) || !isRecord(parsed.hooks)) {
      return;
    }
    let removed = false;
    const hooks: Record<string, unknown> = {};
    for (const [event, groups] of Object.entries(parsed.hooks)) {
      if (!Array.isArray(groups)) {
        hooks[event] = groups;
        continue;
      }
      const kept = groups.filter((group) => !isCtrlYokeQwenHookGroup(group));
      removed ||= kept.length !== groups.length;
      if (kept.length > 0) hooks[event] = kept;
    }
    if (!removed) return;
    const remainingKeys = Object.keys(parsed).filter(
      (key) => key !== HOOKS_KEY
    );
    if (Object.keys(hooks).length === 0 && remainingKeys.length === 0) {
      // Nothing of the user's is left: ctrlyoke created this file.
      await fs.unlink(settingsPath);
      await removeCtrlYokeGitignore(path.dirname(settingsPath));
      return;
    }
    const edits = modify(
      content,
      [HOOKS_KEY],
      Object.keys(hooks).length > 0 ? hooks : undefined,
      { formattingOptions: { insertSpaces: true, tabSize: 2 } }
    );
    await writeFileAtomic(settingsPath, applyEdits(content, edits));
  });
}

/** The `.gitignore` ctrlyoke 0.4 wrote beside a `.qwen/settings.json` it created. */
const CTRLYOKE_GITIGNORE_MARKER = "# ctrlyoke temp files";

async function removeCtrlYokeGitignore(settingsDir: string): Promise<void> {
  const gitignorePath = path.join(settingsDir, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf8");
    if (content.startsWith(CTRLYOKE_GITIGNORE_MARKER)) {
      await fs.unlink(gitignorePath);
    }
  } catch {
    // No .gitignore, or not ours.
  }
}
