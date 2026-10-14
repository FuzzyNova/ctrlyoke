import type { PropertyValues } from "../store/editorStore";
import type { GlobalSettings, ModelOption } from "../store/settingsStore";
import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";

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

/**
 * Build the prompt property changes that accompany a harness selection. A
 * model or args override belongs to the harness it was picked for, so both are
 * cleared: the step then inherits the workflow's values when it runs on the
 * workflow's harness, or uses the new harness's settings defaults otherwise.
 */
export function buildHarnessChangeCascade(
  harness: string
): Partial<PropertyValues> {
  return {
    harness: harness === INHERIT_DEFAULT_OPTION ? undefined : harness,
    model: undefined,
    additionalArgs: undefined,
  };
}
