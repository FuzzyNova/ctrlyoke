import React, { useState } from "react";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { PRIOR_CONTEXT_KEYWORDS } from "@root/types/DashboardConstants";
import { CustomSelect } from "../shared/CustomSelect";
import { ScriptConditionEditor, type ScriptConditionValue } from "../shared/ScriptConditionEditor";
import { AnimatedSection } from "../shared/AnimatedSection";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-focus-border cursor-pointer shrink-0"
      />
      <span className="flex flex-col">
        <span className="text-sm text-foreground">{label}</span>
        {description && (
          <span className="text-xs text-description-fg mt-0.5">{description}</span>
        )}
      </span>
    </label>
  );
}

interface FieldRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

function FieldRow({ label, description, children }: FieldRowProps) {
  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col min-w-0">
          <span className="text-sm text-foreground">{label}</span>
          {description && (
            <span className="text-xs text-description-fg mt-0.5">{description}</span>
          )}
        </span>
        <div className="shrink-0 w-40">{children}</div>
      </div>
    </div>
  );
}

const FORMAT_OPTIONS = [
  { value: "yaml", label: "YAML" },
  { value: "json", label: "JSON" },
];

const PRIOR_CONTEXT_OPTIONS = [
  { value: PRIOR_CONTEXT_KEYWORDS.NONE, label: "None" },
  { value: PRIOR_CONTEXT_KEYWORDS.ALL, label: "All" },
  { value: PRIOR_CONTEXT_KEYWORDS.PREVIOUS, label: "Previous" },
  { value: PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL, label: "Final Step (All)" },
  { value: PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS, label: "Final Step (Previous)" },
];

export function WorkflowDefaultsSection({ settings, onUpdate }: Props) {
  const wf = settings.settings.workflow;
  const s = "user" as const;

  const [preConditionEnabled, setPreConditionEnabled] = useState(
    wf.defaultPreCondition !== null && wf.defaultPreCondition !== undefined
  );
  const [endConditionEnabled, setEndConditionEnabled] = useState(
    wf.defaultEndCondition !== null && wf.defaultEndCondition !== undefined
  );

  function handlePreConditionToggle(enabled: boolean) {
    setPreConditionEnabled(enabled);
    if (!enabled) {
      onUpdate("workflow.defaultPreCondition", null, s);
    } else {
      const initial = wf.defaultPreCondition ?? { script: "", onFail: "skipPrompt" };
      onUpdate("workflow.defaultPreCondition", initial, s);
    }
  }

  function handleEndConditionToggle(enabled: boolean) {
    setEndConditionEnabled(enabled);
    if (!enabled) {
      onUpdate("workflow.defaultEndCondition", null, s);
    } else {
      const initial = wf.defaultEndCondition ?? { script: "", returns: "true" };
      onUpdate("workflow.defaultEndCondition", initial, s);
    }
  }

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Workflow Defaults
      </h3>
      <FieldRow label="Default format" description="File format for new workflows.">
        <CustomSelect
          value={wf.defaultFormat}
          onChange={(v) => onUpdate("workflow.defaultFormat", v, s)}
          options={FORMAT_OPTIONS}
        />
      </FieldRow>
      <FieldRow label="Default template" description="Template ID used when creating new workflows.">
        <input
          type="text"
          value={wf.defaultTemplate}
          onChange={(e) => onUpdate("workflow.defaultTemplate", e.target.value, s)}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </FieldRow>
      <FieldRow label="Default agent" description="Agent to use when none is specified in the workflow.">
        <input
          type="text"
          value={wf.defaultAgent}
          onChange={(e) => onUpdate("workflow.defaultAgent", e.target.value, s)}
          placeholder="None"
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </FieldRow>
      <FieldRow label="Default prior context" description="How to handle prior context between prompts.">
        <CustomSelect
          value={wf.priorContext || PRIOR_CONTEXT_KEYWORDS.NONE}
          onChange={(v) => onUpdate("workflow.priorContext", v, s)}
          options={PRIOR_CONTEXT_OPTIONS}
        />
      </FieldRow>
      <div className="pt-2 space-y-1">
        <ToggleRow
          label="Resume existing session"
          description="Attempt to resume the most recent AI session."
          checked={wf.resumeExistingSession}
          onChange={(v) => onUpdate("workflow.resumeExistingSession", v, s)}
        />
        <ToggleRow
          label="Auto-load recent session"
          description="Automatically load the most recently used workflow on startup."
          checked={wf.autoLoadRecentSession}
          onChange={(v) => onUpdate("workflow.autoLoadRecentSession", v, s)}
        />
        <ToggleRow
          label="Omit agents & skills on resume"
          description="When resuming a session, do not re-apply agents or skills."
          checked={wf.omitAgentsSkillsOnResume}
          onChange={(v) => onUpdate("workflow.omitAgentsSkillsOnResume", v, s)}
        />
      </div>

      {/* Default Pre-Condition */}
      <div className="pt-4 border-t border-panel-border">
        <label
          className="flex items-center gap-2 text-xs font-semibold uppercase text-description-fg cursor-pointer mb-1"
          title="Default pre-condition gate applied to all new workflows. Individual prompts can override or disable this."
        >
          <input
            type="checkbox"
            checked={preConditionEnabled}
            onChange={(e) => handlePreConditionToggle(e.target.checked)}
            className="w-4 h-4 accent-focus-border cursor-pointer"
          />
          Default Pre-Condition
        </label>
        <p className="text-xs text-description-fg mb-2">
          Script gate that runs before each prompt in new workflows. Prompts can override or disable it.
        </p>
        <AnimatedSection visible={preConditionEnabled}>
          <ScriptConditionEditor
            variant="preCondition"
            value={(wf.defaultPreCondition ?? null) as ScriptConditionValue | null}
            onChange={(updated) => onUpdate("workflow.defaultPreCondition", updated, s)}
            idPrefix="global-default-pre"
          />
        </AnimatedSection>
      </div>

      {/* Default End Condition */}
      <div className="pt-4 border-t border-panel-border">
        <label
          className="flex items-center gap-2 text-xs font-semibold uppercase text-description-fg cursor-pointer mb-1"
          title="Default end condition applied to all new workflows. Individual prompts can override or disable this."
        >
          <input
            type="checkbox"
            checked={endConditionEnabled}
            onChange={(e) => handleEndConditionToggle(e.target.checked)}
            className="w-4 h-4 accent-focus-border cursor-pointer"
          />
          Default End Condition
        </label>
        <p className="text-xs text-description-fg mb-2">
          Validation that runs after each prompt in new workflows. Prompts can override or disable it.
        </p>
        <AnimatedSection visible={endConditionEnabled}>
          <ScriptConditionEditor
            variant="endCondition"
            value={(wf.defaultEndCondition ?? null) as ScriptConditionValue | null}
            onChange={(updated) => onUpdate("workflow.defaultEndCondition", updated, s)}
            idPrefix="global-default-end"
          />
        </AnimatedSection>
      </div>
    </div>
  );
}
