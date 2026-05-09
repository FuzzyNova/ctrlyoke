import { useState } from "react";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { PRIOR_CONTEXT_KEYWORDS } from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { CustomSelect } from "../shared/CustomSelect";
import { MultiCheckboxDropdown } from "../shared/MultiCheckboxDropdown";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import {
  ScriptConditionEditor,
  type ScriptConditionValue,
} from "../shared/ScriptConditionEditor";
import { AnimatedSection } from "../shared/AnimatedSection";
import { SettingSourceBadge } from "../shared/SettingSourceBadge";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
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
  const availableSkills = useSettingsStore((s) => s.availableSkills);

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

  function renderObjectSettingHeader(path: string, label: string) {
    const source = sources[path];
    const canReset =
      source !== undefined && source !== "default" && source === activeScope;

    return (
      <div className="flex items-center gap-1.5">
        <span>{label}</span>
        {source && source !== "default" && (
          <SettingSourceBadge source={source} />
        )}
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

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Workflow Defaults
      </h3>
      <SettingInputRow
        label="Default format"
        description="File format for new workflows."
        id="workflow-default-format"
        path="workflow.defaultFormat"
        {...rowProps}
      >
        <CustomSelect
          id="workflow-default-format"
          value={wf.defaultFormat}
          onChange={(v) => onUpdate("workflow.defaultFormat", v)}
          options={FORMAT_OPTIONS}
        />
      </SettingInputRow>
      <SettingInputRow
        label="Default template"
        description="Template ID used when creating new workflows."
        id="workflow-default-template"
        path="workflow.defaultTemplate"
        {...rowProps}
      >
        <input
          id="workflow-default-template"
          type="text"
          value={wf.defaultTemplate}
          onChange={(e) => onUpdate("workflow.defaultTemplate", e.target.value)}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Default agent"
        description="Agent to use when none is specified in the workflow."
        id="workflow-default-agent"
        path="workflow.defaultAgent"
        {...rowProps}
      >
        <input
          id="workflow-default-agent"
          type="text"
          value={wf.defaultAgent}
          onChange={(e) => onUpdate("workflow.defaultAgent", e.target.value)}
          placeholder="None"
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Default skills"
        description="Skills to include in new workflows by default."
        id="workflow-default-skills"
        path="workflow.defaultSkills"
        {...rowProps}
      >
        <MultiCheckboxDropdown
          id="workflow-default-skills"
          selectedValues={wf.defaultSkills}
          onChange={(values) => onUpdate("workflow.defaultSkills", values)}
          options={availableSkills.map((skill) => ({
            value: skill.name,
            label: skill.name,
            description: skill.description,
          }))}
          placeholder="No skills selected"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Default prior context"
        description="How to handle prior context between prompts."
        id="workflow-default-prior-context"
        path="workflow.priorContext"
        {...rowProps}
      >
        <CustomSelect
          id="workflow-default-prior-context"
          value={wf.priorContext || PRIOR_CONTEXT_KEYWORDS.NONE}
          onChange={(v) => onUpdate("workflow.priorContext", v)}
          options={PRIOR_CONTEXT_OPTIONS}
        />
      </SettingInputRow>
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
      <div className="pt-4 border-t border-panel-border group">
        <div
          className="flex items-center gap-2 text-xs font-semibold uppercase text-description-fg mb-1"
          title="Default pre-condition gate applied to all new workflows. Individual prompts can override or disable this."
        >
          <input
            type="checkbox"
            checked={preConditionEnabled}
            onChange={(e) => handlePreConditionToggle(e.target.checked)}
            className="w-4 h-4 accent-focus-border cursor-pointer"
          />
          {renderObjectSettingHeader(
            "workflow.defaultPreCondition",
            "Default Pre-Condition"
          )}
        </div>
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
      <div className="pt-4 border-t border-panel-border group">
        <div
          className="flex items-center gap-2 text-xs font-semibold uppercase text-description-fg mb-1"
          title="Default end condition applied to all new workflows. Individual prompts can override or disable this."
        >
          <input
            type="checkbox"
            checked={endConditionEnabled}
            onChange={(e) => handleEndConditionToggle(e.target.checked)}
            className="w-4 h-4 accent-focus-border cursor-pointer"
          />
          {renderObjectSettingHeader(
            "workflow.defaultEndCondition",
            "Default End Condition"
          )}
        </div>
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
