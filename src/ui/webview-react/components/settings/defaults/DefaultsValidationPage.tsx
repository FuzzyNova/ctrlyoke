import { useState } from "react";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import {
  AnimatedSection,
  ErrorBehaviorEditor,
  ScriptConditionEditor,
  type ScriptConditionValue,
} from "../../shared";
import { SettingSourceBadge } from "../../shared/SettingSourceBadge";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

function ObjectSettingHeader({
  path,
  label,
  sources,
  activeScope,
  onReset,
}: {
  path: string;
  label: string;
  sources: Record<string, SettingSource>;
  activeScope: SettingWriteScope;
  onReset: (path: string) => void;
}) {
  const source = sources[path];
  const canReset =
    source !== undefined && source !== "default" && source === activeScope;

  return (
    <div className="flex items-center gap-1.5">
      <span>{label}</span>
      {source && source !== "default" && <SettingSourceBadge source={source} />}
      <button
        type="button"
        aria-label={`Reset ${label}`}
        onClick={() => {
          if (canReset) onReset(path);
        }}
        disabled={!canReset}
        title={
          canReset
            ? "Reset to default"
            : source
              ? `Defined in ${source} config`
              : undefined
        }
        className={`w-4 h-4 flex items-center justify-center rounded text-description-fg hover:text-foreground transition-opacity ${
          canReset
            ? "opacity-0 group-hover:opacity-100"
            : "opacity-0 pointer-events-none"
        }`}
      >
        <i className="codicon codicon-discard text-xxs" />
      </button>
    </div>
  );
}

export function DefaultsValidationPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const wf = settings.settings.defaults;

  const [preConditionEnabled, setPreConditionEnabled] = useState(
    wf.preCondition !== null && wf.preCondition !== undefined
  );
  const [endConditionEnabled, setEndConditionEnabled] = useState(
    wf.endCondition !== null && wf.endCondition !== undefined
  );

  function handlePreConditionToggle(enabled: boolean) {
    setPreConditionEnabled(enabled);
    if (!enabled) {
      onUpdate("defaults.preCondition", null);
    } else {
      const initial = wf.preCondition ?? { script: "", onFail: "skipPrompt" };
      onUpdate("defaults.preCondition", initial);
    }
  }

  function handleEndConditionToggle(enabled: boolean) {
    setEndConditionEnabled(enabled);
    if (!enabled) {
      onUpdate("defaults.endCondition", null);
    } else {
      const initial = wf.endCondition ?? { script: "", returns: "true" };
      onUpdate("defaults.endCondition", initial);
    }
  }

  return (
    <div className="space-y-4">
      <div className="border border-panel-border rounded p-3 group">
        <div
          className="flex items-center gap-2 text-xs font-semibold uppercase text-description-fg mb-1"
          title="Default harness failure policy applied to all new workflows."
        >
          <ObjectSettingHeader
            path="defaults.errorBehavior"
            label="Default Error Behavior"
            sources={sources}
            activeScope={activeScope}
            onReset={onReset}
          />
        </div>
        <p className="text-xs text-description-fg mb-3">
          Controls what new workflows do when the harness fails. Individual
          workflows and prompts can override or disable it.
        </p>
        <ErrorBehaviorEditor
          value={wf.errorBehavior}
          onChange={(updated) => onUpdate("defaults.errorBehavior", updated)}
          idPrefix="global-default-error"
        />
      </div>

      {/* Default Pre-Condition */}
      <div className="border border-panel-border rounded p-3 group">
        <div
          className="flex items-center gap-2 text-xs font-semibold uppercase text-description-fg mb-1"
          title="Default pre-condition gate applied to all new workflows."
        >
          <input
            type="checkbox"
            checked={preConditionEnabled}
            onChange={(e) => handlePreConditionToggle(e.target.checked)}
            className="w-4 h-4 accent-focus-border cursor-pointer"
          />
          <ObjectSettingHeader
            path="defaults.preCondition"
            label="Default Pre-Condition"
            sources={sources}
            activeScope={activeScope}
            onReset={onReset}
          />
        </div>
        <p className="text-xs text-description-fg mb-2">
          Script gate that runs before each prompt. Prompts can override or
          disable it.
        </p>
        <AnimatedSection visible={preConditionEnabled}>
          <ScriptConditionEditor
            variant="preCondition"
            value={(wf.preCondition ?? null) as ScriptConditionValue | null}
            onChange={(updated) => onUpdate("defaults.preCondition", updated)}
            idPrefix="global-default-pre"
          />
        </AnimatedSection>
      </div>

      {/* Default End Condition */}
      <div className="border border-panel-border rounded p-3 group">
        <div
          className="flex items-center gap-2 text-xs font-semibold uppercase text-description-fg mb-1"
          title="Default end condition applied to all new workflows."
        >
          <input
            type="checkbox"
            checked={endConditionEnabled}
            onChange={(e) => handleEndConditionToggle(e.target.checked)}
            className="w-4 h-4 accent-focus-border cursor-pointer"
          />
          <ObjectSettingHeader
            path="defaults.endCondition"
            label="Default End Condition"
            sources={sources}
            activeScope={activeScope}
            onReset={onReset}
          />
        </div>
        <p className="text-xs text-description-fg mb-2">
          Validation that runs after each prompt. Prompts can override or
          disable it.
        </p>
        <AnimatedSection visible={endConditionEnabled}>
          <ScriptConditionEditor
            variant="endCondition"
            value={(wf.endCondition ?? null) as ScriptConditionValue | null}
            onChange={(updated) => onUpdate("defaults.endCondition", updated)}
            idPrefix="global-default-end"
          />
        </AnimatedSection>
      </div>
    </div>
  );
}
