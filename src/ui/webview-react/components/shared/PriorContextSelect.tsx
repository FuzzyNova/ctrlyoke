import React, { useState, useEffect, useRef } from "react";
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
  const containerRef = useRef<HTMLDivElement>(null);

  const mode = getMode(value);
  const customIndices = getCustomIndices(value);
  const hasCustomSection = priorPrompts && priorPrompts.length > 0;

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
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
    <div className="relative inline-block w-full" ref={containerRef}>
      <button
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

      <div
        className={`absolute top-full left-0 right-0 mt-0 bg-dropdown-bg border border-dropdown-border z-50 shadow-lg transition-all duration-150 origin-top flex flex-col ${
          isOpen
            ? "opacity-100 translate-y-0 visible"
            : "opacity-0 -translate-y-1 invisible pointer-events-none"
        }`}
        style={{ maxHeight: dropdownMaxHeight }}
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
      </div>
    </div>
  );
};
