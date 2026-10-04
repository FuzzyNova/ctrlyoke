import type { PropertyValues } from "../store/editorStore";
import type { GlobalSettings } from "../store/settingsStore";
import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";

type HarnessDefaults = Pick<
  GlobalSettings,
  "harnessDefaultModels" | "harnessDefaultAdditionalArgs"
>;

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
