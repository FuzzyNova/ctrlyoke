import React, { useEffect, useState } from "react";
import { PROMPT_PROPERTIES, STEP_TYPES } from "@root/types/DashboardConstants";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { getInheritedStepColor } from "../../utils/stepColor";

interface StepColorInputState {
  color: string;
  inheritedColor: string;
  hasOverride: boolean;
  setColor: (color: string) => void;
  commit: () => void;
  reset: () => void;
}

export function useStepColorInput(): StepColorInputState {
  const { properties, setProperty, stepType } = useEditorStore();
  const { globalSettings, getEffectiveHarness } = useSettingsStore();
  const inheritedColor = getInheritedStepColor(
    stepType === STEP_TYPES.SCRIPT ? undefined : getEffectiveHarness(),
    globalSettings.harnessColors
  );
  const hasOverride = properties.color !== undefined;
  const [color, setColor] = useState(properties.color ?? inheritedColor);

  useEffect(() => {
    setColor(properties.color ?? inheritedColor);
  }, [inheritedColor, properties.color]);

  return {
    color,
    inheritedColor,
    hasOverride,
    setColor,
    commit: () => setProperty(PROMPT_PROPERTIES.COLOR, color),
    reset: () => {
      setColor(inheritedColor);
      setProperty(PROMPT_PROPERTIES.COLOR, undefined);
    },
  };
}

export interface StepColorFieldProps {
  /** Prefix keeps the input ID unique when the editor surfaces coexist. */
  idPrefix: string;
}

/** Full step-color control for an all-properties editor surface. */
export const StepColorField: React.FC<StepColorFieldProps> = ({ idPrefix }) => {
  const {
    color,
    inheritedColor,
    hasOverride,
    setColor,
    commit,
    reset,
  } = useStepColorInput();
  const inputId = `${idPrefix}-color`;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className="text-xs font-semibold uppercase text-description-fg"
          title="Override the step identity color used across the dashboard."
        >
          Step Color
        </label>
        <button
          type="button"
          onClick={reset}
          disabled={!hasOverride}
          className="flex h-6 w-6 items-center justify-center rounded text-description-fg transition-colors hover:bg-toolbar-hover-bg hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title="Reset step color to inherit"
          aria-label="Reset step color to inherit"
        >
          <i className="codicon codicon-clear-all" aria-hidden="true" />
        </button>
      </div>
      <input
        id={inputId}
        type="color"
        value={color}
        onChange={(event) => setColor(event.target.value)}
        onBlur={commit}
        className="h-8 w-full cursor-pointer rounded border border-input-border bg-input-bg p-0.5"
        title={
          hasOverride
            ? `Step color override: ${color}`
            : `Inherited step color: ${inheritedColor}`
        }
        aria-label="Step color"
      />
      <p className="text-xs text-description-fg">
        {hasOverride ? `Override: ${color}` : `Inherited: ${inheritedColor}`}
      </p>
    </div>
  );
};
