import React, { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  type HarnessId,
  type HarnessStatusString,
} from "../../types/messages";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { HarnessIcon } from "./HarnessIcon";

// ─── Display names (official product names) ──────────────────────────────────

export const HARNESS_DISPLAY_NAMES: Record<HarnessId, string> = {
  [HARNESS_IDS.COPILOT_CLI]: "Copilot CLI",
  [HARNESS_IDS.COPILOT_CHAT]: "Copilot",
  [HARNESS_IDS.CLAUDE_CLI]: "Claude Code",
  [HARNESS_IDS.CODEX_CLI]: "Codex",
  [HARNESS_IDS.OPENCODE_CLI]: "OpenCode",
  [HARNESS_IDS.QWEN_CLI]: "Qwen Code",
  [HARNESS_IDS.GEMINI_CLI]: "Gemini",
};

// ─── Grouping ─────────────────────────────────────────────────────────────────

export const CLI_HARNESSES: HarnessId[] = [
  HARNESS_IDS.COPILOT_CLI,
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.CODEX_CLI,
  HARNESS_IDS.OPENCODE_CLI,
  HARNESS_IDS.QWEN_CLI,
  HARNESS_IDS.GEMINI_CLI,
];

export const CHAT_HARNESSES: HarnessId[] = [HARNESS_IDS.COPILOT_CHAT];

/** Returns the integration category for a harness value, or null for "default". */
export function harnessCategory(value: string): "cli" | "chat" | null {
  if (CLI_HARNESSES.includes(value as HarnessId)) return "cli";
  if (CHAT_HARNESSES.includes(value as HarnessId)) return "chat";
  return null;
}

// The selected harness can never be hidden (canHide enforces this).
// showChatGroup already suppresses the empty Chat section when all items are hidden.
const NON_HIDEABLE: HarnessId[] = [];

/** Convert a CSS max-height prop string ("60vh", "150px") to pixels. */
function parsePropMaxHeight(h: string): number {
  if (h.endsWith("vh")) return (parseFloat(h) / 100) * window.innerHeight;
  return parseFloat(h);
}

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
  <div className="flex items-center gap-1.5 px-2 py-1 select-none">
    <div className="flex-1 h-[2px] bg-widget-border" />
    <span className="text-[9px] font-semibold uppercase tracking-wider text-description-fg whitespace-nowrap leading-none flex-shrink-0">
      {label}
    </span>
    <div className="flex-1 h-[2px] bg-widget-border" />
  </div>
);

// ─── Harness row ──────────────────────────────────────────────────────────────

interface HarnessRowProps {
  harness: HarnessId;
  isSelected: boolean;
  isHidden: boolean;
  showStatus: boolean;
  narrow: boolean;
  harnessStatus?: Record<
    string,
    { status: HarnessStatusString; available?: boolean }
  >;
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
  const isChecking = status?.status === HARNESS_STATUS_STRINGS.CHECKING;
  const name = HARNESS_DISPLAY_NAMES[harness] ?? harness;

  if (isHidden) {
    // Dimmed, italic, eye-open on the left to restore
    return (
      <div className="group flex items-center opacity-60 italic hover:bg-list-hover-bg cursor-pointer">
        <button
          type="button"
          title="Unhide this harness"
          aria-label="Unhide this harness"
          onClick={(e) => {
            e.stopPropagation();
            onUnhide?.(harness);
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            onUnhide?.(harness);
          }}
          className="flex-shrink-0 px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent"
        >
          <i className="codicon codicon-eye text-[11px]" />
        </button>
        <button
          type="button"
          onClick={() => onSelect(harness)}
          onTouchEnd={(e) => {
            e.preventDefault();
            onSelect(harness);
          }}
          className="flex-1 min-w-0 pr-2 py-1.5 text-xs text-left text-description-fg focus:outline-none border-none bg-transparent cursor-pointer flex items-center gap-1.5"
        >
          <HarnessIcon harnessId={harness} size={13} />
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
        onClick={() =>
          isAvailable || isChecking ? onSelect(harness) : undefined
        }
        onTouchEnd={(e) => {
          if (isAvailable || isChecking) {
            e.preventDefault();
            onSelect(harness);
          }
        }}
        disabled={!isAvailable && !isChecking}
        className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left focus:outline-none border-none bg-transparent disabled:cursor-not-allowed cursor-inherit flex items-center gap-1.5"
      >
        <HarnessIcon harnessId={harness} size={13} />
        {name}
      </button>
      {/* Eye-closed — hover-only, left of status dot, never on selected or non-hideable */}
      {canHideRow && (
        <button
          type="button"
          title="Hide this harness"
          aria-label="Hide this harness"
          onClick={(e) => {
            e.stopPropagation();
            onHide?.(harness);
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
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
  /** Label for the "Default" sentinel option. Defaults to "Default". */
  defaultLabel?: string;
  /** Show availability status dots. Default true. Pass false in PropertiesDrawer. */
  showStatus?: boolean;
  /** Required when showStatus is true. */
  harnessStatus?: Record<
    string,
    { status: HarnessStatusString; available?: boolean }
  >;
  hiddenValues?: string[];
  onHideOption?: (value: string) => void;
  onUnhideOption?: (value: string) => void;
  /** Max height of the open dropdown panel. Defaults to "60vh". */
  dropdownMaxHeight?: string;
  /** When true, renders the list inline without a trigger button. Used in FooterQuickPicker. */
  inline?: boolean;
}

export const HarnessDropdown: React.FC<HarnessDropdownProps> = ({
  id,
  value,
  onChange,
  showDefault = false,
  defaultLabel,
  showStatus = true,
  harnessStatus,
  hiddenValues = [],
  onHideOption,
  onUnhideOption,
  dropdownMaxHeight = "60vh",
  inline = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [narrowRef, isNarrow] = useElementNarrow<HTMLDivElement>(160);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

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
        setShowHidden(false);
      }
    };
    if (!inline && isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, inline]);

  const handleSelect = (harnessId: string) => {
    onChange(harnessId);
    setIsOpen(false);
    setShowHidden(false);
  };

  // ── Hide helpers ──────────────────────────────────────────────────────────
  const isHiddenValue = (h: HarnessId) => hiddenValues.includes(h);

  const canHide = (h: HarnessId) =>
    !NON_HIDEABLE.includes(h) &&
    h !== (value as HarnessId) && // never hide the selected item
    !isHiddenValue(h);

  const totalHidden = [...CLI_HARNESSES, ...CHAT_HARNESSES].filter(
    isHiddenValue
  ).length;

  // Hide a group header when every item in that group is hidden and we're not
  // in "show hidden" mode — an empty section is visually confusing.
  const showCliGroup = !CLI_HARNESSES.every(isHiddenValue) || showHidden;
  const showChatGroup = !CHAT_HARNESSES.every(isHiddenValue) || showHidden;

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

  // ── Shared parts ─────────────────────────────────────────────────────────
  const scrollableList = (
    <div className="overflow-y-auto min-h-0 flex-1">
      {/* "Default" sentinel (PropertiesDrawer / FooterQuickPicker) */}
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
            onTouchEnd={(e) => {
              e.preventDefault();
              handleSelect("default");
            }}
            className="flex-1 px-2 py-1.5 text-xs text-left focus:outline-none border-none bg-transparent cursor-inherit"
          >
            {defaultLabel ?? "Default"}
          </button>
        </div>
      )}

      {/* ── CLI group ── */}
      {showCliGroup && (
        <>
          <GroupHeader label="CLI" />
          {renderGroup(CLI_HARNESSES)}
        </>
      )}

      {/* ── VS Code Chat group ── */}
      {showChatGroup && (
        <>
          <GroupHeader label="VS Code Chat" />
          {renderGroup(CHAT_HARNESSES)}
        </>
      )}
    </div>
  );

  const toggleBar = (atTop: boolean) => (
    <div
      className={`${atTop ? "border-b" : "border-t"} border-dropdown-border bg-editor-bg flex-shrink-0`}
    >
      <button
        type="button"
        disabled={totalHidden === 0}
        onClick={() => setShowHidden((s) => !s)}
        onTouchEnd={(e) => {
          e.preventDefault();
          setShowHidden((s) => !s);
        }}
        className="w-full px-2 py-1.5 text-xs text-center text-description-fg disabled:opacity-40 hover:enabled:bg-list-hover-bg focus:outline-none border-none bg-transparent transition-colors"
      >
        {showHidden
          ? "Hide hidden"
          : totalHidden > 0
            ? `Show hidden (${totalHidden})`
            : "Show hidden"}
      </button>
    </div>
  );

  // ── Inline mode (FooterQuickPicker — drop-up, toggle bar at top) ──────────
  if (inline) {
    return (
      <div ref={narrowRef} className="flex flex-col flex-1 min-h-0">
        {toggleBar(true)}
        {scrollableList}
      </div>
    );
  }

  // ── Trigger + dropdown mode ───────────────────────────────────────────────
  const triggerLabel =
    value === "default"
      ? (defaultLabel ?? "Default")
      : (HARNESS_DISPLAY_NAMES[value as HarnessId] ?? value);

  const triggerStatus =
    showStatus && value !== "default" && harnessStatus
      ? harnessStatus[value as HarnessId]
      : undefined;

  return (
    <div className="relative inline-block w-full" ref={narrowRef}>
      {/* Trigger button */}
      <button
        ref={buttonRef}
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
            {popupPos.bottom !== undefined && toggleBar(true)}
            {scrollableList}
            {popupPos.top !== undefined && toggleBar(false)}
          </div>,
          document.body
        )}
    </div>
  );
};
