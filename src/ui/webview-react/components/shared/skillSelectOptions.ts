import type { DiscoveredFileLocationInfo } from "@root/types/WebviewMessageTypes";
import { discoveryLocationTitle } from "@utils/schemaPropertyLabels";
import type { SelectOption } from "./CustomSelect";

/** The skill fields shared by every skill picker. */
export interface SkillSelectEntry extends DiscoveredFileLocationInfo {
  name: string;
  description?: string;
}

/**
 * Create a consistently rendered skill option. The result fits both
 * `SkillsSelect` (which reads `name`) and `MultiCheckboxDropdown` (which reads
 * `value`/`label`).
 */
export function toSkillSelectOption(
  skill: SkillSelectEntry
): SelectOption & { name: string } {
  return {
    name: skill.name,
    value: skill.name,
    label: skill.name,
    description: skill.description || undefined,
    tooltipDetail: discoveryLocationTitle(skill),
  };
}
