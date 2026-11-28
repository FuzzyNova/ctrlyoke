import React, { useCallback, useEffect, useState } from "react";
import type {
  WorktreeConfig,
  WorktreeObjectConfig,
} from "@root/types/CtrlYokeTypes";
import {
  WORKTREE_KEEP_HELP_TEXT,
  WORKTREE_MODE_SELECTIONS,
  WORKTREE_MODES,
} from "@root/types/DashboardConstants";
import {
  NAMED_WORKTREE_BRANCH_REQUIRED,
  toWorktreeObjectConfig,
  withWorktreeField,
} from "@root/utils/WorktreeConfigShape";
import { fieldValidationBorderClass } from "@utils/fieldValidation";
import { worktreeSettingDescription } from "../settings/settingsCatalog";
import { AnimatedSection } from "./AnimatedSection";
import { BranchNameEditor } from "./BranchNameEditor";
import { CustomSelect, type SelectOption } from "./CustomSelect";
import { DrawerRow } from "./DrawerRow";
import { FieldDiagnostic } from "./FieldDiagnostic";
import { SchemaFormField } from "./SchemaFormField";
import { ScriptCommandEditor } from "./ScriptCommandEditor";
import { WorktreeDirectoryEditor } from "./WorktreeDirectoryEditor";

type WorktreeMode = (typeof WORKTREE_MODES)[keyof typeof WORKTREE_MODES];
type WorktreeSelection =
  (typeof WORKTREE_MODE_SELECTIONS)[keyof typeof WORKTREE_MODE_SELECTIONS];
type WorktreeField =
  "directory" | "branch" | "base" | "setup" | "keep" | "merge";

/** How a change was made, for callers that persist the two differently. */
export const WORKTREE_CONFIG_CHANGES = {
  MODE: "mode",
  FIELD: "field",
} as const;

export type WorktreeConfigChange =
  (typeof WORKTREE_CONFIG_CHANGES)[keyof typeof WORKTREE_CONFIG_CHANGES];

/**
 * The object a newly selected mode starts from, seeded from `defaults` (the
 * settings default) where they describe the same mode.
 */
export function worktreeConfigForMode(
  mode: WorktreeMode,
  defaults: WorktreeConfig | undefined
): WorktreeObjectConfig {
  const normalizedDefaults = toWorktreeObjectConfig(defaults);
  if (mode === WORKTREE_MODES.MANAGED) {
    return {
      mode,
      base: normalizedDefaults !== false ? (normalizedDefaults.base ?? "") : "",
      setup:
        normalizedDefaults !== false ? (normalizedDefaults.setup ?? "") : "",
      merge:
        normalizedDefaults !== false &&
        normalizedDefaults.mode === WORKTREE_MODES.MANAGED
          ? (normalizedDefaults.merge ?? false)
          : false,
      keep:
        normalizedDefaults !== false &&
        normalizedDefaults.mode === WORKTREE_MODES.MANAGED
          ? (normalizedDefaults.keep ?? false)
          : false,
    };
  }
  return {
    mode: WORKTREE_MODES.NAMED,
    ...(normalizedDefaults !== false &&
    normalizedDefaults.mode === WORKTREE_MODES.NAMED &&
    normalizedDefaults.directory?.trim()
      ? { directory: normalizedDefaults.directory.trim() }
      : {}),
    branch:
      normalizedDefaults !== false &&
      normalizedDefaults.mode === WORKTREE_MODES.NAMED
        ? (normalizedDefaults.branch ?? "")
        : "",
    base: normalizedDefaults !== false ? (normalizedDefaults.base ?? "") : "",
    setup: normalizedDefaults !== false ? (normalizedDefaults.setup ?? "") : "",
  };
}

/** `current` in the full object shape a field edit is applied to. */
function editableWorktreeConfig(
  current: WorktreeConfig | undefined
): WorktreeObjectConfig {
  const config = toWorktreeObjectConfig(current);
  if (config !== false && config.mode === WORKTREE_MODES.MANAGED) {
    return {
      mode: WORKTREE_MODES.MANAGED,
      base: config.base ?? "",
      setup: config.setup ?? "",
      merge: config.merge ?? false,
      keep: config.keep ?? false,
    };
  }
  return {
    mode: WORKTREE_MODES.NAMED,
    branch:
      config !== false && config.mode === WORKTREE_MODES.NAMED
        ? (config.branch ?? "")
        : "",
    ...(config !== false &&
    config.mode === WORKTREE_MODES.NAMED &&
    config.directory?.trim()
      ? { directory: config.directory.trim() }
      : {}),
    base: config !== false ? (config.base ?? "") : "",
    setup: config !== false ? (config.setup ?? "") : "",
  };
}

/** The selector value for `value`; undefined is the inherit option. */
function selectionFor(value: WorktreeConfig | undefined): WorktreeSelection {
  if (value === undefined) return WORKTREE_MODE_SELECTIONS.INHERIT;
  const config = toWorktreeObjectConfig(value);
  return config === false ? WORKTREE_MODE_SELECTIONS.NONE : config.mode;
}

export interface WorktreeConfigEditorProps {
  /** Prefixes every control id (`<prefix>-worktree-mode`, …). */
  idPrefix: string;
  label: string;
  /** Title for the mode selector's label. */
  description?: string;
  /**
   * The worktree shown. `undefined` selects the inherit option, which only
   * `options` that include it can offer.
   */
  value: WorktreeConfig | undefined;
  /** Mode options: `WORKTREE_SELECTION_OPTIONS_META` or a superset of it. */
  options: SelectOption[];
  /** Seeds the fields of a newly selected mode (the settings default). */
  seedDefaults: WorktreeConfig | undefined;
  /**
   * A mode change commits at once; a text field commits on blur and a
   * checkbox on change. `undefined` is the inherit option.
   */
  onChange: (
    next: WorktreeConfig | undefined,
    change: WorktreeConfigChange
  ) => void;
  narrow?: boolean;
  disabled?: boolean;
  setAsDefaultButton?: React.ReactNode;
}

/**
 * The worktree editor: a mode selector and the fields that mode takes. The
 * single copy behind the workflow properties panel's Worktree group and the
 * step editor's inline sub-workflow worktree (D13).
 */
export const WorktreeConfigEditor: React.FC<WorktreeConfigEditorProps> = ({
  idPrefix,
  label,
  description,
  value,
  options,
  seedDefaults,
  onChange,
  narrow = false,
  disabled = false,
  setAsDefaultButton,
}) => {
  const config = toWorktreeObjectConfig(value);
  const mode = selectionFor(value);
  const branch =
    config !== false && config.mode === WORKTREE_MODES.NAMED
      ? (config.branch ?? "")
      : "";
  const directory =
    config !== false && config.mode === WORKTREE_MODES.NAMED
      ? (config.directory ?? "")
      : "";
  const base = config !== false ? (config.base ?? "") : "";
  const setup = config !== false ? (config.setup ?? "") : "";
  const keep =
    config !== false && config.mode === WORKTREE_MODES.MANAGED
      ? (config.keep ?? false)
      : false;
  const merge =
    config !== false && config.mode === WORKTREE_MODES.MANAGED
      ? (config.merge ?? false)
      : false;

  // Text fields commit on blur, so they hold their typed value until then.
  const [branchInput, setBranchInput] = useState(branch);
  const [directoryInput, setDirectoryInput] = useState(directory);
  const [baseInput, setBaseInput] = useState(base);
  const [setupInput, setSetupInput] = useState(setup);
  useEffect(() => {
    setBranchInput(branch);
    setDirectoryInput(directory);
    setBaseInput(base);
    setSetupInput(setup);
  }, [base, branch, directory, setup]);

  const handleModeChange = useCallback(
    (selected: string) => {
      switch (selected as WorktreeSelection) {
        case WORKTREE_MODE_SELECTIONS.INHERIT:
          onChange(undefined, WORKTREE_CONFIG_CHANGES.MODE);
          return;
        case WORKTREE_MODE_SELECTIONS.NONE:
          onChange(false, WORKTREE_CONFIG_CHANGES.MODE);
          return;
        case WORKTREE_MODE_SELECTIONS.MANAGED:
        case WORKTREE_MODE_SELECTIONS.NAMED:
          onChange(
            worktreeConfigForMode(selected as WorktreeMode, seedDefaults),
            WORKTREE_CONFIG_CHANGES.MODE
          );
          return;
      }
    },
    [onChange, seedDefaults]
  );

  const commitField = useCallback(
    (field: WorktreeField, fieldValue: string | boolean) => {
      onChange(
        withWorktreeField(
          editableWorktreeConfig(value),
          field,
          fieldValue
        ) as WorktreeConfig,
        WORKTREE_CONFIG_CHANGES.FIELD
      );
    },
    [onChange, value]
  );

  const branchDiagnostics =
    mode === WORKTREE_MODES.NAMED && !branchInput.trim()
      ? [
          {
            severity: "error" as const,
            message: NAMED_WORKTREE_BRANCH_REQUIRED,
          },
        ]
      : [];
  const ids = {
    mode: `${idPrefix}-worktree-mode`,
    directory: `${idPrefix}-worktree-directory`,
    branch: `${idPrefix}-worktree-branch`,
    branchDiagnostic: `${idPrefix}-worktree-branch-diagnostic`,
    base: `${idPrefix}-worktree-base`,
    setup: `${idPrefix}-worktree-setup`,
    keep: `${idPrefix}-worktree-keep`,
    merge: `${idPrefix}-worktree-merge`,
  };
  const hasFields =
    mode === WORKTREE_MODES.MANAGED || mode === WORKTREE_MODES.NAMED;

  return (
    <>
      <SchemaFormField
        label={label}
        schemaPath="worktree"
        description={description}
        preferDescription={description !== undefined}
        htmlFor={ids.mode}
        setAsDefaultButton={setAsDefaultButton}
      >
        <CustomSelect
          id={ids.mode}
          schemaPath="worktree"
          triggerAriaLabel={label}
          value={mode}
          onChange={handleModeChange}
          options={options}
          disabled={disabled}
        />
      </SchemaFormField>

      <AnimatedSection visible={hasFields}>
        <div className="space-y-2">
          <DrawerRow narrow={narrow}>
            {mode === WORKTREE_MODES.NAMED && (
              <>
                <SchemaFormField
                  label="Directory"
                  schemaPath="worktree.directory"
                  htmlFor={ids.directory}
                  description="Long-lived worktree directory: an existing one to reuse, or a new name (created as exactly that folder under the worktree root) or path. Empty derives the directory from the branch."
                >
                  <WorktreeDirectoryEditor
                    id={ids.directory}
                    aria-label="Worktree directory"
                    value={directoryInput}
                    onChange={setDirectoryInput}
                    onBlur={() => commitField("directory", directoryInput)}
                    placeholder="Derived from branch"
                    disabled={disabled}
                    className="w-full bg-input-bg text-input-fg border border-input-border rounded-sm focus:outline-hidden focus:border-focus-border font-mono"
                  />
                </SchemaFormField>
                <SchemaFormField
                  label="Branch"
                  schemaPath="worktree.branch"
                  htmlFor={ids.branch}
                  description="Existing or new local Git branch. With a directory set, the branch can differ from the directory's name; ctrlyoke switches the directory to it when the directory is clean."
                >
                  <BranchNameEditor
                    id={ids.branch}
                    aria-label="Worktree branch"
                    value={branchInput}
                    onChange={setBranchInput}
                    onBlur={() => commitField("branch", branchInput)}
                    disabled={disabled}
                    aria-describedby={
                      branchDiagnostics.length > 0
                        ? ids.branchDiagnostic
                        : undefined
                    }
                    className={`w-full bg-input-bg text-input-fg border ${fieldValidationBorderClass(branchDiagnostics)} rounded-sm focus:outline-hidden focus:border-focus-border font-mono`}
                  />
                  <FieldDiagnostic
                    id={ids.branchDiagnostic}
                    diagnostics={branchDiagnostics}
                  />
                </SchemaFormField>
              </>
            )}
            <SchemaFormField
              label="Base"
              schemaPath="worktree.base"
              htmlFor={ids.base}
              description="Optional Git ref used as the starting point for a new worktree."
            >
              <BranchNameEditor
                id={ids.base}
                aria-label="Worktree base"
                value={baseInput}
                onChange={setBaseInput}
                onBlur={() => commitField("base", baseInput)}
                disabled={disabled}
                placeholder="Current branch (HEAD)"
                className="w-full bg-input-bg text-input-fg border border-input-border rounded-sm focus:outline-hidden focus:border-focus-border font-mono"
              />
            </SchemaFormField>
            <SchemaFormField
              label="Setup"
              schemaPath="worktree.setup"
              htmlFor={ids.setup}
              description={worktreeSettingDescription(
                mode === WORKTREE_MODES.NAMED
                  ? WORKTREE_MODES.NAMED
                  : WORKTREE_MODES.MANAGED,
                "setup"
              )}
              preferDescription
            >
              <ScriptCommandEditor
                id={ids.setup}
                aria-label="Worktree setup"
                value={setupInput}
                onChange={setSetupInput}
                onBlur={() => commitField("setup", setupInput)}
                disabled={disabled}
                placeholder="e.g. npm ci"
                className="w-full text-xs bg-input-bg text-input-fg border border-input-border rounded-sm focus:outline-hidden focus:border-focus-border font-mono"
              />
            </SchemaFormField>
            {mode === WORKTREE_MODES.MANAGED && (
              <>
                <SchemaFormField
                  label="Keep directory"
                  schemaPath="worktree.keep"
                  htmlFor={ids.keep}
                  description={WORKTREE_KEEP_HELP_TEXT}
                >
                  <label className="flex items-center gap-2 min-h-7 text-xs text-foreground">
                    <input
                      type="checkbox"
                      id={ids.keep}
                      aria-label="Keep directory"
                      checked={keep}
                      disabled={disabled}
                      onChange={(event) =>
                        commitField("keep", event.target.checked)
                      }
                      className="accent-button-bg"
                    />
                    Keep managed worktree for review and undo
                  </label>
                </SchemaFormField>
                <SchemaFormField
                  label="Merge"
                  schemaPath="worktree.merge"
                  htmlFor={ids.merge}
                  description="Merge the managed branch into the working checkout after every run."
                >
                  <label className="flex items-center gap-2 min-h-7 text-xs text-foreground">
                    <input
                      type="checkbox"
                      id={ids.merge}
                      aria-label="Merge"
                      checked={merge}
                      disabled={disabled}
                      onChange={(event) =>
                        commitField("merge", event.target.checked)
                      }
                      className="accent-button-bg"
                    />
                    Merge into the working checkout after every run
                  </label>
                </SchemaFormField>
              </>
            )}
          </DrawerRow>
        </div>
      </AnimatedSection>
    </>
  );
};
