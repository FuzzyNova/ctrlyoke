import React from "react";
import {
  DATE_RANGE_PRESETS,
  getDatePresetRange,
  type DateRangeFilter,
  type DateRangePreset,
} from "../../utils/dateRangeFilter";

export interface DateRangeFilterControlsProps {
  value: DateRangeFilter;
  onChange: (value: DateRangeFilter) => void;
}

export const DateRangeFilterControls: React.FC<
  DateRangeFilterControlsProps
> = ({ value, onChange }) => {
  const handleDatePresetChange = (preset: DateRangePreset) => {
    if (preset === "all") {
      onChange({ preset: "all", from: "", to: "" });
      return;
    }

    if (preset === DATE_RANGE_PRESETS.CUSTOM) {
      onChange({
        ...value,
        preset,
      });
      return;
    }

    onChange({
      preset,
      ...getDatePresetRange(preset),
    });
  };

  const handleDateBoundChange = (bound: "from" | "to", nextValue: string) => {
    onChange({
      ...value,
      preset:
        nextValue || value[bound === "from" ? "to" : "from"]
          ? DATE_RANGE_PRESETS.CUSTOM
          : "all",
      [bound]: nextValue,
    });
  };

  return (
    <>
      <select
        aria-label="Workflow date preset"
        value={value.preset}
        onChange={(event) =>
          handleDatePresetChange(event.target.value as DateRangePreset)
        }
        className="h-7 min-w-[112px] flex-shrink-0 rounded border border-input-border bg-input-bg px-1.5 text-xs text-input-fg outline-none focus:border-focus-border"
      >
        <option value="all">Any time</option>
        <option value="last7">Last 7 days</option>
        <option value="last30">Last 30 days</option>
        <option value="lastMonth">Last month</option>
        <option value={DATE_RANGE_PRESETS.CUSTOM}>Custom range</option>
      </select>

      {value.preset === DATE_RANGE_PRESETS.CUSTOM && (
        <>
          <input
            type="date"
            aria-label="Workflow date from"
            value={value.from}
            onChange={(event) =>
              handleDateBoundChange("from", event.target.value)
            }
            className="h-7 w-[128px] flex-shrink-0 rounded border border-input-border bg-input-bg px-1.5 text-xs text-input-fg outline-none focus:border-focus-border"
          />
          <input
            type="date"
            aria-label="Workflow date to"
            value={value.to}
            onChange={(event) =>
              handleDateBoundChange("to", event.target.value)
            }
            className="h-7 w-[128px] flex-shrink-0 rounded border border-input-border bg-input-bg px-1.5 text-xs text-input-fg outline-none focus:border-focus-border"
          />
        </>
      )}
    </>
  );
};
