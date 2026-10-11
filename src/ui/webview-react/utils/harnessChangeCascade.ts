import type { PropertyValues } from "../store/editorStore";
import type { GlobalSettings, ModelOption } from "../store/settingsStore";
import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";

type HarnessDefaults = Pick<
  GlobalSettings,
  "harnessDefaultModels" | "harnessDefaultAdditionalArgs"
>;

/**
 * The model a harness should start on: the user's default model for that
 * harness when the harness offers it, otherwise the harness's first model.
 * Undefined while the harness's model list is still loading.
 */
export function defaultModelForHarness(
  harness: string,
  harnessDefaultModels: GlobalSettings["harnessDefaultModels"],
  models: ReadonlyArray<ModelOption>
): string | undefined {
  if (models.length === 0) return undefined;
  const preferred = harnessDefaultModels[harness];
  return models.some((model) => model.value === preferred)
    ? preferred
    : models[0].value;
}

/** Build the prompt property changes that accompany a harness selection. */
export function buildHarnessChangeCascade(
  harness: string,
  settings: HarnessDefaults
): Partial<PropertyValues> {
  if (harness === INHERIT_DEFAULT_OPTION) {
    return { harness: undefined, model: undefined, additionalArgs: undefined };
  }
  return {
    harness,
    model: settings.harnessDefaultModels[harness] || undefined,
    additionalArgs: settings.harnessDefaultAdditionalArgs[harness] || null,
  };
}
