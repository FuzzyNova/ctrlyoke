import type { HarnessId } from "@root/types/DashboardConstants";
import { HARNESS_OPTIONS_META } from "@root/types/SchemaUiMetadata";

/** Official product name of each harness, from the schema option labels. */
export const HARNESS_DISPLAY_NAMES: Record<HarnessId, string> =
  Object.fromEntries(
    Object.values(HARNESS_OPTIONS_META).map(({ value, label }) => [
      value,
      label,
    ])
  ) as Record<HarnessId, string>;
