export interface HideablePartition<T> {
  /** True when the hide feature is enabled (a namespace was supplied). */
  hideEnabled: boolean;
  /** Options that are not currently hidden (all options when disabled). */
  visible: T[];
  /** Options that are currently hidden (empty when disabled). */
  hidden: T[];
}

/**
 * useHideableOptions — partition a list of options into visible/hidden groups
 * for the per-item hide feature shared by CustomSelect, SkillsSelect, and
 * MultiCheckboxDropdown.
 *
 * The hide feature is enabled only when a `namespace` is supplied (matching the
 * existing `hideEnabled = namespace !== undefined` convention). When disabled,
 * every option is returned as visible and `hidden` is empty.
 *
 * `getKey` extracts the value matched against `hiddenValues` — options key by
 * `value`, skills key by `name`. The partition is cheap (option lists are
 * small) so it is computed on each render rather than memoized.
 */
export function useHideableOptions<T>(
  options: T[],
  getKey: (option: T) => string,
  hiddenValues: string[],
  namespace: string | undefined
): HideablePartition<T> {
  const hideEnabled = namespace !== undefined;
  if (!hideEnabled) {
    return { hideEnabled, visible: options, hidden: [] };
  }
  const hiddenSet = new Set(hiddenValues);
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const option of options) {
    (hiddenSet.has(getKey(option)) ? hidden : visible).push(option);
  }
  return { hideEnabled, visible, hidden };
}
