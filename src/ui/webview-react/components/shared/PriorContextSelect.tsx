import {
  INHERIT_DEFAULT_OPTION,
  PRIOR_CONTEXT_SELECTION_MODES,
} from "@root/types/DashboardConstants";
import React, { useState, useEffect, useRef } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { DropdownPortal } from "./DropdownPortal";
import type { PriorContext, WorkflowRunAddress } from "@/types/messages";
import { parseRangeNotation } from "@root/utils/RangeNotationParser";
import { dropdownBorderClass } from "@utils/dropdownValidation";
import { Icon } from "./Icon";

interface PriorContextSelectProps {
  id?: string;
  value: PriorContext | undefined;
  onChange: (value: PriorContext | undefined) => void;
  /** Show "Default (inherit from workflow)" as the first option. Use in prompt-level UI. */
  showDefault?: boolean;
  /** Override label for the Default option (e.g. "Default (None)" or "Default (Previous step)"). */
  defaultLabel?: string;
  dropdownMaxHeight?: string;
}

export type KeywordMode =
  | typeof INHERIT_DEFAULT_OPTION
  | "none"
  | "previous"
  | "all"
  | "finalStepPrevious"
  | "finalStepAll"
  | typeof PRIOR_CONTEXT_SELECTION_MODES.RUN
  | typeof PRIOR_CONTEXT_SELECTION_MODES.CUSTOM;

export const PRIOR_CONTEXT_KEYWORD_LABELS: Record<KeywordMode, string> = {
  default: "Default (inherit from workflow)",
  none: "None",
  previous: "Previous step",
  all: "All prior steps",
  finalStepPrevious: "Previous final step output",
  finalStepAll: "All final step outputs",
  run: "Completed run output",
  [PRIOR_CONTEXT_SELECTION_MODES.CUSTOM]: "Custom",
};

function isRunAddress(
  value: PriorContext | undefined
): value is WorkflowRunAddress {
  return !!value && !Array.isArray(value) && typeof value === "object";
}

function getMode(value: PriorContext | undefined): KeywordMode {
  if (value === undefined) return INHERIT_DEFAULT_OPTION;
  if (Array.isArray(value)) return PRIOR_CONTEXT_SELECTION_MODES.CUSTOM;
  if (isRunAddress(value)) return PRIOR_CONTEXT_SELECTION_MODES.RUN;
  return value as KeywordMode;
}

/** Format a number[] as compact range notation, e.g. [1,2,4,5,6] → "1,2,4-6". */
function formatAsRangeNotation(nums: number[]): string {
  if (nums.length === 0) return "";
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      parts.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  parts.push(start === end ? `${start}` : `${start}-${end}`);
  return parts.join(",");
}

/**
 * PriorContextSelect — Single dropdown for the priorContext property.
 *
 * The popup is rendered via a portal at document.body with position:fixed so
 * it escapes any overflow:hidden ancestors and is never clipped.
 *
 * Keyword options: Default (optional), None, Previous, All, finalStepPrevious,
 * finalStepAll, Custom. When "Custom" is selected, a text input appears below
 * the dropdown where the user can enter range notation like "1,2,4-10".
 */
export const PriorContextSelect: React.FC<PriorContextSelectProps> = ({
  id,
  value,
  onChange,
  showDefault = false,
  defaultLabel,
  dropdownMaxHeight = "60vh",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const popupPos = useDropdownPortalPosition(
    buttonRef,
    isOpen,
    dropdownMaxHeight
  );
  useClickOutside([buttonRef, popupRef], isOpen, () => setIsOpen(false));

  const mode = getMode(value);

  // Custom input state
  const [wantsCustom, setWantsCustom] = useState(
    () => mode === PRIOR_CONTEXT_SELECTION_MODES.CUSTOM
  );
  const [customText, setCustomText] = useState(() =>
    Array.isArray(value) ? formatAsRangeNotation(value) : ""
  );
  const [workflowKey, setWorkflowKey] = useState(() =>
    isRunAddress(value) ? value.workflowKey : ""
  );
  const [runRef, setRunRef] = useState(() =>
    isRunAddress(value) ? value.runRef : ""
  );
  const [customError, setCustomError] = useState(false);
  // Track onChange calls originating from our text input so we don't sync back
  const textChangePendingRef = useRef(false);

  const showCustomInput =
    wantsCustom || mode === PRIOR_CONTEXT_SELECTION_MODES.CUSTOM;

  // Sync from external value changes (e.g. undo, workflow load)
  useEffect(() => {
    if (textChangePendingRef.current) {
      textChangePendingRef.current = false;
      return;
    }
    if (Array.isArray(value)) {
      setCustomText(formatAsRangeNotation(value));
      setWantsCustom(true);
      setCustomError(false);
    } else {
      setWantsCustom(false);
      setCustomText("");
      setCustomError(false);
    }
    if (isRunAddress(value)) {
      setWorkflowKey(value.workflowKey);
      setRunRef(value.runRef);
    }
  }, [value]);

  const selectKeyword = (k: KeywordMode) => {
    if (k === PRIOR_CONTEXT_SELECTION_MODES.CUSTOM) {
      setWantsCustom(true);
      setIsOpen(false);
      return;
    }
    if (k === PRIOR_CONTEXT_SELECTION_MODES.RUN) {
      setWantsCustom(false);
      setIsOpen(false);
      return;
    }
    setWantsCustom(false);
    setCustomText("");
    setCustomError(false);
    onChange(k === INHERIT_DEFAULT_OPTION ? undefined : k);
    setIsOpen(false);
  };

  const handleCustomTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Only allow digits, commas, and dashes
    const filtered = e.target.value.replace(/[^0-9,\-]/g, "");
    setCustomText(filtered);

    const trimmed = filtered.trim();
    if (!trimmed) {
      textChangePendingRef.current = true;
      onChange(undefined);
      setCustomError(false);
      return;
    }

    const parsed = parseRangeNotation(filtered);
    if (parsed) {
      textChangePendingRef.current = true;
      onChange(parsed);
      setCustomError(false);
    } else {
      setCustomError(true);
    }
  };

  const updateRunAddress = (key: string, ref: string) => {
    setWorkflowKey(key);
    setRunRef(ref);
    if (key && ref)
      onChange({ workflowKey: key, runRef: ref } as WorkflowRunAddress);
  };

  // Build button label
  const displayMode = showCustomInput
    ? PRIOR_CONTEXT_SELECTION_MODES.CUSTOM
    : mode;
  let buttonLabel: string;
  if (showCustomInput) {
    buttonLabel = "Custom";
  } else if (mode === INHERIT_DEFAULT_OPTION && defaultLabel) {
    buttonLabel = defaultLabel;
  } else {
    buttonLabel = PRIOR_CONTEXT_KEYWORD_LABELS[mode];
  }

  const keywords: KeywordMode[] = showDefault
    ? [
        INHERIT_DEFAULT_OPTION,
        "none",
        "previous",
        "all",
        "finalStepPrevious",
        "finalStepAll",
        PRIOR_CONTEXT_SELECTION_MODES.RUN,
        PRIOR_CONTEXT_SELECTION_MODES.CUSTOM,
      ]
    : [
        "none",
        "previous",
        "all",
        "finalStepPrevious",
        "finalStepAll",
        PRIOR_CONTEXT_SELECTION_MODES.RUN,
        PRIOR_CONTEXT_SELECTION_MODES.CUSTOM,
      ];

  return (
    <div className="flex flex-col gap-1 w-full">
      {/* Dropdown button */}
      <div className="relative inline-block w-full">
        <button
          ref={buttonRef}
          id={id}
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label="Prior context"
          className="fp-select-trigger fp-dropdown-row"
        >
          <span className="truncate">{buttonLabel}</span>
          <Icon
            name={`chevron-${isOpen ? "up" : "down"}`}
            className="text-xxs flex-shrink-0 ml-1"
          />
        </button>

        <DropdownPortal isOpen={isOpen} popupPos={popupPos} ref={popupRef}>
          <div className="overflow-y-auto min-h-0 flex-1">
            {keywords.map((k) => {
              const isSelected = displayMode === k;
              const label =
                k === INHERIT_DEFAULT_OPTION && defaultLabel
                  ? defaultLabel
                  : PRIOR_CONTEXT_KEYWORD_LABELS[k];
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => selectKeyword(k)}
                  className={`w-full px-2 py-1.5 text-xs text-left flex items-center gap-2 focus:outline-none border-none ${
                    isSelected
                      ? "bg-dropdown-selected-bg text-list-active-fg fp-dropdown-row-selected"
                      : "hover:bg-list-hover-bg cursor-pointer fp-dropdown-row"
                  }`}
                >
                  <Icon
                    name="check"
                    className={`text-xxs flex-shrink-0 ${
                      isSelected ? "visible" : "invisible"
                    }`}
                  />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </DropdownPortal>
      </div>

      {mode === PRIOR_CONTEXT_SELECTION_MODES.RUN && (
        <div className="mt-1 grid grid-cols-1 gap-1">
          <input
            value={workflowKey}
            onChange={(event) => updateRunAddress(event.target.value, runRef)}
            placeholder="Workflow key"
            aria-label="Prior-context workflow key"
            className="w-full px-2 text-xs bg-input-bg text-input-fg border rounded focus:outline-none focus:border-focus-border h-7"
          />
          <input
            value={runRef}
            onChange={(event) =>
              updateRunAddress(workflowKey, event.target.value)
            }
            placeholder="Run reference"
            aria-label="Prior-context run reference"
            className="w-full px-2 text-xs bg-input-bg text-input-fg border rounded focus:outline-none focus:border-focus-border h-7"
          />
          <span className="text-xxs text-description-fg">
            Imports all output from a completed run in this workspace.
          </span>
        </div>
      )}

      {/* Custom range input — always rendered, disabled when not in custom mode */}
      <div
        className={`mt-1${showCustomInput ? "" : " opacity-50 pointer-events-none"}`}
        title={
          showCustomInput ? undefined : "Select 'Custom' to specify step ranges"
        }
      >
        <input
          type="text"
          value={customText}
          onChange={handleCustomTextChange}
          disabled={!showCustomInput}
          placeholder="e.g. 1,2,4-10"
          aria-label="Custom step range (e.g. 1,2,4-10)"
          className={`w-full px-2 text-xs bg-input-bg text-input-fg border rounded focus:outline-none focus:border-focus-border h-7 ${dropdownBorderClass(
            customError,
            "error"
          )}`}
        />
        {customError && (
          <span className="text-xxs text-error-fg mt-0.5 block">
            Use numbers, commas, and ranges (e.g. 1,3,5-10)
          </span>
        )}
      </div>
    </div>
  );
};
