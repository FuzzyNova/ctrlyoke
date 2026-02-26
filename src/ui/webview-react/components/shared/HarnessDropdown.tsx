import React, { useState, useCallback, useEffect, useRef } from "react";
import { HARNESS_IDS, type HarnessId, type HarnessStatusString } from "../../types/messages";
import { useElementNarrow } from "../../hooks/useElementNarrow";

// ─── Display names (official product names) ──────────────────────────────────

export const HARNESS_DISPLAY_NAMES: Record<HarnessId, string> = {
  [HARNESS_IDS.COPILOT_CLI]: "Copilot CLI",
  [HARNESS_IDS.COPILOT_CHAT]: "Copilot",
  [HARNESS_IDS.CLAUDE_CLI]: "Claude Code",
  [HARNESS_IDS.CODEX_CLI]: "Codex",
};

// ─── Grouping ─────────────────────────────────────────────────────────────────

export const CLI_HARNESSES: HarnessId[] = [
  HARNESS_IDS.COPILOT_CLI,
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.CODEX_CLI,
];

export const CHAT_HARNESSES: HarnessId[] = [HARNESS_IDS.COPILOT_CHAT];

/** Returns the integration category for a harness value, or null for "default". */
export function harnessCategory(value: string): "cli" | "chat" | null {
  if (CLI_HARNESSES.includes(value as HarnessId)) return "cli";
  if (CHAT_HARNESSES.includes(value as HarnessId)) return "chat";
  return null;
}

// copilot-chat is the only item in its section — hiding it would leave the
// VS Code Chat group empty, so we never show an eye icon for it.
const NON_HIDEABLE: HarnessId[] = [HARNESS_IDS.COPILOT_CHAT];

// ─── Sub-components ───────────────────────────────────────────────────────────

const StatusIndicator: React.FC<{
  status: HarnessStatusString;
  narrow?: boolean;
}> = ({ status, narrow = false }) => {
  const config: Record<
    HarnessStatusString,
    { color: string; text: string; animate: boolean }
  > = {
    checking: { color: "bg-yellow-400", text: "Checking...", animate: true },
    available: { color: "bg-green-500", text: "Available", animate: false },
    unavailable: { color: "bg-red-400", text: "Not Available", animate: false },
  };
  const { color, text, animate } = config[status] ?? config.checking;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-description-fg">
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${color} ${animate ? "animate-pulse" : ""}`}
      />
      {!narrow && text}
    </span>
  );
};

const GroupHeader: React.FC<{ label: string }> = ({ label }) => (
  <div className="px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-description-fg bg-editor-bg border-b border-dropdown-border select-none">
    {label}
  </div>
);

// ─── Harness row ──────────────────────────────────────────────────────────────

interface HarnessRowProps {
  harness: HarnessId;
  isSelected: boolean;
  isHidden: boolean;
  showStatus: boolean;
  narrow: boolean;
  harnessStatus?: Record<string, { status: HarnessStatusString; available?: boolean }>;
  canHideRow: boolean;
  onSelect: (h: HarnessId) => void;
  onHide?: (h: HarnessId) => void;
  onUnhide?: (h: HarnessId) => void;
}

const HarnessRow: React.FC<HarnessRowProps> = ({
  harness,
  isSelected,
  isHidden,
  showStatus,
  narrow,
  harnessStatus,
  canHideRow,
  onSelect,
  onHide,
  onUnhide,
}) => {
  const status = harnessStatus?.[harness];
  const isAvailable = status?.available !== false;
  const isChecking = status?.status === "checking";
  const name = HARNESS_DISPLAY_NAMES[harness] ?? harness;

  if (isHidden) {
    // Dimmed, italic, eye-open on the left to restore
    return (
      <div className="group flex items-center opacity-60 italic hover:bg-list-hover-bg cursor-pointer">
        <button
          type="button"
          title="Unhide this harness"
          onClick={(e) => {
            e.stopPropagation();
            onUnhide?.(harness);
          }}
          className="flex-shrink-0 px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent"
        >
          <i className="codicon codicon-eye text-[11px]" />
        </button>
        <button
          type="button"
          onClick={() => onSelect(harness)}
          className="flex-1 min-w-0 pr-2 py-1.5 text-xs text-left text-description-fg focus:outline-none border-none bg-transparent cursor-pointer"
        >
          {name}
        </button>
        {showStatus && status && (
          <StatusIndicator status={status.status} narrow={narrow} />
        )}
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center pr-2 gap-1 ${
        isSelected
          ? "bg-dropdown-selected-bg text-list-active-fg"
          : !isAvailable && !isChecking
            ? "opacity-50 cursor-not-allowed"
            : "hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer"
      }`}
    >
      <button
        type="button"
        onClick={() => (isAvailable || isChecking ? onSelect(harness) : undefined)}
        disabled={!isAvailable && !isChecking}
        className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left focus:outline-none border-none bg-transparent disabled:cursor-not-allowed cursor-inherit"
      >
        {name}
      </button>
      {/* Eye-closed — hover-only, left of status dot, never on selected or non-hideable */}
      {canHideRow && (
        <button
          type="button"
          title="Hide this harness"
          onClick={(e) => {
            e.stopPropagation();
            onHide?.(harness);
          }}
          className="flex-shrink-0 p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent transition-opacity"
        >
          <i className="codicon codicon-eye-closed text-[11px]" />
        </button>
      )}
      {showStatus && status && (
        <StatusIndicator status={status.status} narrow={narrow} />
      )}
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

export interface HarnessDropdownProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Show a "Default" sentinel option above the groups (for per-prompt overrides). */
  showDefault?: boolean;
  /** Show availability status dots. Default true. Pass false in PropertiesDrawer. */
  showStatus?: boolean;
  /** Required when showStatus is true. */
  harnessStatus?: Record<string, { status: HarnessStatusString; available?: boolean }>;
  hiddenValues?: string[];
  onHideOption?: (value: string) => void;
  onUnhideOption?: (value: string) => void;
}

export const HarnessDropdown: React.FC<HarnessDropdownProps> = ({
  id,
  value,
  onChange,
  showDefault = false,
  showStatus = true,
  harnessStatus,
  hiddenValues = [],
  onHideOption,
  onUnhideOption,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [narrowRef, isNarrow] = useElementNarrow<HTMLDivElement>(160);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const mergedRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      narrowRef(node);
    },
    [narrowRef]
  );

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setShowHidden(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const handleSelect = (harnessId: string) => {
    onChange(harnessId);
    setIsOpen(false);
    setShowHidden(false);
  };

  // Selecting a hidden item also unhides it
  const handleSelectHidden = (harnessId: HarnessId) => {
    onUnhideOption?.(harnessId);
    onChange(harnessId);
    setIsOpen(false);
    setShowHidden(false);
  };

  // ── Derived display label for the trigger button ──────────────────────────
  const triggerLabel =
    value === "default"
      ? "Default"
      : (HARNESS_DISPLAY_NAMES[value as HarnessId] ?? value);

  const triggerStatus =
    showStatus && value !== "default" && harnessStatus
      ? harnessStatus[value as HarnessId]
      : undefined;

  // ── Hide helpers ──────────────────────────────────────────────────────────
  const isHiddenValue = (h: HarnessId) => hiddenValues.includes(h);

  const canHide = (h: HarnessId) =>
    !NON_HIDEABLE.includes(h) &&
    h !== (value as HarnessId) && // never hide the selected item
    !isHiddenValue(h);

  const totalHidden = [...CLI_HARNESSES, ...CHAT_HARNESSES].filter(isHiddenValue).length;

  // ── Group renderer ────────────────────────────────────────────────────────
  const renderGroup = (harnesses: HarnessId[]) =>
    harnesses.map((harness) => {
      const hidden = isHiddenValue(harness);
      if (hidden && !showHidden) return null;
      return (
        <HarnessRow
          key={harness}
          harness={harness}
          isSelected={value === harness}
          isHidden={hidden}
          showStatus={showStatus}
          narrow={isNarrow}
          harnessStatus={harnessStatus}
          canHideRow={canHide(harness)}
          onSelect={handleSelect}
          onHide={onHideOption}
          onUnhide={onUnhideOption ? () => onUnhideOption(harness) : undefined}
        />
      );
    });

  return (
    <div className="relative inline-block w-full" ref={mergedRef}>
      {/* Trigger button */}
      <button
        id={id}
        type="button"
        onClick={() =>
          setIsOpen((prev) => {
            if (prev) setShowHidden(false);
            return !prev;
          })
        }
        className="w-full px-2 py-1 text-xs bg-dropdown-bg text-dropdown-fg border border-dropdown-border rounded focus:outline-none focus:border-focus-border text-left flex items-center justify-between h-7"
      >
        <span>{triggerLabel}</span>
        <div className="flex items-center gap-1">
          {triggerStatus && (
            <StatusIndicator status={triggerStatus.status} narrow={isNarrow} />
          )}
          <i
            className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-[10px]`}
          />
        </div>
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-0 bg-dropdown-bg border border-dropdown-border z-50 shadow-lg">

          {/* "Default" sentinel (PropertiesDrawer only) */}
          {showDefault && (
            <div
              className={`flex items-center ${
                value === "default"
                  ? "bg-dropdown-selected-bg text-list-active-fg"
                  : "hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer"
              }`}
            >
              <button
                type="button"
                onClick={() => handleSelect("default")}
                className="flex-1 px-2 py-1.5 text-xs text-left focus:outline-none border-none bg-transparent cursor-inherit"
              >
                Default
              </button>
            </div>
          )}

          {/* ── CLI group ── */}
          <GroupHeader label="CLI" />
          {renderGroup(CLI_HARNESSES)}

          {/* ── VS Code Chat group ── */}
          <div className="border-t border-dropdown-border" />
          <GroupHeader label="VS Code Chat" />
          {renderGroup(CHAT_HARNESSES)}

          {/* ── Footer ── */}
          <div className="border-t border-dropdown-border bg-editor-bg">
            <button
              type="button"
              disabled={totalHidden === 0}
              onClick={() => setShowHidden((s) => !s)}
              className="w-full px-2 py-1.5 text-xs text-center text-description-fg disabled:opacity-40 hover:enabled:bg-list-hover-bg focus:outline-none border-none bg-transparent transition-colors"
            >
              {showHidden
                ? "Hide hidden"
                : totalHidden > 0
                  ? `Show hidden (${totalHidden})`
                  : "Show hidden"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
