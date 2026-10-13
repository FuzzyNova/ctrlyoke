import type { PropertyValues } from "@store/editorStore";
import { parseSecretReferences } from "@root/utils/SecretReferenceParser";
import { filterExplicitSecretGrants } from "@components/shared/useSecretGrantOptions";

export interface PropertyUpdateValues {
  properties: Record<string, unknown>;
  clearProperties: string[];
}

/** Convert tri-state editor values into the host's set/clear patch contract. */
export function buildPropertyUpdateValues(
  values: Partial<PropertyValues>,
  options: {
    includeNullsForDefaults?: boolean;
    promptText?: string;
    keys?: ReadonlySet<keyof PropertyValues>;
    enabled?: boolean;
  } = {}
): PropertyUpdateValues {
  const {
    includeNullsForDefaults = false,
    promptText = "",
    keys,
    enabled,
  } = options;
  const result: Record<string, unknown> = {};
  const clearProperties: string[] = [];
  const has = (key: keyof PropertyValues) => !keys || keys.has(key);
  const inherit = (key: keyof PropertyValues) => {
    if (includeNullsForDefaults) clearProperties.push(key);
  };

  for (const key of [
    "harness",
    "model",
    "executionMode",
    "color",
    "resumeSession",
    "mcpServers",
    "hooks",
    "priorContext",
    "priorContextDetail",
    "errorBehavior",
    "preCondition",
    "toolPermissions",
  ] as const) {
    if (!has(key)) continue;
    const value = values[key];
    if (value !== undefined) result[key] = value;
    else inherit(key);
  }
  if (has("agent")) {
    const value = values.agent;
    if (value === null || (typeof value === "string" && value))
      result.agent = value;
    else inherit("agent");
  }
  if (has("sessionId")) {
    const value = values.sessionId;
    if (value?.trim()) {
      const trimmed = value.trim();
      result.sessionId = /^\d+$/.test(trimmed)
        ? parseInt(trimmed, 10)
        : trimmed;
    } else inherit("sessionId");
  }
  if (has("skills")) {
    const value = values.skills;
    if (value === null) result.skills = null;
    else if (Array.isArray(value)) result.skills = value.length ? value : null;
    else inherit("skills");
  }
  if (has("secrets")) {
    const value = values.secrets;
    if (value === null) result.secrets = null;
    else if (Array.isArray(value)) {
      const inlineNames = parseSecretReferences(promptText).map(
        ({ name }) => name
      );
      const explicit = filterExplicitSecretGrants(value, inlineNames);
      result.secrets = explicit.length ? explicit : null;
    } else inherit("secrets");
  }
  if (has("additionalArgs")) {
    const value = values.additionalArgs;
    if (value === null) result.additionalArgs = null;
    else if (value) result.additionalArgs = value;
    else inherit("additionalArgs");
  }
  if (has("endCondition")) {
    const value = values.endCondition;
    if (value !== undefined) {
      const script = value?.script?.trim() || "";
      const returns = value?.returns?.trim() || "";
      result.endCondition = !script || !returns ? null : value;
    } else inherit("endCondition");
  }
  if (enabled !== undefined) {
    if (!enabled) result.enabled = false;
    else if (includeNullsForDefaults) clearProperties.push("enabled");
  }
  return { properties: result, clearProperties };
}
