import React, { useId, useState, useRef, useEffect } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { DropdownPortal } from "./DropdownPortal";
import { DropdownHiddenToggle } from "./DropdownHiddenToggle";
import {
  HARNESS_STATUS_STRINGS,
  MESSAGE_TYPES,
  type HarnessId,
  type HarnessStatusString,
} from "../../types/messages";
import {
  HARNESS_DISPLAY_ORDER,
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
  isHarnessVersionOutdated,
  type HarnessAvailabilityStatus,
} from "@utils/harnessUsageDisplay";
import { Icon } from "./Icon";
import {
  schemaAriaLabel,
  schemaOptionTitle,
  schemaTitle,
} from "@utils/schemaPropertyLabels";
import { BULK_MIXED_OPTION } from "@store/editorStore";
import { HARNESS_OPTIONS_META } from "@root/types/SchemaUiMetadata";

// ─── Display names (official product names) ──────────────────────────────────

export const HARNESS_DISPLAY_NAMES: Record<HarnessId, string> =
  Object.fromEntries(
    Object.values(HARNESS_OPTIONS_META).map(({ value, label }) => [
      value,
      label,
    ])
  ) as Record<HarnessId, string>;

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

/** Available, but older than the recommended version. */
const OUTDATED_STATUS_COLOR = "bg-severity-warning";

const StatusIndicator: React.FC<{ status: HarnessAvailabilityStatus }> = ({
  status,
}) => (
  <span
    data-harness-status={
      isHarnessVersionOutdated(status) ? "outdated" : status.status
    }
    className={`w-2 h-2 rounded-full shrink-0 ${
      isHarnessVersionOutdated(status)
        ? OUTDATED_STATUS_COLOR
        : (STATUS_COLORS[status.status] ?? STATUS_COLORS.checking)
    }`}
  />
);

// ─── Harness row ──────────────────────────────────────────────────────────────

interface HarnessRowProps {
  harness: HarnessId;
  schemaPath: string;
  isSelected: boolean;
  isHidden: boolean;
  showStatus: boolean;
  narrow: boolean;
  harnessStatus?: Record<string, HarnessAvailabilityStatus>;
  canHideRow: boolean;
  onSelect: (h: HarnessId) => void;
  onHide?: (h: HarnessId) => void;
  onUnhide?: (h: HarnessId) => void;
}

const HarnessRow: React.FC<HarnessRowProps> = ({
  harness,
  schemaPath,
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
    <span className="inline-flex items-center gap-1 shrink-0">
      {!narrow && usageDisplay.percentOnly && (
        <span className="text-xxs text-description-fg">
          {usageDisplay.percentOnly}
        </span>
      )}
      <StatusIndicator status={status} />
    </span>
  );

  if (isHidden) {
    // Dimmed, italic, eye-open on the left to restore
    return (
      <div
        title={rowTooltip}
        className="group flex items-center opacity-60 italic hover:bg-list-hover-bg cursor-pointer cy-dropdown-row"
      >
        <button
          type="button"
          title="Unhide this harness"
          aria-label="Unhide this harness"
          onClick={(e) => {
            e.stopPropagation();
            onUnhide?.(harness);
          }}
          className="shrink-0 px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-hidden border-none bg-transparent"
        >
          <Icon name="eye" className="text-xs" />
        </button>
        <button
          type="button"
          title={schemaOptionTitle(name, rowTooltip, schemaPath, harness)}
          aria-label={schemaAriaLabel(name, schemaPath, harness)}
          onClick={() => onSelect(harness)}
          className="flex-1 min-w-0 pr-2 py-1.5 text-xs text-left text-description-fg focus:outline-hidden border-none bg-transparent cursor-pointer flex items-center gap-1.5"
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
          ? "bg-dropdown-selected-bg text-list-active-fg cy-dropdown-row-selected"
          : !isAvailable && !isChecking
            ? "opacity-50 cursor-not-allowed"
            : "hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer cy-dropdown-row"
      }`}
    >
      <button
        type="button"
        title={schemaOptionTitle(name, rowTooltip, schemaPath, harness)}
        aria-label={schemaAriaLabel(name, schemaPath, harness)}
        onClick={() =>
          isAvailable || isChecking ? onSelect(harness) : undefined
        }
        disabled={!isAvailable && !isChecking}
        className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left focus:outline-hidden border-none bg-transparent disabled:cursor-not-allowed cursor-inherit flex items-center gap-1.5"
      >
        <HarnessIcon harnessId={harness} size={13} />
        {name}
      </button>
      {usageIndicator}
      <div className="shrink-0 w-4 flex items-center justify-center">
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
            className="p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-foreground focus:outline-hidden border-none bg-transparent transition-opacity"
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
  /** Schema property represented by this harness selector. */
  schemaPath?: string;
  /** Show a "Default" sentinel option above the groups (for per-prompt overrides). */
  showDefault?: boolean;
  /** Label for the "Default" sentinel option. Defaults to "Default". */
  defaultLabel?: string;
  /** Show availability status dots. Default true. Pass false in PropertiesDrawer. */
  showStatus?: boolean;
  /** Required when showStatus is true. */
  harnessStatus?: Record<string, HarnessAvailabilityStatus>;
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
  disabled?: boolean;
}

export const HarnessDropdown: React.FC<HarnessDropdownProps> = ({
  id,
  value,
  onChange,
  triggerAriaLabel,
  triggerTitle,
  schemaPath = "harness",
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
  disabled = false,
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

  const totalHidden = HARNESS_DISPLAY_ORDER.filter(isHiddenValue).length;

  // ── Group renderer ────────────────────────────────────────────────────────
  const renderGroup = (harnesses: readonly HarnessId[]) =>
    harnesses.map((harness) => {
      const hidden = isHiddenValue(harness);
      if (hidden && !showHidden) return null;
      return (
        <HarnessRow
          key={harness}
          harness={harness}
          schemaPath={schemaPath}
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
      {value === BULK_MIXED_OPTION && (
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => handleSelect(BULK_MIXED_OPTION)}
            aria-label="(mixed), harness"
            className="flex-1 px-2 py-1.5 text-xs text-left bg-dropdown-selected-bg"
          >
            (mixed)
          </button>
        </div>
      )}
      {/* "Default" sentinel (PropertiesDrawer / FooterQuickPicker) */}
      {showDefault && (
        <div
          className={`flex items-center ${
            value === INHERIT_DEFAULT_OPTION
              ? "bg-dropdown-selected-bg text-list-active-fg cy-dropdown-row-selected"
              : "hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer cy-dropdown-row"
          }`}
        >
          <button
            type="button"
            onClick={() => handleSelect(INHERIT_DEFAULT_OPTION)}
            aria-label={schemaAriaLabel(defaultLabel ?? "Inherit", schemaPath, {
              omit: true,
            })}
            title={schemaOptionTitle(
              defaultLabel ?? "Inherit",
              undefined,
              schemaPath,
              { omit: true }
            )}
            className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left focus:outline-hidden border-none bg-transparent cursor-inherit flex items-center"
          >
            {defaultSentinelContent}
          </button>
        </div>
      )}

      {renderGroup(HARNESS_DISPLAY_ORDER)}
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
    value === BULK_MIXED_OPTION
      ? "(mixed)"
      : value === INHERIT_DEFAULT_OPTION
        ? (defaultLabel ?? "Default")
        : (HARNESS_DISPLAY_NAMES[value as HarnessId] ?? value);

  const triggerStatus =
    showStatus && value !== INHERIT_DEFAULT_OPTION && harnessStatus
      ? harnessStatus[value as HarnessId]
      : undefined;
  const triggerSchemaValue =
    value === INHERIT_DEFAULT_OPTION || value === BULK_MIXED_OPTION
      ? { omit: true as const }
      : value;
  const triggerStatusHint =
    triggerStatus &&
    (isHarnessVersionOutdated(triggerStatus) ||
      (!triggerStatus.available &&
        triggerStatus.status !== HARNESS_STATUS_STRINGS.CHECKING))
      ? getHarnessAvailabilityPhrase(triggerStatus)
      : undefined;

  return (
    <div className="relative inline-block w-full" ref={narrowRef}>
      {/* Trigger button */}
      <div className="flex items-center gap-1">
        <button
          ref={buttonRef}
          id={id}
          type="button"
          disabled={disabled}
          aria-disabled={disabled}
          onClick={() =>
            setIsOpen((prev) => {
              if (prev) setShowHidden(false);
              return !prev;
            })
          }
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          aria-label={schemaAriaLabel(
            triggerAriaLabel ?? triggerLabel,
            schemaPath,
            triggerSchemaValue
          )}
          title={
            disabled && triggerTitle
              ? triggerTitle
              : schemaTitle(
                  schemaPath,
                  triggerSchemaValue,
                  triggerTitle ?? triggerStatusHint
                )
          }
          className="cy-select-trigger cy-dropdown-row flex-1 min-w-0"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            {value === BULK_MIXED_OPTION ? (
              <span className="truncate">(mixed)</span>
            ) : value === INHERIT_DEFAULT_OPTION ? (
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
            {triggerStatus && <StatusIndicator status={triggerStatus} />}
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
            className="shrink-0 px-1.5 py-1 text-xxs text-description-fg hover:text-foreground focus:outline-hidden border-none bg-transparent disabled:cursor-wait"
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
