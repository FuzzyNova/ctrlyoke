import * as fs from "fs/promises";
import * as path from "path";
import { parse } from "jsonc-parser";
import { getQwenHomeDir } from "../../../utils/HarnessHome";
import { isRecord } from "../../../utils/JsonTypeGuards";
import {
  defaultQwenSystemDefaultsPath,
  defaultQwenSystemSettingsPath,
} from "./QwenSystemSettings";

/** The settings key that lists the models Qwen can run, by provider. */
const MODEL_PROVIDERS_KEY = "modelProviders";

/** The model ids under `modelProviders` in one parsed Qwen settings object. */
export function collectQwenModelProviderIds(settings: unknown): string[] {
  const providers = isRecord(settings)
    ? settings[MODEL_PROVIDERS_KEY]
    : undefined;
  if (!isRecord(providers)) return [];
  return Object.values(providers).flatMap((models) =>
    Array.isArray(models)
      ? models.flatMap((model) =>
          isRecord(model) && typeof model.id === "string" && model.id
            ? [model.id]
            : []
        )
      : []
  );
}

/** The settings files Qwen merges for a workspace, lowest precedence first. */
export function qwenSettingsPaths(workspaceRoot: string | undefined): string[] {
  return [
    defaultQwenSystemDefaultsPath(),
    path.join(getQwenHomeDir(), "settings.json"),
    ...(workspaceRoot
      ? [path.join(workspaceRoot, ".qwen", "settings.json")]
      : []),
    defaultQwenSystemSettingsPath(),
  ];
}

/**
 * Every model id Qwen can run in `workspaceRoot`: the union of `modelProviders`
 * across the settings files Qwen merges. Undefined when none of them lists a
 * model (a sign-in setup, for example), since there is then nothing to check a
 * requested model against. A missing or unreadable file contributes nothing;
 * Qwen reports a malformed one itself.
 */
export async function readConfiguredQwenModelIds(
  workspaceRoot: string | undefined
): Promise<ReadonlySet<string> | undefined> {
  const ids = new Set<string>();
  for (const settingsPath of qwenSettingsPaths(workspaceRoot)) {
    let content: string;
    try {
      content = await fs.readFile(settingsPath, "utf8");
    } catch {
      continue;
    }
    for (const id of collectQwenModelProviderIds(
      parse(content, [], { allowTrailingComma: true })
    )) {
      ids.add(id);
    }
  }
  return ids.size > 0 ? ids : undefined;
}

/**
 * The step error for a requested model that Qwen's settings do not list. Qwen
 * 0.27+ would run its default model instead, without an error.
 */
export function describeUnconfiguredQwenModel(model: string): string {
  return (
    `Qwen model "${model}" is not listed under modelProviders in Qwen's settings.json, ` +
    `so Qwen would run its default model instead. Add it there, or pick a model that is listed.`
  );
}

/**
 * The step warning for a run Qwen made on another model than requested, which
 * the settings check could not catch beforehand.
 */
export function describeQwenModelFallback(
  requestedModel: string,
  actualModel: string
): string {
  return (
    `Qwen ran ${actualModel} instead of the requested model ${requestedModel}. ` +
    `Qwen uses its default model when the requested one is not listed under ` +
    `modelProviders in its settings.json.`
  );
}
