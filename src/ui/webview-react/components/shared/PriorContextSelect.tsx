import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { PriorContext } from "@/types/messages";

export interface PriorPrompt {
  /** 1-based prompt number */
  number: number;
  name?: string;
}

interface PriorContextSelectProps {
  id?: string;
  value: PriorContext | undefined;
  onChange: (value: PriorContext | undefined) => void;
  /** Show "Default (inherit from workflow)" as the first option. Use in prompt-level UI. */
  showDefault?: boolean;
  /** Override label for the Default option (e.g. "Default (None)" or "Default (Previous prompt)"). */
  defaultLabel?: string;
  /**
   * When provided, adds a "Select specific prompts" section with checkboxes.
   * Omit for workflow-level UI where specific prompt indices don't apply.
   */
  priorPrompts?: PriorPrompt[];
  dropdownMaxHeight?: string;
}

export type KeywordMode =
  | "default"
  | "none"
  | "previous"
  | "all"
  | "finalPromptAll"
  | "finalPromptPrevious";

export const PRIOR_CONTEXT_KEYWORD_LABELS: Record<KeywordMode, string> = {
  default: "Default (inherit from workflow)",
  none: "None",
  previous: "Previous prompt",
  all: "All prior prompts",
  finalPromptAll: "All finalPrompt outputs",
  finalPromptPrevious: "Previous finalPrompt output",
};

/** Convert a CSS max-height prop string ("60vh", "150px") to pixels. */
function parsePropMaxHeight(h: string): number {
  if (h.endsWith("vh")) return (parseFloat(h) / 100) * window.innerHeight;
  return parseFloat(h);
}

function getMode(value: PriorContext | undefined): KeywordMode | "custom" {
  if (value === undefined) return "default";
  if (Array.isArray(value)) return "custom";
  return value as KeywordMode;
}

function getCustomIndices(value: PriorContext | undefined): number[] {
  if (Array.isArray(value)) return value;
  return [];
}

/**
 * PriorContextSelect — Single dropdown for the priorContext property.
 *
 * The popup is rendered via a portal at document.body with position:fixed so
 * it escapes any overflow:hidden ancestors and is never clipped.
 *
 * Top section: keyword options (Default, None, Previous, All, finalPromptAll,
 * finalPromptPrevious). When `priorPrompts` is provided, a divider and a
 * "Select specific prompts" section with per-prompt checkboxes appear below.
 * Checking a prompt number switches to custom array mode; selecting a keyword
 * clears the custom selection.
 */
export const PriorContextSelect: React.FC<PriorContextSelectProps> = ({
  id,
  value,
  onChange,
  showDefault = false,
  defaultLabel,
  priorPrompts,
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
  const customIndices = getCustomIndices(value);
  const hasCustomSection = priorPrompts && priorPrompts.length > 0;

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 4;
      const propMaxH = parsePropMaxHeight(dropdownMaxHeight);
      if (spaceBelow >= 80) {
        setPopupPos({ top: rect.bottom + 4, left: rect.left, width: rect.width, maxHeight: Math.min(propMaxH, spaceBelow) });
      } else {
        const spaceAbove = rect.top - 4;
        setPopupPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, width: rect.width, maxHeight: Math.min(propMaxH, spaceAbove) });
      }
    }
  }, [dropdownMaxHeight]);

  // Compute/update position whenever the popup opens or the window moves.
  // Reset to null on close so stale coordinates never flash on next open.
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

  // Close on click outside (must check both button and portaled popup)
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
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const selectKeyword = (k: KeywordMode) => {
    onChange(k === "default" ? undefined : k);
    setIsOpen(false);
  };

  const togglePromptNumber = (n: number) => {
    const newIndices = customIndices.includes(n)
      ? customIndices.filter((i) => i !== n)
      : [...customIndices, n].sort((a, b) => a - b);

    // If all deselected, fall back to undefined (default/inherit)
    onChange(newIndices.length === 0 ? undefined : newIndices);
  };

  // Build button label
  let buttonLabel: string;
  if (mode === "custom") {
    buttonLabel =
      customIndices.length === 0
        ? "Custom (edit in YAML)"
        : `Custom: [${customIndices.join(", ")}]`;
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
        "finalPromptAll",
        "finalPromptPrevious",
      ]
    : ["none", "previous", "all", "finalPromptAll", "finalPromptPrevious"];

  return (
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
          className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-[10px] flex-shrink-0 ml-1`}
        />
      </button>

      {isOpen && popupPos &&
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
              {/* Keyword options */}
              {keywords.map((k) => {
                const isSelected = mode === k;
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
                      className={`codicon codicon-check text-[10px] flex-shrink-0 ${
                        isSelected ? "visible" : "invisible"
                      }`}
                    />
                    <span>{label}</span>
                  </button>
                );
              })}

              {/* Custom prompt number section */}
              {hasCustomSection && (
                <>
                  <div className="border-t border-dropdown-border" />
                  <div className="px-2 py-1 text-[10px] text-description-fg uppercase font-semibold tracking-wide">
                    Select specific prompts:
                  </div>
                  {priorPrompts!.map((p) => {
                    const isChecked = customIndices.includes(p.number);
                    return (
                      <button
                        key={p.number}
                        type="button"
                        onClick={() => togglePromptNumber(p.number)}
                        className={`w-full px-2 py-1.5 text-xs text-left flex items-center gap-2 focus:outline-none border-none ${
                          isChecked
                            ? "bg-dropdown-selected-bg text-list-active-fg"
                            : "hover:bg-list-hover-bg cursor-pointer"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          className="w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
                          tabIndex={-1}
                        />
                        <span className="truncate">
                          {p.number}
                          {p.name ? `: ${p.name}` : ""}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
