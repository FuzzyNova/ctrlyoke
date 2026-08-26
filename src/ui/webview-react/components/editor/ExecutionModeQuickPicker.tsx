import React, { useMemo, useRef } from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { constrainPopupToViewport } from "@utils/dropdownUtils";
import { CustomSelect, DropdownPortal } from "../shared";
import {
  INHERIT_DEFAULT_OPTION,
  FOOTER_PICKERS,
  EXECUTION_MODES,
  EXECUTION_MODE_OPTIONS,
  EXECUTION_MODE_HELP_TEXT,
  type ExecutionMode,
} from "@root/types/DashboardConstants";

const POPUP_MIN_WIDTH = 200;

interface ExecutionModeQuickPickerProps {
  /** When true, button and popup are disabled (CLI watch mode) */
  disabled?: boolean;
}

/**
 * ExecutionModeQuickPicker — header-row control for overriding a step's
 * execution mode (interactive vs. headless), valid for both prompt and
 * script steps.
 *
 * Lives in the EditorSection header (not the EditorFooter) alongside the
 * prompt-file action and git-ignore toggle, so it is styled to match those
 * same-size icon-only `control-button` controls rather than the wider
 * FooterQuickPicker trigger. It reuses the shared dropdown-portal primitives
 * (`useDropdownPortalPosition` + `DropdownPortal` + `useClickOutside`) so the
 * popup opens downward — the header sits at the top of the panel, where the
 * upward-opening FooterQuickPicker popup would render off-screen.
 */
export const ExecutionModeQuickPicker: React.FC<
  ExecutionModeQuickPickerProps
> = ({ disabled = false }) => {
  const { properties, setProperty } = useEditorStore();
  const { getEffectiveExecutionMode } = useSettingsStore();
  const { footerOpenPicker, setFooterOpenPicker } = useUiStore();

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const isOpen = footerOpenPicker === FOOTER_PICKERS.EXECUTION_MODE;
  const isOverride = properties.executionMode !== undefined;

  const resolvedMode = getEffectiveExecutionMode();
  const activeMode = properties.executionMode ?? resolvedMode;
  const iconClass =
    activeMode === EXECUTION_MODES.INTERACTIVE
      ? "codicon-debug-console"
      : "codicon-terminal";

  const resolvedLabel =
    EXECUTION_MODE_OPTIONS.find((o) => o.value === resolvedMode)?.label ??
    resolvedMode;
  const defaultLabel = `Inherit (${resolvedLabel})`;
  const activeLabel = isOverride
    ? (EXECUTION_MODE_OPTIONS.find((o) => o.value === activeMode)?.label ??
      activeMode)
    : defaultLabel;
  const tooltip = isOverride
    ? `Execution mode override: ${activeLabel}\n${EXECUTION_MODE_HELP_TEXT}`
    : `Execution mode: ${activeLabel}\n${EXECUTION_MODE_HELP_TEXT}`;

  const rawPosition = useDropdownPortalPosition(buttonRef, isOpen, "300px");
  const popupPos = useMemo(() => {
    if (!rawPosition) return null;
    const constrained = constrainPopupToViewport({
      left: rawPosition.left,
      minWidth: POPUP_MIN_WIDTH,
      preferredWidth: POPUP_MIN_WIDTH,
    });
    return {
      ...rawPosition,
      left: constrained.left,
      width: undefined,
      minWidth: constrained.minWidth,
      maxWidth: constrained.maxWidth,
    };
  }, [rawPosition]);

  useClickOutside([buttonRef, popupRef], isOpen, () =>
    setFooterOpenPicker(null)
  );

  const toggle = () =>
    setFooterOpenPicker(isOpen ? null : FOOTER_PICKERS.EXECUTION_MODE);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={disabled ? undefined : toggle}
        disabled={disabled}
        title={tooltip}
        aria-label="Execution mode"
        aria-pressed={isOverride}
        className={`control-button flex items-center px-1 bg-transparent border-none cursor-pointer leading-none transition-colors select-none disabled:opacity-50 disabled:cursor-not-allowed ${
          isOverride
            ? "text-widget-highlight-fg hover:text-widget-highlight-fg-hover"
            : "text-description-fg hover:text-foreground"
        }`}
      >
        <i className={`codicon codicon-lg ${iconClass}`} />
      </button>

      {isOpen && !disabled && (
        <DropdownPortal isOpen={isOpen} popupPos={popupPos} ref={popupRef}>
          <div className="flex items-center px-3 py-2 border-b border-dropdown-border bg-editor-bg flex-shrink-0">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
              Execution Mode
            </h3>
          </div>
          <CustomSelect
            value={properties.executionMode ?? INHERIT_DEFAULT_OPTION}
            onChange={(v) => {
              setProperty(
                "executionMode",
                v === INHERIT_DEFAULT_OPTION ? undefined : (v as ExecutionMode)
              );
              setFooterOpenPicker(null);
            }}
            options={[
              { value: INHERIT_DEFAULT_OPTION, label: defaultLabel },
              ...EXECUTION_MODE_OPTIONS,
            ]}
            dropdownMaxHeight="200px"
            inline={true}
          />
        </DropdownPortal>
      )}
    </>
  );
};
