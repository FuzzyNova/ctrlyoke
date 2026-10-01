import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import {
  WORKTREE_MODE_SELECTIONS,
  WORKTREE_MODES,
} from "@root/types/DashboardConstants";
import type {
  WorktreeConfig,
  WorktreeObjectConfig,
} from "@root/types/CtrlYokeTypes";
import { useSettingsStore } from "@store/settingsStore";
import { agentWarning, skillsWarning } from "@utils/dropdownValidation";
import { CustomSelect } from "../../shared/CustomSelect";
import { toAgentSelectOption } from "../../shared/agentSelectOptions";
import { MultiCheckboxDropdown } from "../../shared/MultiCheckboxDropdown";
import { SettingInputRow } from "../../shared/SettingInputRow";
import { LocalTextInput } from "../../shared/LocalInputs";
import { FieldDiagnostic } from "../../shared/FieldDiagnostic";
import { SecretGrantsEditor } from "../../shared/SecretGrantsEditor";
import {
  EXECUTION_MODE_OPTIONS_META,
  WORKTREE_SELECTION_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { fieldValidationBorderClass } from "@utils/fieldValidation";
import { HarnessesSection } from "../HarnessesSection";
import { worktreeSettingDescription } from "../settingsCatalog";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

function worktreeObjectConfig(
  value: WorktreeConfig
): WorktreeObjectConfig | false {
  if (value === false) return false;
  if (value === true) return { mode: WORKTREE_MODES.MANAGED };
  if (typeof value === "string") {
    return { mode: WORKTREE_MODES.NAMED, branch: value };
  }
  return value;
}

export function DefaultsHarnessPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const wf = settings.settings.defaults;
  const worktreeConfig = worktreeObjectConfig(wf.worktree);
  const worktreeMode =
    worktreeConfig === false
      ? WORKTREE_MODE_SELECTIONS.NONE
      : worktreeConfig.mode;
  const updateWorktreeMode = (mode: string) => {
    const next: WorktreeConfig =
      mode === WORKTREE_MODE_SELECTIONS.NONE
        ? false
        : mode === WORKTREE_MODES.MANAGED
          ? worktreeConfig !== false &&
            worktreeConfig.mode === WORKTREE_MODES.MANAGED
            ? worktreeConfig
            : { mode: WORKTREE_MODES.MANAGED }
          : worktreeConfig !== false &&
              worktreeConfig.mode === WORKTREE_MODES.NAMED
            ? worktreeConfig
            : { mode: WORKTREE_MODES.NAMED, branch: "" };
    onUpdate("defaults.worktree", next);
  };
  const updateWorktreeField = (
    field: "branch" | "base" | "setup" | "keep" | "merge",
    value: string | boolean
  ) => {
    if (worktreeConfig === false) return;
    onUpdate("defaults.worktree", { ...worktreeConfig, [field]: value });
  };
  const availableAgents = useSettingsStore((s) => s.availableAgents);
  const availableSkills = useSettingsStore((s) => s.availableSkills);
  const rowProps = { sources, onReset, activeScope };
  const agentWarn = agentWarning(wf.agent, availableAgents);
  const skillsWarn = skillsWarning(wf.skills, availableSkills);
  const worktreeBranchDiagnostics =
    worktreeMode === WORKTREE_MODES.NAMED &&
    worktreeConfig !== false &&
    "branch" in worktreeConfig &&
    !worktreeConfig.branch?.trim()
      ? [
          {
            severity: "error" as const,
            message: "Branch is required for named worktree mode.",
          },
        ]
      : [];

  return (
    <div className="space-y-4">
      <HarnessesSection
        settings={settings}
        activeScope={activeScope}
        onUpdate={onUpdate}
        onReset={onReset}
      />
      <div className="border-t border-panel-border pt-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Execution Defaults
        </h3>
        <SettingInputRow
          settingKey="defaults.executionMode"
          id="defaults-execution-mode"
          {...rowProps}
        >
          <CustomSelect
            id="defaults-execution-mode"
            value={wf.executionMode}
            onChange={(v) => onUpdate("defaults.executionMode", v)}
            schemaPath="defaults.executionMode"
            options={toSelectOptions(
              EXECUTION_MODE_OPTIONS_META,
              "defaults.executionMode"
            )}
          />
        </SettingInputRow>
      </div>
      <div className="border-t border-panel-border pt-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Worktree Defaults
        </h3>
        <SettingInputRow
          settingKey="defaults.worktree"
          id="defaults-worktree-mode"
          {...rowProps}
        >
          <CustomSelect
            id="defaults-worktree-mode"
            value={worktreeMode}
            onChange={updateWorktreeMode}
            schemaPath="defaults.worktree"
            options={toSelectOptions(
              WORKTREE_SELECTION_OPTIONS_META,
              "defaults.worktree"
            )}
          />
        </SettingInputRow>
        {worktreeMode === WORKTREE_MODES.NAMED && (
          <>
            <SettingInputRow
              settingKey="defaults.worktree.branch"
              id="defaults-worktree-branch"
              {...rowProps}
            >
              <LocalTextInput
                id="defaults-worktree-branch"
                value={
                  worktreeConfig !== false && "branch" in worktreeConfig
                    ? (worktreeConfig.branch ?? "")
                    : ""
                }
                onCommit={(value) => updateWorktreeField("branch", value)}
                className={`w-full px-2 py-1 text-xs bg-input-bg text-input-fg border ${fieldValidationBorderClass(worktreeBranchDiagnostics)} rounded focus:outline-none focus:border-focus-border font-mono h-7`}
              />
              <FieldDiagnostic
                id="defaults-worktree-branch-diagnostic"
                diagnostics={worktreeBranchDiagnostics}
              />
            </SettingInputRow>
            <SettingInputRow
              settingKey="defaults.worktree.base"
              {...{ description: worktreeSettingDescription("named", "base") }}
              id="defaults-worktree-base"
              {...rowProps}
            >
              <LocalTextInput
                id="defaults-worktree-base"
                value={
                  worktreeConfig !== false ? (worktreeConfig.base ?? "") : ""
                }
                onCommit={(value) => updateWorktreeField("base", value)}
                placeholder="Current branch (HEAD)"
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
              />
            </SettingInputRow>
            <SettingInputRow
              settingKey="defaults.worktree.setup"
              {...{ description: worktreeSettingDescription("named", "setup") }}
              id="defaults-worktree-setup"
              {...rowProps}
            >
              <LocalTextInput
                id="defaults-worktree-setup"
                value={
                  worktreeConfig !== false ? (worktreeConfig.setup ?? "") : ""
                }
                onCommit={(value) => updateWorktreeField("setup", value)}
                placeholder="e.g. npm ci"
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
              />
            </SettingInputRow>
          </>
        )}
        {worktreeMode === WORKTREE_MODES.MANAGED && (
          <>
            <SettingInputRow
              settingKey="defaults.worktree.base"
              {...{
                description: worktreeSettingDescription("managed", "base"),
              }}
              id="defaults-worktree-base"
              {...rowProps}
            >
              <LocalTextInput
                id="defaults-worktree-base"
                value={
                  worktreeConfig !== false ? (worktreeConfig.base ?? "") : ""
                }
                onCommit={(value) => updateWorktreeField("base", value)}
                placeholder="Current branch (HEAD)"
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
              />
            </SettingInputRow>
            <SettingInputRow
              settingKey="defaults.worktree.setup"
              {...{
                description: worktreeSettingDescription("managed", "setup"),
              }}
              id="defaults-worktree-setup"
              {...rowProps}
            >
              <LocalTextInput
                id="defaults-worktree-setup"
                value={
                  worktreeConfig !== false ? (worktreeConfig.setup ?? "") : ""
                }
                onCommit={(value) => updateWorktreeField("setup", value)}
                placeholder="e.g. npm ci"
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
              />
            </SettingInputRow>
            <SettingInputRow
              settingKey="defaults.worktree.keep"
              id="defaults-worktree-keep"
              {...rowProps}
            >
              <label className="flex items-center gap-2 min-h-7 text-xs text-foreground">
                <input
                  id="defaults-worktree-keep"
                  type="checkbox"
                  aria-label="Keep directory"
                  checked={
                    worktreeConfig !== false && "keep" in worktreeConfig
                      ? (worktreeConfig.keep ?? false)
                      : false
                  }
                  onChange={(event) =>
                    updateWorktreeField("keep", event.target.checked)
                  }
                  className="accent-button-bg"
                />
                Keep managed worktrees for review and undo
              </label>
            </SettingInputRow>
            <SettingInputRow
              settingKey="defaults.worktree.merge"
              id="defaults-worktree-merge"
              {...rowProps}
            >
              <label className="flex items-center gap-2 min-h-7 text-xs text-foreground">
                <input
                  id="defaults-worktree-merge"
                  type="checkbox"
                  aria-label="Merge"
                  checked={
                    worktreeConfig !== false && "merge" in worktreeConfig
                      ? (worktreeConfig.merge ?? false)
                      : false
                  }
                  onChange={(event) =>
                    updateWorktreeField("merge", event.target.checked)
                  }
                  className="accent-button-bg"
                />
                Merge into the working checkout after every run
              </label>
            </SettingInputRow>
          </>
        )}
      </div>
      <div className="border-t border-panel-border pt-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Agent & Skill Defaults
        </h3>
        <SettingInputRow
          settingKey="defaults.agent"
          id="defaults-agent"
          {...rowProps}
        >
          <CustomSelect
            id="defaults-agent"
            value={wf.agent || ""}
            onChange={(v) => onUpdate("defaults.agent", v)}
            schemaPath="defaults.agent"
            options={[
              { value: "", label: "None" },
              ...availableAgents.map((agent) =>
                toAgentSelectOption(agent, agent.name)
              ),
            ]}
            warning={agentWarn ?? undefined}
          />
        </SettingInputRow>
        <SettingInputRow
          settingKey="defaults.skills"
          id="defaults-skills"
          {...rowProps}
        >
          <MultiCheckboxDropdown
            id="defaults-skills"
            selectedValues={wf.skills}
            onChange={(values) => onUpdate("defaults.skills", values)}
            options={availableSkills.map((skill) => ({
              value: skill.name,
              label: skill.name,
              description: skill.description,
            }))}
            placeholder="No skills selected"
            warning={skillsWarn ?? undefined}
          />
        </SettingInputRow>
        <SettingInputRow
          settingKey="defaults.secrets"
          id="defaults-secrets-control"
          {...rowProps}
        >
          <SecretGrantsEditor
            value={wf.secrets ?? []}
            inheritedValue={[]}
            onChange={(value) => onUpdate("defaults.secrets", value)}
            idPrefix="defaults-secrets"
            title="Secret environment-variable names granted to new workflows by default."
            hideLabel
          />
        </SettingInputRow>
      </div>
    </div>
  );
}
