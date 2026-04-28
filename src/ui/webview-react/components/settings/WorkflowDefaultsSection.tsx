import React, { useState } from "react";
import type {
  FullGlobalSettings,
  SettingSource,
} from "@root/types/WebviewMessageTypes";
import { PRIOR_CONTEXT_KEYWORDS } from "@root/types/DashboardConstants";
import { CustomSelect } from "../shared/CustomSelect";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import {
  ScriptConditionEditor,
  type ScriptConditionValue,
} from "../shared/ScriptConditionEditor";
import { AnimatedSection } from "../shared/AnimatedSection";

interface Props {
  settings: FullGlobalSettings;
  activeScope: "workspace" | "user";
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
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
            <span className="text-xs text-description-fg mt-0.5">
              {description}
            </span>
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
  {
    value: PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS,
    label: "Final Step (Previous)",
  },
];

export function WorkflowDefaultsSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const wf = settings.settings.workflow;
  const sources = settings.sources as Record<string, SettingSource>;

  const rowProps = { sources, onReset, activeScope };

  const [preConditionEnabled, setPreConditionEnabled] = useState(
    wf.defaultPreCondition !== null && wf.defaultPreCondition !== undefined
  );
  const [endConditionEnabled, setEndConditionEnabled] = useState(
    wf.defaultEndCondition !== null && wf.defaultEndCondition !== undefined
  );

  function handlePreConditionToggle(enabled: boolean) {
    setPreConditionEnabled(enabled);
    if (!enabled) {
      onUpdate("workflow.defaultPreCondition", null);
    } else {
      const initial = wf.defaultPreCondition ?? {
        script: "",
        onFail: "skipPrompt",
      };
      onUpdate("workflow.defaultPreCondition", initial);
    }
  }

  function handleEndConditionToggle(enabled: boolean) {
    setEndConditionEnabled(enabled);
    if (!enabled) {
      onUpdate("workflow.defaultEndCondition", null);
    } else {
      const initial = wf.defaultEndCondition ?? { script: "", returns: "true" };
      onUpdate("workflow.defaultEndCondition", initial);
    }
  }

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Workflow Defaults
      </h3>
      <FieldRow
        label="Default format"
        description="File format for new workflows."
      >
        <CustomSelect
          value={wf.defaultFormat}
          onChange={(v) => onUpdate("workflow.defaultFormat", v)}
          options={FORMAT_OPTIONS}
        />
      </FieldRow>
      <FieldRow
        label="Default template"
        description="Template ID used when creating new workflows."
      >
        <input
          type="text"
          value={wf.defaultTemplate}
          onChange={(e) => onUpdate("workflow.defaultTemplate", e.target.value)}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </FieldRow>
      <FieldRow
        label="Default agent"
        description="Agent to use when none is specified in the workflow."
      >
        <input
          type="text"
          value={wf.defaultAgent}
          onChange={(e) => onUpdate("workflow.defaultAgent", e.target.value)}
          placeholder="None"
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </FieldRow>
      <FieldRow
        label="Default prior context"
        description="How to handle prior context between prompts."
      >
        <CustomSelect
          value={wf.priorContext || PRIOR_CONTEXT_KEYWORDS.NONE}
          onChange={(v) => onUpdate("workflow.priorContext", v)}
          options={PRIOR_CONTEXT_OPTIONS}
        />
      </FieldRow>
      <div className="pt-2 space-y-1">
        <SettingToggleRow
          label="Resume existing session"
          description="Attempt to resume the most recent AI session."
          checked={wf.resumeExistingSession}
          onChange={(v) => onUpdate("workflow.resumeExistingSession", v)}
          path="workflow.resumeExistingSession"
          {...rowProps}
        />
        <SettingToggleRow
          label="Auto-load recent session"
          description="Automatically load the most recently used workflow on startup."
          checked={wf.autoLoadRecentSession}
          onChange={(v) => onUpdate("workflow.autoLoadRecentSession", v)}
          path="workflow.autoLoadRecentSession"
          {...rowProps}
        />
        <SettingToggleRow
          label="Omit agents & skills on resume"
          description="When resuming a session, do not re-apply agents or skills."
          checked={wf.omitAgentsSkillsOnResume}
          onChange={(v) => onUpdate("workflow.omitAgentsSkillsOnResume", v)}
          path="workflow.omitAgentsSkillsOnResume"
          {...rowProps}
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
          Script gate that runs before each prompt in new workflows. Prompts can
          override or disable it.
        </p>
        <AnimatedSection visible={preConditionEnabled}>
          <ScriptConditionEditor
            variant="preCondition"
            value={
              (wf.defaultPreCondition ?? null) as ScriptConditionValue | null
            }
            onChange={(updated) =>
              onUpdate("workflow.defaultPreCondition", updated)
            }
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
          Validation that runs after each prompt in new workflows. Prompts can
          override or disable it.
        </p>
        <AnimatedSection visible={endConditionEnabled}>
          <ScriptConditionEditor
            variant="endCondition"
            value={
              (wf.defaultEndCondition ?? null) as ScriptConditionValue | null
            }
            onChange={(updated) =>
              onUpdate("workflow.defaultEndCondition", updated)
            }
            idPrefix="global-default-end"
          />
        </AnimatedSection>
      </div>
    </div>
  );
}
