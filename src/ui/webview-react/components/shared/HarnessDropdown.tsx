import React, { useId, useState, useRef, useEffect } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { DropdownPortal } from "./DropdownPortal";
import { DropdownHiddenToggle } from "./DropdownHiddenToggle";
import {
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  MESSAGE_TYPES,
  type HarnessId,
  type HarnessStatusString,
} from "../../types/messages";
import {
  INHERIT_DEFAULT_OPTION,
  USER_FEEDBACK_SEVERITY,
} from "@root/types/DashboardConstants";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { notifyUser } from "@utils/notifyUser";
import { useUiStore } from "@store/uiStore";
import { HarnessIcon } from "./HarnessIcon";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import {
  formatHarnessUsageTooltip,
  getHarnessAvailabilityPhrase,
  getHarnessUsageDisplay,
} from "@utils/harnessUsageDisplay";
import { Icon } from "./Icon";

// ─── Display names (official product names) ──────────────────────────────────

export const HARNESS_DISPLAY_NAMES: Record<HarnessId, string> = {
  [HARNESS_IDS.ANTIGRAVITY_CLI]: "Antigravity",
  [HARNESS_IDS.COPILOT_CLI]: "Copilot CLI",
  [HARNESS_IDS.CLAUDE_CLI]: "Claude Code",
  [HARNESS_IDS.CODEX_CLI]: "Codex",
  [HARNESS_IDS.OPENCODE_CLI]: "OpenCode",
  [HARNESS_IDS.QWEN_CLI]: "Qwen Code",
};

// ─── Harness list ─────────────────────────────────────────────────────────────

export const SUPPORTED_HARNESSES: HarnessId[] = [
  HARNESS_IDS.ANTIGRAVITY_CLI,
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.CODEX_CLI,
  HARNESS_IDS.COPILOT_CLI,
  HARNESS_IDS.OPENCODE_CLI,
  HARNESS_IDS.QWEN_CLI,
];

// The selected harness can never be hidden (canHide enforces this).
const NON_HIDEABLE: HarnessId[] = [];
let retryRequestCounter = 0;

function nextRetryRequestId(): string {
  retryRequestCounter += 1;
  return `harness-detection-retry-${Date.now()}-${retryRequestCounter}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const STATUS_COLORS: Record<HarnessStatusString, string> = {
  checking: "bg-indicator-running animate-pulse",
  available: "bg-indicator-success",
  unavailable: "bg-indicator-error",
};

const StatusIndicator: React.FC<{ status: HarnessStatusString }> = ({
  status,
}) => (
  <span
    className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[status] ?? STATUS_COLORS.checking}`}
  />
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
    {
      status: HarnessStatusString;
      available?: boolean;
      installHint?: string;
    }
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

  const usageSnapshot = useHarnessUsageStore(
    (s) => s.snapshotsByHarness[harness]
  );
  const usageDisplay = getHarnessUsageDisplay(usageSnapshot);
  const availabilityPhrase = getHarnessAvailabilityPhrase(status);
  const rowTooltip = status
    ? formatHarnessUsageTooltip(usageDisplay, availabilityPhrase)
    : undefined;

  const usageIndicator = showStatus && status && (
    <span className="inline-flex items-center gap-1 flex-shrink-0">
      {!narrow && usageDisplay.percentOnly && (
        <span className="text-xxs text-description-fg">
          {usageDisplay.percentOnly}
        </span>
      )}
      <StatusIndicator status={status.status} />
    </span>
  );

  if (isHidden) {
    // Dimmed, italic, eye-open on the left to restore
    return (
      <div
        title={rowTooltip}
        className="group flex items-center opacity-60 italic hover:bg-list-hover-bg cursor-pointer fp-dropdown-row"
      >
        <button
          type="button"
          title="Unhide this harness"
          aria-label="Unhide this harness"
          onClick={(e) => {
            e.stopPropagation();
            onUnhide?.(harness);
          }}
          className="flex-shrink-0 px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent"
        >
          <Icon name="eye" className="text-xs" />
        </button>
        <button
          type="button"
          onClick={() => onSelect(harness)}
          className="flex-1 min-w-0 pr-2 py-1.5 text-xs text-left text-description-fg focus:outline-none border-none bg-transparent cursor-pointer flex items-center gap-1.5"
        >
          <HarnessIcon harnessId={harness} size={13} />
          {name}
        </button>
        {usageIndicator}
      </div>
    );
  }

  return (
    <div
      title={rowTooltip}
      className={`group flex items-center pr-2 gap-1 ${
        isSelected
          ? "bg-dropdown-selected-bg text-list-active-fg fp-dropdown-row-selected"
          : !isAvailable && !isChecking
            ? "opacity-50 cursor-not-allowed"
            : "hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer fp-dropdown-row"
      }`}
    >
      <button
        type="button"
        onClick={() =>
          isAvailable || isChecking ? onSelect(harness) : undefined
        }
        disabled={!isAvailable && !isChecking}
        className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left focus:outline-none border-none bg-transparent disabled:cursor-not-allowed cursor-inherit flex items-center gap-1.5"
      >
        <HarnessIcon harnessId={harness} size={13} />
        {name}
      </button>
      {usageIndicator}
      <div className="flex-shrink-0 w-4 flex items-center justify-center">
        {/* Reserve a right-edge action slot so status text never shifts on hover. */}
        {canHideRow && (
          <button
            type="button"
            title="Hide this harness"
            aria-label="Hide this harness"
            onClick={(e) => {
              e.stopPropagation();
              onHide?.(harness);
            }}
            className="p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent transition-opacity"
          >
            <Icon name="eye-closed" className="text-xs" />
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

export interface HarnessDropdownProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  triggerAriaLabel?: string;
  triggerTitle?: string;
  /** Show a "Default" sentinel option above the groups (for per-prompt overrides). */
  showDefault?: boolean;
  /** Label for the "Default" sentinel option. Defaults to "Default". */
  defaultLabel?: string;
  /** Show availability status dots. Default true. Pass false in PropertiesDrawer. */
  showStatus?: boolean;
  /** Required when showStatus is true. */
  harnessStatus?: Record<
    string,
    {
      status: HarnessStatusString;
      available?: boolean;
      installHint?: string;
    }
  >;
  hiddenValues?: string[];
  onHideOption?: (value: string) => void;
  onUnhideOption?: (value: string) => void;
  /**
   * The harness the "Default"/"Inherit" sentinel resolves to. When set, its
   * icon is shown inline within the sentinel label (both in the trigger and
   * the dropdown row) alongside `defaultLabel`'s text.
   */
  defaultHarnessId?: HarnessId;
  /** Max height of the open dropdown panel. Defaults to "60vh". */
  dropdownMaxHeight?: string;
  /** When true, renders the list inline without a trigger button. Used in FooterQuickPicker. */
  inline?: boolean;
}

export const HarnessDropdown: React.FC<HarnessDropdownProps> = ({
  id,
  value,
  onChange,
  triggerAriaLabel,
  triggerTitle,
  showDefault = false,
  defaultLabel,
  showStatus = true,
  harnessStatus,
  hiddenValues = [],
  onHideOption,
  onUnhideOption,
  defaultHarnessId,
  dropdownMaxHeight = "60vh",
  inline = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const reactId = useId();
  const listboxId = id
    ? `${id}-listbox`
    : `harness-listbox-${reactId.replace(/:/g, "")}`;
  const [showHidden, setShowHidden] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const pendingRetryRequest = useRef<string | null>(null);
  const retryResult = useUiStore((state) => state.harnessDetectionRetryResult);
  const [narrowRef, isNarrow] = useElementNarrow<HTMLDivElement>(180);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const popupPos = useDropdownPortalPosition(
    buttonRef,
    isOpen,
    dropdownMaxHeight
  );
  const triggerUsageSnapshot = useHarnessUsageStore((s) =>
    value !== INHERIT_DEFAULT_OPTION
      ? s.snapshotsByHarness[value as HarnessId]
      : undefined
  );
  const triggerUsageDisplay = getHarnessUsageDisplay(triggerUsageSnapshot);

  useEffect(() => {
    if (!retryResult || retryResult.requestId !== pendingRetryRequest.current) {
      return;
    }

    pendingRetryRequest.current = null;
    setRetrying(false);
    useUiStore.getState().setHarnessDetectionRetryResult(null);
    if (retryResult.success) {
      notifyUser(
        "Harness detection retry completed",
        USER_FEEDBACK_SEVERITY.SUCCESS
      );
    } else {
      notifyUser(
        retryResult.error || "Harness detection retry failed",
        USER_FEEDBACK_SEVERITY.ERROR
      );
    }
  }, [retryResult]);

  const handleRetry = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (retrying) return;

    const requestId = nextRetryRequestId();
    pendingRetryRequest.current = requestId;
    setRetrying(true);
    getVsCodeApi().postMessage({
      type: MESSAGE_TYPES.RETRY_HARNESS_DETECTION,
      requestId,
    });
  };

  useClickOutside(
    [buttonRef, popupRef],
    isOpen,
    () => {
      setIsOpen(false);
      setShowHidden(false);
    },
    !inline
  );

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

  const totalHidden = SUPPORTED_HARNESSES.filter(isHiddenValue).length;

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
  const defaultSentinelContent = defaultHarnessId ? (
    <span className="truncate flex items-center">
      {"Inherit ("}
      <HarnessIcon
        harnessId={defaultHarnessId}
        size={13}
        className="ml-0.5 mr-1"
      />
      {HARNESS_DISPLAY_NAMES[defaultHarnessId] ?? defaultHarnessId}
      {")"}
    </span>
  ) : (
    (defaultLabel ?? "Default")
  );

  const scrollableList = (
    <div className="overflow-y-auto min-h-0 flex-1">
      {/* "Default" sentinel (PropertiesDrawer / FooterQuickPicker) */}
      {showDefault && (
        <div
          className={`flex items-center ${
            value === INHERIT_DEFAULT_OPTION
              ? "bg-dropdown-selected-bg text-list-active-fg fp-dropdown-row-selected"
              : "hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer fp-dropdown-row"
          }`}
        >
          <button
            type="button"
            onClick={() => handleSelect(INHERIT_DEFAULT_OPTION)}
            className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left focus:outline-none border-none bg-transparent cursor-inherit flex items-center"
          >
            {defaultSentinelContent}
          </button>
        </div>
      )}

      {renderGroup(SUPPORTED_HARNESSES)}
    </div>
  );

  const toggleBar = () => (
    <DropdownHiddenToggle
      hiddenCount={totalHidden}
      showHidden={showHidden}
      onToggle={() => setShowHidden((s) => !s)}
    />
  );

  // ── Inline mode (FooterQuickPicker) ───────────────────────────────────────
  if (inline) {
    return (
      <div ref={narrowRef} className="flex flex-col flex-1 min-h-0">
        {scrollableList}
        {toggleBar()}
      </div>
    );
  }

  // ── Trigger + dropdown mode ───────────────────────────────────────────────
  const triggerLabel =
    value === INHERIT_DEFAULT_OPTION
      ? (defaultLabel ?? "Default")
      : (HARNESS_DISPLAY_NAMES[value as HarnessId] ?? value);

  const triggerStatus =
    showStatus && value !== INHERIT_DEFAULT_OPTION && harnessStatus
      ? harnessStatus[value as HarnessId]
      : undefined;

  return (
    <div className="relative inline-block w-full" ref={narrowRef}>
      {/* Trigger button */}
      <div className="flex items-center gap-1">
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
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          aria-label={triggerAriaLabel}
          title={
            triggerTitle ??
            (!triggerStatus?.available &&
            triggerStatus?.status !== HARNESS_STATUS_STRINGS.CHECKING
              ? (triggerStatus?.installHint ?? "Harness is not available")
              : undefined)
          }
          className="fp-select-trigger fp-dropdown-row flex-1 min-w-0"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            {value === INHERIT_DEFAULT_OPTION ? (
              defaultSentinelContent
            ) : (
              <>
                <HarnessIcon harnessId={value as HarnessId} size={13} />
                <span className="truncate">{triggerLabel}</span>
              </>
            )}
          </span>
          <div className="flex items-center gap-1">
            {!isNarrow && triggerUsageDisplay.percentOnly && (
              <span className="text-xxs text-description-fg">
                {triggerUsageDisplay.percentOnly}
              </span>
            )}
            {triggerStatus && <StatusIndicator status={triggerStatus.status} />}
            <Icon
              name={`chevron-${isOpen ? "up" : "down"}`}
              className="text-xxs"
            />
          </div>
        </button>
        {triggerStatus?.status === HARNESS_STATUS_STRINGS.UNAVAILABLE && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            aria-label={
              retrying
                ? "Retrying harness detection"
                : "Retry harness detection"
            }
            title="Retry harness detection"
            className="flex-shrink-0 px-1.5 py-1 text-xxs text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent disabled:cursor-wait"
          >
            {retrying ? (
              <Icon name="loading" className="animate-spin" />
            ) : (
              "Retry"
            )}
          </button>
        )}
      </div>

      <DropdownPortal
        isOpen={isOpen}
        popupPos={popupPos}
        ref={popupRef}
        id={listboxId}
        role="listbox"
      >
        {scrollableList}
        {toggleBar()}
      </DropdownPortal>
    </div>
  );
};
