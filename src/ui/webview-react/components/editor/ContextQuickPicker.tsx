import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { SESSION_ID_SENTINELS } from "../../types/messages";
import { FOOTER_PICKERS } from "../../types/messages";
import {
  getResumeSessionOptions,
  resumeSessionSelection,
} from "../../types/dropdownNamespaces";
import { CustomSelect } from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";

interface ContextQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
}

export const ContextQuickPicker: React.FC<ContextQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
}) => {
  const { properties, setProperty } = useEditorStore();
  const { globalSettings, workflowProperties } = useSettingsStore();
  const { footerOpenPicker, setFooterOpenPicker } = useUiStore();

  const isOpen = footerOpenPicker === FOOTER_PICKERS.CONTEXT;
  const isOverride = properties.resumeSession !== undefined;

  // ── valueLabel builder ────────────────────────────────────────────────────
  const effectiveResume =
    properties.resumeSession !== undefined
      ? properties.resumeSession
      : (workflowProperties.resumeSession ?? globalSettings.resumeSession);

  const effectiveSessionId =
    properties.resumeSession !== undefined
      ? properties.sessionId
      : workflowProperties.sessionId;

  const effectiveIsFinal =
    effectiveSessionId === SESSION_ID_SENTINELS.FINAL_STEP;

  const valueLabel = effectiveResume
    ? effectiveIsFinal
      ? "final"
      : "resume"
    : "new";

  // ── Resume Session dropdown state ─────────────────────────────────────────
  const resolvedResumeSession =
    workflowProperties.resumeSession ?? globalSettings.resumeSession;
  const resolvedSessionId = workflowProperties.sessionId;
  const defaultResumeSessionLabel =
    resolvedResumeSession &&
    resolvedSessionId === SESSION_ID_SENTINELS.FINAL_STEP
      ? "Inherit (Final Step Session)"
      : `Inherit (${resolvedResumeSession ? "Yes" : "No"})`;

  const resumeSessionValue =
    properties.resumeSession === undefined
      ? "default"
      : properties.sessionId === SESSION_ID_SENTINELS.FINAL_STEP &&
          properties.resumeSession
        ? SESSION_ID_SENTINELS.FINAL_STEP
        : properties.resumeSession
          ? "yes"
          : "no";

  const handleResumeSessionChange = (v: string) => {
    const next = resumeSessionSelection(v, properties.sessionId);
    setProperty("resumeSession", next.resumeSession);
    setProperty("sessionId", next.sessionId);

    setFooterOpenPicker(v === "yes" ? "context" : null);
  };

  // ── Session ID input ──────────────────────────────────────────────────────
  const isSessionIdActive =
    properties.resumeSession === true &&
    properties.sessionId !== SESSION_ID_SENTINELS.FINAL_STEP;

  const isSessionIdDefault = properties.resumeSession === undefined;
  const sessionIdDisplayValue = isSessionIdActive
    ? (properties.sessionId ?? "")
    : isSessionIdDefault &&
        resolvedResumeSession &&
        resolvedSessionId !== SESSION_ID_SENTINELS.FINAL_STEP
      ? (resolvedSessionId ?? "")
      : "";

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel}
      icon={
        <i
          className={`codicon codicon-book codicon-sm transition-opacity ${isOverride ? "text-focus-border" : "opacity-40"}`}
        />
      }
      valueLabel={valueLabel}
      isOverride={isOverride}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "context")}
      onClose={() => setFooterOpenPicker(null)}
      title="Context override"
      heading="Context"
      popupMinWidth="260px"
      disabled={disabled}
    >
      <div className="flex flex-col gap-3 p-3">
        {/* Resume Session section */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xxs uppercase tracking-wide text-description-fg font-medium">
            Resume Session
          </span>
          <CustomSelect
            value={resumeSessionValue}
            onChange={handleResumeSessionChange}
            options={[...getResumeSessionOptions(defaultResumeSessionLabel)]}
            dropdownMaxHeight="200px"
            inline={true}
          />
          {/* Session ID input — always visible, grayed when not applicable */}
          <div
            className={
              isSessionIdActive ? "" : "opacity-50 pointer-events-none"
            }
          >
            <input
              type="text"
              aria-label="Session ID"
              value={sessionIdDisplayValue}
              onChange={(e) => setProperty("sessionId", e.target.value)}
              disabled={!isSessionIdActive}
              placeholder="Session ID (e.g. 1)"
              className="w-full px-2 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border h-7"
            />
          </div>
        </div>
      </div>
    </FooterQuickPicker>
  );
};
