import {
  INHERIT_DEFAULT_OPTION,
  PRIOR_CONTEXT_SELECTION_MODES,
  PRIOR_CONTEXT_KEYWORDS,
} from "@root/types/DashboardConstants";
import { PRIOR_CONTEXT_SELECT_OPTIONS_META } from "@root/types/SchemaUiMetadata";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";
import React, { useId, useState, useEffect, useRef } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { DropdownPortal } from "./DropdownPortal";
import type { PriorContext, WorkflowRunAddress } from "@/types/messages";
import {
  isPreviousStepsPriorContext,
  isWorkflowRunAddress,
} from "@root/types/CtrlYokeTypes";
import { formatPriorContextLabel } from "@utils/priorContext";
import {
  formatRangeNotation,
  parseRangeNotation,
} from "@root/utils/RangeNotationParser";
import { dropdownBorderClass } from "@utils/dropdownValidation";
import { Icon } from "./Icon";

interface PriorContextSelectProps {
  id?: string;
  value: PriorContext | undefined;
  onChange: (value: PriorContext | undefined) => void;
  /** Show the "Inherit (<resolved label>)" option first. Use in prompt-level UI. */
  showDefault?: boolean;
  /** Override label for the Inherit option (e.g. "Inherit (None)" or "Inherit (Previous)"). */
  defaultLabel?: string;
  dropdownMaxHeight?: string;
  schemaPath?: string;
  /**
   * Offer the "Completed run output" option. Off for settings defaults, whose
   * schema has no run-address form (a run belongs to one workspace).
   */
  allowRunAddress?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export type KeywordMode = keyof typeof PRIOR_CONTEXT_SELECT_OPTIONS_META;

/** Count the "Previous N" option starts at when first selected. */
const DEFAULT_PREVIOUS_COUNT = 3;

function getMode(value: PriorContext | undefined): KeywordMode {
  if (value === undefined) return INHERIT_DEFAULT_OPTION;
  if (Array.isArray(value)) return PRIOR_CONTEXT_SELECTION_MODES.CUSTOM;
  if (isPreviousStepsPriorContext(value))
    return PRIOR_CONTEXT_SELECTION_MODES.PREVIOUS_COUNT;
  if (isWorkflowRunAddress(value)) return PRIOR_CONTEXT_SELECTION_MODES.RUN;
  return value as KeywordMode;
}

/**
 * PriorContextSelect — Single dropdown for the priorContext property.
 *
 * The popup is rendered via a portal at document.body with position:fixed so
 * it escapes any overflow:hidden ancestors and is never clipped.
 *
 * Keyword options: Default (optional), None, Previous, Previous N, All,
 * finalStepPrevious, finalStepAll, Run, Custom. "Previous N" shows a count
 * input and writes `{ previous: N }`, which stays relative to the step; when
 * "Custom" is selected, a text input appears below the dropdown where the user
 * can enter absolute range notation like "1,2,4-10".
 */
export const PriorContextSelect: React.FC<PriorContextSelectProps> = ({
  id,
  value,
  onChange,
  showDefault = false,
  defaultLabel,
  dropdownMaxHeight = "60vh",
  schemaPath = "priorContext",
  allowRunAddress = true,
  disabled = false,
  disabledReason,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const reactId = useId();
  const listboxId = id
    ? `${id}-listbox`
    : `prior-context-listbox-${reactId.replace(/:/g, "")}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const popupPos = useDropdownPortalPosition(
    buttonRef,
    isOpen,
    dropdownMaxHeight
  );
  useClickOutside([buttonRef, popupRef], isOpen, () => setIsOpen(false));

  const mode = getMode(value);
  const inheritLabel = defaultLabel ?? "Inherit (None)";

  // Custom input state
  const [wantsCustom, setWantsCustom] = useState(
    () => mode === PRIOR_CONTEXT_SELECTION_MODES.CUSTOM
  );
  const [wantsRun, setWantsRun] = useState(
    () => mode === PRIOR_CONTEXT_SELECTION_MODES.RUN
  );
  const [customText, setCustomText] = useState(() =>
    Array.isArray(value) ? formatRangeNotation(value) : ""
  );
  const [workflowKey, setWorkflowKey] = useState(() =>
    isWorkflowRunAddress(value) ? value.workflowKey : ""
  );
  const [runRef, setRunRef] = useState(() =>
    isWorkflowRunAddress(value) ? value.runRef : ""
  );
  const [previousCountText, setPreviousCountText] = useState(() =>
    String(
      isPreviousStepsPriorContext(value)
        ? value.previous
        : DEFAULT_PREVIOUS_COUNT
    )
  );
  const [customError, setCustomError] = useState(false);
  // Track onChange calls originating from our text input so we don't sync back
  const textChangePendingRef = useRef(false);
  // Selecting RUN is a local choice until both address fields have a value.
  const runSelectionPendingRef = useRef(false);

  const showCustomInput =
    wantsCustom || mode === PRIOR_CONTEXT_SELECTION_MODES.CUSTOM;
  const showRunInputs = wantsRun || mode === PRIOR_CONTEXT_SELECTION_MODES.RUN;

  // Sync from external value changes (e.g. undo, workflow load)
  useEffect(() => {
    if (textChangePendingRef.current) {
      textChangePendingRef.current = false;
      return;
    }
    if (Array.isArray(value)) {
      setCustomText(formatRangeNotation(value));
      setWantsCustom(true);
      setCustomError(false);
    } else {
      setWantsCustom(false);
      setCustomText("");
      setCustomError(false);
    }
    if (isWorkflowRunAddress(value)) {
      setWorkflowKey(value.workflowKey);
      setRunRef(value.runRef);
      setWantsRun(true);
      runSelectionPendingRef.current = false;
    } else if (!runSelectionPendingRef.current) {
      setWantsRun(false);
    }
    if (isPreviousStepsPriorContext(value)) {
      setPreviousCountText(String(value.previous));
    }
  }, [value]);

  const selectKeyword = (k: KeywordMode) => {
    if (k === PRIOR_CONTEXT_SELECTION_MODES.CUSTOM) {
      setWantsCustom(true);
      setWantsRun(false);
      runSelectionPendingRef.current = false;
      setIsOpen(false);
      return;
    }
    if (k === PRIOR_CONTEXT_SELECTION_MODES.PREVIOUS_COUNT) {
      setWantsCustom(false);
      setWantsRun(false);
      runSelectionPendingRef.current = false;
      setCustomError(false);
      const count = parsePreviousCount(previousCountText);
      onChange({ previous: count ?? DEFAULT_PREVIOUS_COUNT });
      setIsOpen(false);
      return;
    }
    if (k === PRIOR_CONTEXT_SELECTION_MODES.RUN) {
      setWantsCustom(false);
      setWantsRun(true);
      runSelectionPendingRef.current = true;
      setIsOpen(false);
      return;
    }
    setWantsCustom(false);
    setWantsRun(false);
    runSelectionPendingRef.current = false;
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

  const handlePreviousCountChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const text = e.target.value.replace(/[^0-9]/g, "");
    setPreviousCountText(text);
    const count = parsePreviousCount(text);
    if (count !== undefined) onChange({ previous: count });
  };

  const updateRunAddress = (key: string, ref: string) => {
    setWorkflowKey(key);
    setRunRef(ref);
    if (key && ref) {
      runSelectionPendingRef.current = false;
      onChange({ workflowKey: key, runRef: ref } as WorkflowRunAddress);
    }
  };

  // Build button label
  const displayMode = showCustomInput
    ? PRIOR_CONTEXT_SELECTION_MODES.CUSTOM
    : showRunInputs
      ? PRIOR_CONTEXT_SELECTION_MODES.RUN
      : mode;
  let buttonLabel: string;
  if (showCustomInput) {
    buttonLabel = "Custom";
  } else if (showRunInputs) {
    buttonLabel =
      PRIOR_CONTEXT_SELECT_OPTIONS_META[PRIOR_CONTEXT_SELECTION_MODES.RUN]
        .label;
  } else if (value === undefined) {
    buttonLabel = inheritLabel;
  } else {
    buttonLabel = formatPriorContextLabel(value);
  }

  // The trigger names the value actually written; the option list keeps the
  // pseudo-options' example shapes.
  const triggerValue = isPreviousStepsPriorContext(value)
    ? { writes: `${schemaPath}: { previous: ${value.previous} }` }
    : (PRIOR_CONTEXT_SELECT_OPTIONS_META[mode].pseudo ?? mode);

  const allKeywords: KeywordMode[] = showDefault
    ? [
        INHERIT_DEFAULT_OPTION,
        PRIOR_CONTEXT_KEYWORDS.NONE,
        PRIOR_CONTEXT_KEYWORDS.PREVIOUS,
        PRIOR_CONTEXT_SELECTION_MODES.PREVIOUS_COUNT,
        PRIOR_CONTEXT_KEYWORDS.ALL,
        PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS,
        PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL,
        PRIOR_CONTEXT_SELECTION_MODES.RUN,
        PRIOR_CONTEXT_SELECTION_MODES.CUSTOM,
      ]
    : [
        PRIOR_CONTEXT_KEYWORDS.NONE,
        PRIOR_CONTEXT_KEYWORDS.PREVIOUS,
        PRIOR_CONTEXT_SELECTION_MODES.PREVIOUS_COUNT,
        PRIOR_CONTEXT_KEYWORDS.ALL,
        PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS,
        PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL,
        PRIOR_CONTEXT_SELECTION_MODES.RUN,
        PRIOR_CONTEXT_SELECTION_MODES.CUSTOM,
      ];
  const keywords = allowRunAddress
    ? allKeywords
    : allKeywords.filter((k) => k !== PRIOR_CONTEXT_SELECTION_MODES.RUN);

  return (
    <div className="flex flex-col gap-1 w-full">
      {/* Dropdown button */}
      <div className="relative inline-block w-full">
        <button
          ref={buttonRef}
          id={id}
          type="button"
          disabled={disabled}
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label={schemaAriaLabel(buttonLabel, schemaPath, triggerValue)}
          title={
            disabled && disabledReason
              ? disabledReason
              : schemaTitle(schemaPath, triggerValue)
          }
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          className="cy-select-trigger cy-dropdown-row"
        >
          <span className="truncate">{buttonLabel}</span>
          <Icon
            name={`chevron-${isOpen ? "up" : "down"}`}
            className="text-xxs flex-shrink-0 ml-1"
          />
        </button>

        <DropdownPortal
          isOpen={isOpen}
          popupPos={popupPos}
          ref={popupRef}
          id={listboxId}
          role="listbox"
        >
          <div className="overflow-y-auto min-h-0 flex-1">
            {keywords.map((k) => {
              const isSelected = displayMode === k;
              const label =
                k === INHERIT_DEFAULT_OPTION
                  ? inheritLabel
                  : PRIOR_CONTEXT_SELECT_OPTIONS_META[k].label;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => selectKeyword(k)}
                  aria-label={schemaAriaLabel(
                    label,
                    schemaPath,
                    PRIOR_CONTEXT_SELECT_OPTIONS_META[k].pseudo ?? k
                  )}
                  title={schemaTitle(
                    schemaPath,
                    PRIOR_CONTEXT_SELECT_OPTIONS_META[k].pseudo ?? k
                  )}
                  className={`w-full px-2 py-1.5 text-xs text-left flex items-center gap-2 focus:outline-none border-none ${
                    isSelected
                      ? "bg-dropdown-selected-bg text-list-active-fg cy-dropdown-row-selected"
                      : "hover:bg-list-hover-bg cursor-pointer cy-dropdown-row"
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

      {mode === PRIOR_CONTEXT_SELECTION_MODES.PREVIOUS_COUNT &&
        !showCustomInput &&
        !showRunInputs && (
          <div className="mt-1 flex flex-col gap-1">
            <input
              type="text"
              inputMode="numeric"
              value={previousCountText}
              onChange={handlePreviousCountChange}
              placeholder="e.g. 3"
              aria-label="Number of previous step outputs"
              className={`w-full px-2 text-xs bg-input-bg text-input-fg border rounded focus:outline-none focus:border-focus-border h-7 ${dropdownBorderClass(
                parsePreviousCount(previousCountText) === undefined,
                "error"
              )}`}
            />
            <span className="text-xxs text-description-fg">
              The last N outputs before this step, counted from this step so it
              stays correct when steps move.
            </span>
          </div>
        )}

      {showRunInputs && (
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

/** A whole count of at least 1, or undefined while the input is incomplete. */
function parsePreviousCount(text: string): number | undefined {
  const count = Number(text);
  return text !== "" && Number.isSafeInteger(count) && count >= 1
    ? count
    : undefined;
}
