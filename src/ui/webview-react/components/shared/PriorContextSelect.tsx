import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { PriorContext } from "@/types/messages";
import { parseRangeNotation } from "@root/utils/RangeNotationParser";

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
  | "default"
  | "none"
  | "previous"
  | "all"
  | "finalStepPrevious"
  | "finalStepAll"
  | "custom";

export const PRIOR_CONTEXT_KEYWORD_LABELS: Record<KeywordMode, string> = {
  default: "Default (inherit from workflow)",
  none: "None",
  previous: "Previous step",
  all: "All prior steps",
  finalStepPrevious: "Previous final step output",
  finalStepAll: "All final step outputs",
  custom: "Custom",
};

/** Convert a CSS max-height prop string ("60vh", "150px") to pixels. */
function parsePropMaxHeight(h: string): number {
  if (h.endsWith("vh")) return (parseFloat(h) / 100) * window.innerHeight;
  return parseFloat(h);
}

function getMode(value: PriorContext | undefined): KeywordMode {
  if (value === undefined) return "default";
  if (Array.isArray(value)) return "custom";
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
  const [popupPos, setPopupPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const mode = getMode(value);

  // Custom input state
  const [wantsCustom, setWantsCustom] = useState(() => mode === "custom");
  const [customText, setCustomText] = useState(() =>
    Array.isArray(value) ? formatAsRangeNotation(value) : ""
  );
  const [customError, setCustomError] = useState(false);
  // Track onChange calls originating from our text input so we don't sync back
  const textChangePendingRef = useRef(false);

  const showCustomInput = wantsCustom || mode === "custom";

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
  }, [value]);

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 4;
      const propMaxH = parsePropMaxHeight(dropdownMaxHeight);
      if (spaceBelow >= 80) {
        setPopupPos({
          top: rect.bottom + 4,
          left: rect.left,
          width: rect.width,
          maxHeight: Math.min(propMaxH, spaceBelow),
        });
      } else {
        const spaceAbove = rect.top - 4;
        setPopupPos({
          bottom: window.innerHeight - rect.top + 4,
          left: rect.left,
          width: rect.width,
          maxHeight: Math.min(propMaxH, spaceAbove),
        });
      }
    }
  }, [dropdownMaxHeight]);

  useEffect(() => {
    if (isOpen) {
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
    } else {
      setPopupPos(null);
    }
  }, [isOpen, updatePosition]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const selectKeyword = (k: KeywordMode) => {
    if (k === "custom") {
      setWantsCustom(true);
      setIsOpen(false);
      return;
    }
    setWantsCustom(false);
    setCustomText("");
    setCustomError(false);
    onChange(k === "default" ? undefined : k);
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

  // Build button label
  const displayMode = showCustomInput ? "custom" : mode;
  let buttonLabel: string;
  if (showCustomInput) {
    buttonLabel = "Custom";
  } else if (mode === "default" && defaultLabel) {
    buttonLabel = defaultLabel;
  } else {
    buttonLabel = PRIOR_CONTEXT_KEYWORD_LABELS[mode];
  }

  const keywords: KeywordMode[] = showDefault
    ? [
        "default",
        "none",
        "previous",
        "all",
        "finalStepPrevious",
        "finalStepAll",
        "custom",
      ]
    : [
        "none",
        "previous",
        "all",
        "finalStepPrevious",
        "finalStepAll",
        "custom",
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
          className="w-full px-2 py-1 text-xs bg-dropdown-bg text-dropdown-fg border border-dropdown-border rounded focus:outline-none focus:border-focus-border text-left flex items-center justify-between h-7"
        >
          <span className="truncate">{buttonLabel}</span>
          <i
            className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-xxs flex-shrink-0 ml-1`}
          />
        </button>

        {isOpen &&
          popupPos &&
          createPortal(
            <div
              ref={popupRef}
              className="fixed bg-dropdown-bg border border-dropdown-border z-[9999] shadow-lg flex flex-col"
              style={{
                top: popupPos.top,
                bottom: popupPos.bottom,
                left: popupPos.left,
                width: popupPos.width,
                maxHeight: popupPos.maxHeight,
              }}
            >
              <div className="overflow-y-auto min-h-0 flex-1">
                {keywords.map((k) => {
                  const isSelected = displayMode === k;
                  const label =
                    k === "default" && defaultLabel
                      ? defaultLabel
                      : PRIOR_CONTEXT_KEYWORD_LABELS[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => selectKeyword(k)}
                      className={`w-full px-2 py-1.5 text-xs text-left flex items-center gap-2 focus:outline-none border-none ${
                        isSelected
                          ? "bg-dropdown-selected-bg text-list-active-fg"
                          : "hover:bg-list-hover-bg cursor-pointer"
                      }`}
                    >
                      <i
                        className={`codicon codicon-check text-xxs flex-shrink-0 ${
                          isSelected ? "visible" : "invisible"
                        }`}
                      />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body
          )}
      </div>

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
          className={`w-full px-2 text-xs bg-input-bg text-input-fg border rounded focus:outline-none focus:border-focus-border h-7 ${
            customError ? "border-input-error-border" : "border-input-border"
          }`}
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
