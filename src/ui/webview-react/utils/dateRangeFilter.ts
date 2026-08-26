import {
  EXECUTION_STATES,
  HARNESS_IDS,
  HARNESS_INFO,
} from "@root/types/DashboardConstants";

export type DateRangePreset =
  | typeof DATE_RANGE_PRESETS.ALL
  | "last7"
  | "last30"
  | "lastMonth"
  | typeof DATE_RANGE_PRESETS.CUSTOM;

export const DATE_RANGE_PRESETS = {
  ALL: "all",
  CUSTOM: "custom",
} as const;

export interface DateRangeFilter {
  preset: DateRangePreset;
  from: string;
  to: string;
}

export const DEFAULT_DATE_RANGE_FILTER: DateRangeFilter = {
  preset: DATE_RANGE_PRESETS.ALL,
  from: "",
  to: "",
};

export const DATE_INPUT_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const ALL_WORKFLOW_STATES = Object.values(EXECUTION_STATES);
export const ALL_WORKFLOW_HARNESSES = Object.values(HARNESS_IDS);

export const WORKFLOW_STATE_OPTIONS = ALL_WORKFLOW_STATES.map((state) => ({
  value: state,
  label: state,
}));

export const WORKFLOW_HARNESS_OPTIONS = ALL_WORKFLOW_HARNESSES.map(
  (harness) => ({
    value: harness,
    label: HARNESS_INFO[harness].name,
  })
);

export function formatDateInput(timestamp: number): string {
  return DATE_INPUT_FORMATTER.format(new Date(timestamp));
}

export function getDatePresetRange(
  preset: Exclude<
    DateRangePreset,
    typeof DATE_RANGE_PRESETS.ALL | typeof DATE_RANGE_PRESETS.CUSTOM
  >
): Pick<DateRangeFilter, "from" | "to"> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (preset === "lastMonth") {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth(), 0);
    return {
      from: formatDateInput(from.getTime()),
      to: formatDateInput(to.getTime()),
    };
  }

  const days = preset === "last7" ? 6 : 29;
  const from = new Date(today);
  from.setDate(today.getDate() - days);

  return {
    from: formatDateInput(from.getTime()),
    to: formatDateInput(today.getTime()),
  };
}

export function getDateStartMs(date: string): number | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00`);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : time;
}

export function getDateEndMs(date: string): number | null {
  if (!date) return null;
  const parsed = new Date(`${date}T23:59:59.999`);
  const time = parsed.getTime();
  return Number.isNaN(time) ? null : time;
}
