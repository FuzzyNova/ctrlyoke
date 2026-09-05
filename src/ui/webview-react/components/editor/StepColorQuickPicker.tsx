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
  const { color, setColor, commit, hasOverride } = useStepColorInput();

  return (
    <input
      type="color"
      value={color}
      onChange={(event) => setColor(event.target.value)}
      onBlur={commit}
      disabled={disabled}
      title={
        hasOverride
          ? `Step color override: ${color}`
          : `Step color: inherited (${color})`
      }
      aria-label="Step color"
      className="h-5 w-5 flex-shrink-0 cursor-pointer rounded border border-input-border bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
};
