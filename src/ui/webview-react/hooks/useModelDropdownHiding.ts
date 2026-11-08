import { useUiStore } from "@store/uiStore";
import type { ModelOption } from "@store/settingsStore";
import {
  modelNamespaceForHarness,
  resolveHiddenDropdownValues,
} from "../types/dropdownNamespaces";

/** The hide-feature props a harness's model `CustomSelect` takes. */
export interface ModelDropdownHiding {
  namespace: string;
  hiddenValues: string[];
  onHideOption: (value: string) => void;
  onUnhideOption: (value: string) => void;
}

/**
 * Hide-feature wiring for a harness's model picker: the user's own hidden
 * and unhidden choices, with models the harness hides from its own picker
 * starting out in the hidden section.
 */
export function useModelDropdownHiding(
  harness: string,
  models: ReadonlyArray<ModelOption>
): ModelDropdownHiding {
  const namespace = modelNamespaceForHarness(harness);
  const hidden = useUiStore((s) => s.hiddenDropdownOptions[namespace]);
  const shown = useUiStore((s) => s.shownDropdownOptions[namespace]);
  const hideDropdownOption = useUiStore((s) => s.hideDropdownOption);
  const unhideDropdownOption = useUiStore((s) => s.unhideDropdownOption);
  return {
    namespace,
    hiddenValues: resolveHiddenDropdownValues(hidden, shown, models),
    onHideOption: (value) => hideDropdownOption(namespace, value),
    onUnhideOption: (value) => unhideDropdownOption(namespace, value),
  };
}
