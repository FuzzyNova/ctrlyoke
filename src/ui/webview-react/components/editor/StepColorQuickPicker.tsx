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
  const { color, setColor, commit, reset, hasOverride } = useStepColorInput();

  return (
    <div className="flex items-center gap-0.5">
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
        className="h-5 w-5 cursor-pointer rounded border border-input-border bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <button
        type="button"
        onClick={reset}
        disabled={disabled || !hasOverride}
        title="Reset step color to inherit"
        aria-label="Reset step color to inherit"
        className="control-button flex items-center bg-transparent border-none px-0.5 leading-none text-description-fg transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <i className="codicon codicon-clear-all text-xs" aria-hidden="true" />
      </button>
    </div>
  );
};
