import { Log } from "../../../utils/Log";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { isRegistryInitialized } from "../../../utils/ModelRegistry";

/** How one harness validates a step's model before passing `--model`. */
export interface CliModelRules {
  /** Log prefix, e.g. `ClaudeCliProvider`. */
  logLabel: string;
  /** The harness's configured default model (may be `none`). */
  defaultModel: string;
  /**
   * The value to pass for a model this harness recognises, or `undefined`
   * when it does not. May normalise (Claude maps names to its aliases).
   */
  recognize: (model: string) => string | undefined;
  /** Extra guidance logged with the not-recognised warning. */
  acceptedFormats?: string;
  /** Whether model discovery has run. Defaults to the shared model registry. */
  isRegistryLoaded?: () => boolean;
}

/**
 * The `--model` value for a strict harness (Claude, Copilot, Codex), or
 * `undefined` to pass no flag.
 *
 * - No requested model: the default.
 * - `none`: no flag.
 * - A recognised model: that model, as `recognize` returns it.
 * - Otherwise, while the model registry has not loaded (the standalone CLI
 *   never runs discovery, so planning stays side-effect free): the requested
 *   model, unchanged, since it was never checked.
 * - Otherwise: a warning and the default.
 *
 * A default of `none` always means no flag, never a literal `--model none`.
 */
export function resolveCliModelFlag(
  requestedModel: string | undefined,
  rules: CliModelRules
): string | undefined {
  if (!requestedModel) {
    return resolveDefault(rules);
  }
  if (requestedModel === MODEL_NONE) {
    return undefined;
  }
  const recognized = rules.recognize(requestedModel);
  if (recognized) {
    return recognized;
  }
  if (!(rules.isRegistryLoaded ?? isRegistryInitialized)()) {
    return requestedModel;
  }
  const fallback = resolveDefault(rules);
  Log.warn(
    `[${rules.logLabel}] Model "${requestedModel}" is not recognised. ${
      fallback === undefined
        ? "The default is none, so no model is passed."
        : `Using default: ${fallback}`
    }`
  );
  if (rules.acceptedFormats) {
    Log.warn(
      `[${rules.logLabel}]    Accepted formats: ${rules.acceptedFormats}`
    );
  }
  return fallback;
}

function resolveDefault(rules: CliModelRules): string | undefined {
  const { defaultModel } = rules;
  if (!defaultModel || defaultModel === MODEL_NONE) {
    return undefined;
  }
  return rules.recognize(defaultModel) ?? defaultModel;
}
