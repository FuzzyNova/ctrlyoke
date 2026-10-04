import React from "react";
import { useStepColorInput } from "./StepColorField";

interface StepColorQuickPickerProps {
  /** When true, the control is disabled (CLI watch mode). */
  disabled?: boolean;
}

/** Compact header control for overriding a step's identity color. */
export const StepColorQuickPicker: React.FC<StepColorQuickPickerProps> = ({
  disabled = false,
}) => {
  const { color, setColor, commit, hasOverride, mixed } = useStepColorInput();

  return (
    <span
      className="relative h-5 w-5 flex-shrink-0"
      title={mixed ? "Selected steps have mixed colors" : undefined}
    >
      {mixed && (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded border border-input-border"
          style={{
            background:
              "repeating-linear-gradient(135deg, #808080 0 3px, #d0d0d0 3px 6px)",
          }}
        />
      )}
      <input
        type="color"
        value={color}
        onChange={(event) => setColor(event.target.value)}
        onBlur={commit}
        disabled={disabled}
        title={
          mixed
            ? "Selected steps have mixed colors — choose a color to apply it to all"
            : hasOverride
              ? `Step color override: ${color}`
              : `Step color: inherited (${color})`
        }
        aria-label="Step color"
        data-mixed={mixed || undefined}
        className={`relative h-5 w-5 cursor-pointer rounded border border-input-border bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50 ${mixed ? "opacity-0" : ""}`}
      />
    </span>
  );
};
