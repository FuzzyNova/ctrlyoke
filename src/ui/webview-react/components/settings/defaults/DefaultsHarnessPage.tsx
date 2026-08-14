import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import {
  EXECUTION_MODE_OPTIONS,
  WORKTREE_KEEP_HELP_TEXT,
  WORKTREE_MODE_HELP_TEXT,
  WORKTREE_MODE_OPTIONS,
  WORKTREE_MODES,
} from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { agentWarning, skillsWarning } from "@utils/dropdownValidation";
import { CustomSelect } from "../../shared/CustomSelect";
import { toAgentSelectOption } from "../../shared/agentSelectOptions";
import { MultiCheckboxDropdown } from "../../shared/MultiCheckboxDropdown";
import { SettingInputRow } from "../../shared/SettingInputRow";
import { FieldDiagnostic } from "../../shared/FieldDiagnostic";
import { fieldValidationBorderClass } from "@utils/fieldValidation";
import { HarnessesSection } from "../HarnessesSection";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function DefaultsHarnessPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const wf = settings.settings.defaults;
  const availableAgents = useSettingsStore((s) => s.availableAgents);
  const availableSkills = useSettingsStore((s) => s.availableSkills);
  const rowProps = { sources, onReset, activeScope };
  const agentWarn = agentWarning(wf.agent, availableAgents);
  const skillsWarn = skillsWarning(wf.skills, availableSkills);
  const worktreeBranchDiagnostics =
    wf.worktree.mode === WORKTREE_MODES.NAMED && !wf.worktree.branch?.trim()
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
          label="Execution mode"
          description="Where steps run by default. Interactive spawns a live terminal you can steer; headless runs in the background. Workflows and steps can override this. Pre/end-condition scripts always run headless."
          id="defaults-execution-mode"
          path="defaults.executionMode"
          {...rowProps}
        >
          <CustomSelect
            id="defaults-execution-mode"
            value={wf.executionMode}
            onChange={(v) => onUpdate("defaults.executionMode", v)}
            options={EXECUTION_MODE_OPTIONS}
          />
        </SettingInputRow>
      </div>
      <div className="border-t border-panel-border pt-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Worktree Defaults
        </h3>
        <SettingInputRow
          label="Worktree mode"
          description={WORKTREE_MODE_HELP_TEXT}
          id="defaults-worktree-mode"
          path="defaults.worktree.mode"
          {...rowProps}
        >
          <CustomSelect
            id="defaults-worktree-mode"
            value={wf.worktree.mode}
            onChange={(v) => onUpdate("defaults.worktree.mode", v)}
            options={WORKTREE_MODE_OPTIONS}
          />
        </SettingInputRow>
        {wf.worktree.mode === WORKTREE_MODES.NAMED && (
          <>
            <SettingInputRow
              label="Branch"
              description="Required local Git branch for the named default."
              id="defaults-worktree-branch"
              path="defaults.worktree.branch"
              {...rowProps}
            >
              <input
                id="defaults-worktree-branch"
                type="text"
                value={wf.worktree.branch ?? ""}
                onChange={(event) =>
                  onUpdate("defaults.worktree.branch", event.target.value)
                }
                className={`w-full px-2 py-1 text-xs bg-input-bg text-input-fg border ${fieldValidationBorderClass(worktreeBranchDiagnostics)} rounded focus:outline-none focus:border-focus-border font-mono h-7`}
              />
              <FieldDiagnostic
                id="defaults-worktree-branch-diagnostic"
                diagnostics={worktreeBranchDiagnostics}
              />
            </SettingInputRow>
            <SettingInputRow
              label="Base"
              description="Optional Git ref used as the starting point for a new branch."
              id="defaults-worktree-base"
              path="defaults.worktree.base"
              {...rowProps}
            >
              <input
                id="defaults-worktree-base"
                type="text"
                value={wf.worktree.base ?? ""}
                onChange={(event) =>
                  onUpdate("defaults.worktree.base", event.target.value)
                }
                placeholder="Default branch"
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
              />
            </SettingInputRow>
            <SettingInputRow
              label="Setup"
              description="Optional command run after creating a named worktree."
              id="defaults-worktree-setup"
              path="defaults.worktree.setup"
              {...rowProps}
            >
              <input
                id="defaults-worktree-setup"
                type="text"
                value={wf.worktree.setup ?? ""}
                onChange={(event) =>
                  onUpdate("defaults.worktree.setup", event.target.value)
                }
                placeholder="e.g. npm ci"
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
              />
            </SettingInputRow>
          </>
        )}
        {wf.worktree.mode === WORKTREE_MODES.MANAGED && (
          <>
            <SettingInputRow
              label="Base"
              description="Optional Git ref used as the starting point for a new managed worktree."
              id="defaults-worktree-base"
              path="defaults.worktree.base"
              {...rowProps}
            >
              <input
                id="defaults-worktree-base"
                type="text"
                value={wf.worktree.base ?? ""}
                onChange={(event) =>
                  onUpdate("defaults.worktree.base", event.target.value)
                }
                placeholder="Default branch"
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
              />
            </SettingInputRow>
            <SettingInputRow
              label="Setup"
              description="Optional command run after creating a managed worktree."
              id="defaults-worktree-setup"
              path="defaults.worktree.setup"
              {...rowProps}
            >
              <input
                id="defaults-worktree-setup"
                type="text"
                value={wf.worktree.setup ?? ""}
                onChange={(event) =>
                  onUpdate("defaults.worktree.setup", event.target.value)
                }
                placeholder="e.g. npm ci"
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
              />
            </SettingInputRow>
            <SettingInputRow
              label="Keep directory"
              description={WORKTREE_KEEP_HELP_TEXT}
              id="defaults-worktree-keep"
              path="defaults.worktree.keep"
              {...rowProps}
            >
              <label className="flex items-center gap-2 min-h-7 text-xs text-foreground">
                <input
                  id="defaults-worktree-keep"
                  type="checkbox"
                  aria-label="Keep directory"
                  checked={wf.worktree.keep ?? false}
                  onChange={(event) =>
                    onUpdate("defaults.worktree.keep", event.target.checked)
                  }
                  className="accent-button-bg"
                />
                Keep managed worktrees for review and undo
              </label>
            </SettingInputRow>
            <SettingInputRow
              label="Merge"
              description="Merge is the only worktree option that writes to your live working checkout: it merges the managed branch into the working checkout after every run. The engine requires the captured target branch and a clean checkout, takes an exclusive lease, and aborts cleanly on conflict."
              id="defaults-worktree-merge"
              path="defaults.worktree.merge"
              {...rowProps}
            >
              <label className="flex items-center gap-2 min-h-7 text-xs text-foreground">
                <input
                  id="defaults-worktree-merge"
                  type="checkbox"
                  aria-label="Merge"
                  checked={wf.worktree.merge ?? false}
                  onChange={(event) =>
                    onUpdate("defaults.worktree.merge", event.target.checked)
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
          label="Default agent"
          description="Agent to use when none is specified in the workflow."
          id="defaults-agent"
          path="defaults.agent"
          {...rowProps}
        >
          <CustomSelect
            id="defaults-agent"
            value={wf.agent || ""}
            onChange={(v) => onUpdate("defaults.agent", v)}
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
          label="Default skills"
          description="Skills to include in new workflows by default."
          id="defaults-skills"
          path="defaults.skills"
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
      </div>
    </div>
  );
}
