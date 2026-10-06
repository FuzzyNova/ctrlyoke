import {
  INHERIT_DEFAULT_OPTION,
  LIMIT_SELECTION_VALUES,
  UNLIMITED_LIMIT,
} from "@root/types/DashboardConstants";
import {
  MAX_STEPS_SELECTION_OPTIONS_META,
  LIMIT_CUSTOM_OPTION_META,
  NEVER_OPTION_META,
  UNLIMITED_OPTION_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";
import { useMemo } from "react";
import { CustomSelect } from "./CustomSelect";
import { LocalNumberInput } from "./LocalInputs";

type LimitMode =
  typeof LIMIT_SELECTION_VALUES.UNLIMITED | typeof LIMIT_SELECTION_VALUES.NEVER;

interface LimitSelectProps {
  id: string;
  label: string;
  path: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  mode?: LimitMode;
  /** Enables an Inherit option and names the resolved value shown beside it. */
  inheritLabel?: string;
  /** Minimum value accepted by Custom. */
  min?: number;
  /** Optional maximum value accepted by Custom. */
  max?: number;
  /** Value used to prefill Custom when the current value is unlimited or absent. */
  customFallback: number;
  disabled?: boolean;
}

const CUSTOM_OPTION_META = LIMIT_CUSTOM_OPTION_META;

/** Shared selector for schema limits stored as a number or -1. */
export function LimitSelect({
  id,
  label,
  path,
  value,
  onChange,
  mode = LIMIT_SELECTION_VALUES.UNLIMITED,
  inheritLabel,
  min = 1,
  max,
  customFallback,
  disabled = false,
}: LimitSelectProps) {
  const allowInherit = inheritLabel !== undefined;
  const selectOptions = useMemo(() => {
    const metadata = {
      ...(allowInherit
        ? {
            ...MAX_STEPS_SELECTION_OPTIONS_META,
            [INHERIT_DEFAULT_OPTION]: {
              ...MAX_STEPS_SELECTION_OPTIONS_META[INHERIT_DEFAULT_OPTION],
              label: `Inherit (${inheritLabel})`,
            },
          }
        : {}),
      [mode === LIMIT_SELECTION_VALUES.NEVER
        ? NEVER_OPTION_META.value
        : UNLIMITED_OPTION_META.value]:
        mode === LIMIT_SELECTION_VALUES.NEVER
          ? NEVER_OPTION_META
          : UNLIMITED_OPTION_META,
      [CUSTOM_OPTION_META.value]: CUSTOM_OPTION_META,
    };
    return toSelectOptions(metadata, path);
  }, [allowInherit, inheritLabel, mode, path]);

  const selection =
    value === undefined && allowInherit
      ? INHERIT_DEFAULT_OPTION
      : value === UNLIMITED_LIMIT
        ? mode === LIMIT_SELECTION_VALUES.NEVER
          ? NEVER_OPTION_META.value
          : UNLIMITED_OPTION_META.value
        : CUSTOM_OPTION_META.value;

  const customValue =
    value === undefined || value === UNLIMITED_LIMIT ? customFallback : value;
  const nextCustomValue = (next: number | undefined) => {
    const parsed = next ?? customFallback;
    const finiteValue = Number.isFinite(parsed) ? parsed : customFallback;
    onChange(
      Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, finiteValue))
    );
  };

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <CustomSelect
          id={id}
          value={selection}
          onChange={(next) => {
            if (next === INHERIT_DEFAULT_OPTION) {
              onChange(undefined);
            } else if (
              next === UNLIMITED_OPTION_META.value ||
              next === NEVER_OPTION_META.value
            ) {
              onChange(UNLIMITED_LIMIT);
            } else {
              nextCustomValue(customValue);
            }
          }}
          options={selectOptions}
          schemaPath={path}
          disabled={disabled}
        />
      </div>
      {selection === CUSTOM_OPTION_META.value && (
        <LocalNumberInput
          id={`${id}-custom`}
          min={min}
          max={max}
          value={customValue}
          onCommit={nextCustomValue}
          parse={(raw) => {
            const parsed = Number.parseInt(raw, 10);
            return Number.isFinite(parsed)
              ? Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, parsed))
              : customValue;
          }}
          aria-label={schemaAriaLabel(`${label} Custom`, path)}
          title={schemaTitle(path)}
          disabled={disabled}
          className="w-full min-w-0 flex-1 bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      )}
    </div>
  );
}
