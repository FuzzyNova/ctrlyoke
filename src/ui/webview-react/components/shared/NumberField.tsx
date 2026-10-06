import { useEffect, useRef, useState } from "react";
import type {
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { clamp } from "@utils/number";
import { SettingInputRow } from "./SettingInputRow";

export interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  note?: string;
  path?: string;
  sources?: Record<string, SettingSource>;
  onReset?: (path: string) => void;
  activeScope?: SettingWriteScope;
}

export function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  note,
  path,
  sources,
  onReset,
  activeScope,
}: NumberFieldProps) {
  const [localValue, setLocalValue] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) {
      setLocalValue(String(value));
    }
  }, [value]);

  const displayNum = Number(localValue);
  const isInvalid =
    Number.isFinite(displayNum) && (displayNum < min || displayNum > max);

  return (
    <SettingInputRow
      label={label}
      id={id}
      path={path}
      sources={sources}
      onReset={onReset}
      activeScope={activeScope}
    >
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={(e) => {
          focused.current = false;
          const next = Number(e.target.value);
          if (Number.isFinite(next)) {
            onChange(clamp(next, min, max));
          }
        }}
        className={`w-full bg-input-bg border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border ${
          isInvalid ? "border-input-error-border" : "border-input-border"
        }`}
      />
      {isInvalid && (
        <p className="text-xs text-error-fg mt-1">
          Enter a value from {min} to {max}.
        </p>
      )}
      {note && <p className="text-xs text-description-fg mt-1">{note}</p>}
    </SettingInputRow>
  );
}
