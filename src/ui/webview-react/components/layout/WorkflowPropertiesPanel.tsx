import React, { useState, useCallback, useEffect, useMemo } from "react";
import type {
  ErrorBehavior,
  UserHookConfig,
  WorktreeConfig,
} from "@root/types/CtrlYokeTypes";
import {
  useSettingsStore,
  type WorkflowProperties,
  type GlobalSettings,
} from "../../store/settingsStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useUiStore } from "../../store/uiStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { useIsViewingDeletedWorkflow } from "../../hooks/useIsViewingDeletedWorkflow";
import { useIsSystemGeneratedWorkflow } from "../../hooks/useIsSystemGeneratedWorkflow";
import { useDrawerTabOverrides } from "../../hooks/useDrawerTabOverrides";
import { useCompatibilityDiagnostics } from "../../hooks/useCompatibilityDiagnostics";
import {
  MESSAGE_TYPES,
  SESSION_ID_SENTINELS,
  CONDITION_ACTIONS,
  type PriorContext,
  type HarnessId,
  type ToolPermissionMode,
} from "../../types/messages";
import {
  DROPDOWN_NAMESPACES,
  modelNamespaceForHarness,
  getResumeSessionOptions,
} from "../../types/dropdownNamespaces";
import { triggerPanelAnimation } from "@utils/panelAnimation";
import {
  PanelBar,
  CustomSelect,
  toAgentSelectOption,
  MultiCheckboxDropdown,
  HarnessDropdown,
  PriorContextSelect,
  DrawerTabBar,
  DrawerRow,
  McpServersEditor,
  type McpServersValue,
  PERMISSION_MODE_OPTIONS,
  FieldDiagnostic,
  CompatibilitySummary,
  ErrorBehaviorEditor,
  ScriptConditionEditor,
  type ScriptConditionValue,
  ScriptCommandEditor,
  AdditionalArgsEditor,
  KeyValueMapEditor,
  BranchNameEditor,
  AnimatedSection,
  AutoResumeStatusRow,
  ExitButton,
  filterExplicitSecretGrants,
  useSecretGrantOptions,
} from "../shared";
import { HooksEditor } from "../editor/HooksEditor";
import { PermissionListEditor } from "../shared/PermissionListEditor";
import { DRAWER_PAGES, type DrawerPage } from "../../types/drawerPages";
import {
  KEYBOARD_KEYS,
  EXECUTION_MODE_HELP_TEXT,
  EXECUTION_MODE_OPTIONS,
  WORKTREE_KEEP_HELP_TEXT,
  WORKTREE_MODE_HELP_TEXT,
  WORKTREE_MODE_OPTIONS,
  WORKTREE_MODES,
  PERMISSION_MODES,
  PERMISSION_CAPABILITY_KEYS,
  PROMPT_PROPERTIES,
} from "../../../../types/DashboardConstants";
import { getAutoResumePreview } from "../../utils/autoResumePreview";
import { parseSecretReferences } from "@root/utils/SecretReferenceParser";
import { postWorkflowDefinitionMutation } from "../../utils/workflowMutation";
import {
  agentWarning,
  modelWarning,
  skillsWarning,
} from "@utils/dropdownValidation";
import { fieldValidationBorderClass } from "@utils/fieldValidation";
import {
  diagnosticsForPermissionField,
  diagnosticsForHookEvents,
  diagnosticsForMcpFiltering,
  firstCompatibilityProperty,
  formatCompatibilitySource,
  toFieldDiagnostic,
  workflowPermissionDiagnostic,
} from "@utils/compatibilityDiagnostics";
/** Single breakpoint (px) where the settings drawer switches to narrow layout */
const SETTINGS_DRAWER_BREAKPOINT = 400;

type WorktreeField = "branch" | "base" | "setup" | "keep" | "merge";
type WorktreeObjectConfig = Exclude<WorktreeConfig, false | true | string>;

function worktreeConfigForMode(
  mode: (typeof WORKTREE_MODES)[keyof typeof WORKTREE_MODES],
  defaults: GlobalSettings["worktree"]
): WorktreeObjectConfig {
  if (mode === WORKTREE_MODES.MANAGED) {
    return {
      mode,
      base: defaults?.base ?? "",
      setup: defaults?.setup ?? "",
      merge:
        defaults?.mode === WORKTREE_MODES.MANAGED
          ? (defaults.merge ?? false)
          : false,
      keep:
        defaults?.mode === WORKTREE_MODES.MANAGED
          ? (defaults.keep ?? false)
          : false,
    };
  }
  return {
    mode: WORKTREE_MODES.NAMED,
    branch:
      defaults?.mode === WORKTREE_MODES.NAMED ? (defaults.branch ?? "") : "",
    base: defaults?.base ?? "",
    setup: defaults?.setup ?? "",
  };
}

const BUTTON_STATE = {
  IDLE: "idle",
  SUCCESS: "success",
  FADING: "fading",
} as const;
type ButtonState = (typeof BUTTON_STATE)[keyof typeof BUTTON_STATE];

/**
 * Set as Default link with animation
 */
const SetAsDefaultButton: React.FC<{
  property: string;
  show: boolean;
  onSetDefault: () => void;
}> = ({ show, onSetDefault }) => {
  const [state, setState] = useState<ButtonState>(BUTTON_STATE.IDLE);

  const handleClick = useCallback(() => {
    onSetDefault();
    setState(BUTTON_STATE.SUCCESS);
    setTimeout(() => setState(BUTTON_STATE.FADING), 2000);
    setTimeout(() => setState(BUTTON_STATE.IDLE), 2300);
  }, [onSetDefault]);

  if (!show && state === BUTTON_STATE.IDLE) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`text-xxs font-semibold uppercase text-link-fg hover:underline cursor-pointer transition-colors ${
        state === BUTTON_STATE.SUCCESS ? "text-indicator-success" : ""
      } ${state === BUTTON_STATE.FADING ? "opacity-0" : ""}`}
      title="Set this as the default for new workflows"
    >
      {state === BUTTON_STATE.SUCCESS ? "✓ Default" : "Set as Default"}
    </button>
  );
};

/**
 * Form field wrapper with label and description
 */
const FormField: React.FC<{
  label: string;
  description?: string;
  htmlFor?: string;
  children: React.ReactNode;
  setAsDefaultButton?: React.ReactNode;
  className?: string;
}> = ({
  label,
  description,
  htmlFor,
  children,
  setAsDefaultButton,
  className,
}) => (
  <div className={`flex flex-col gap-1${className ? ` ${className}` : ""}`}>
    <div className="flex items-center justify-between min-h-[18px]">
      <label
        htmlFor={htmlFor}
        title={description}
        className="text-xs font-semibold uppercase text-description-fg cursor-help"
      >
        {label}
      </label>
      {setAsDefaultButton}
    </div>
    {children}
  </div>
);

/**
 * WorkflowPropertiesPanel Component
 *
 * Collapsible panel for configuring:
 * - Harness settings (harness, model, agent)
 * - Workflow properties (execution mode, resume session, dynamic queue)
 * - End condition configuration
 * - Quick access to VS Code settings
 */
const WorkflowPropertiesPanelInner: React.FC<{
  panelBarOrientation?: "horizontal" | "vertical";
  onRequestClose?: () => void;
}> = ({ panelBarOrientation = "vertical", onRequestClose }) => {
  const vscode = useVsCodeApi();
  const {
    settingsCollapsed,
    toggleSettingsCollapse,
    hiddenDropdownOptions,
    hideDropdownOption,
    unhideDropdownOption,
    loadedWorkflows,
    activeWorkflowId,
    setWorkflowPortabilityReportOpen,
  } = useUiStore();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isExternallyManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy != null;
  // The lineage on screen was deleted while being viewed — nothing here has
  // anywhere left to write to.
  const isViewingDeletedWorkflow = useIsViewingDeletedWorkflow();
  // The lineage on screen is an internal system lineage (e.g. commit message
  // generation) — every property here is overridden by its owning feature on
  // the next run regardless of what's edited, so editing is pure UI theater.
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();
  const {
    availableAgents,
    availableSkills,
    harnessStatus: harnessStatus,
    globalSettings,
    workflowProperties,
    getModelsForHarness: getModelsForHarness,
    getEffectiveHarness: getEffectiveHarness,
    getEffectiveModel,
    getEffectiveExecutionMode,
    getEffectiveWorktree,
    getEffectiveAgent,
    getEffectiveSkills,
    getEffectiveSecrets,
    getEffectiveResumeSession,
    getEffectiveMcpServers,
    getEffectiveHooks,
    getEffectivePriorContext,
    getEffectiveAdditionalArgs,
  } = useSettingsStore();

  // New workflows do not have a working-file override until their first edit.
  // Render their effective validation defaults without losing an explicit null,
  // which means the workflow deliberately disables the configured default.
  const effectiveEndCondition =
    workflowProperties.endCondition !== undefined
      ? workflowProperties.endCondition
      : globalSettings.defaultEndCondition;
  const effectivePreCondition =
    workflowProperties.preCondition !== undefined
      ? workflowProperties.preCondition
      : globalSettings.defaultPreCondition;

  // Active drawer page
  const [activePage, setActivePage] = useState<DrawerPage>(
    DRAWER_PAGES.HARNESS
  );

  // End condition enabled state
  const [endConditionEnabled, setEndConditionEnabled] = useState(
    effectiveEndCondition !== null && effectiveEndCondition !== undefined
  );

  // Session ID input state
  const [sessionIdInput, setSessionIdInput] = useState("");

  // Sync sessionIdInput with store changes
  useEffect(() => {
    const sessionId = workflowProperties.sessionId;
    setSessionIdInput(sessionId !== undefined ? String(sessionId) : "");
  }, [workflowProperties.sessionId]);

  // Update end condition state when workflow properties change
  useEffect(() => {
    setEndConditionEnabled(
      effectiveEndCondition !== null && effectiveEndCondition !== undefined
    );
  }, [effectiveEndCondition]);

  // Single breakpoint for all three layout zones (body rows, tab labels, footer toggles)
  const [drawerRef, isNarrow] = useElementNarrow<HTMLDivElement>(
    SETTINGS_DRAWER_BREAKPOINT
  );

  // Get current effective values
  const effectiveHarness = getEffectiveHarness();
  const effectiveModel = getEffectiveModel();
  const effectiveExecutionMode = getEffectiveExecutionMode();
  const effectiveWorktree = getEffectiveWorktree();
  const effectiveWorktreeMode =
    effectiveWorktree === false ? WORKTREE_MODES.NONE : effectiveWorktree.mode;
  const effectiveWorktreeBranch =
    effectiveWorktree === false || !("branch" in effectiveWorktree)
      ? ""
      : (effectiveWorktree.branch ?? "");
  const effectiveWorktreeBase =
    effectiveWorktree === false ? "" : (effectiveWorktree.base ?? "");
  const effectiveWorktreeSetup =
    effectiveWorktree === false ? "" : (effectiveWorktree.setup ?? "");
  const effectiveWorktreeKeep =
    effectiveWorktree !== false && "keep" in effectiveWorktree
      ? (effectiveWorktree.keep ?? false)
      : false;
  const effectiveWorktreeMerge =
    effectiveWorktree !== false && "merge" in effectiveWorktree
      ? (effectiveWorktree.merge ?? false)
      : false;
  const effectiveAgent = getEffectiveAgent();
  const effectiveSkills = getEffectiveSkills();
  const effectiveSecrets = getEffectiveSecrets();
  const effectiveResumeSession = getEffectiveResumeSession();
  const effectiveMcpServers = getEffectiveMcpServers();
  const effectiveHooks = getEffectiveHooks();
  const effectivePriorContext = getEffectivePriorContext();
  const effectiveAdditionalArgs = getEffectiveAdditionalArgs();

  const [worktreeMode, setWorktreeMode] = useState(effectiveWorktreeMode);
  const [worktreeBranchInput, setWorktreeBranchInput] = useState(
    effectiveWorktreeBranch
  );
  const [worktreeBaseInput, setWorktreeBaseInput] = useState(
    effectiveWorktreeBase
  );
  const [worktreeSetupInput, setWorktreeSetupInput] = useState(
    effectiveWorktreeSetup
  );
  const [worktreeKeepInput, setWorktreeKeepInput] = useState(
    effectiveWorktreeKeep
  );
  const [worktreeMergeInput, setWorktreeMergeInput] = useState(
    effectiveWorktreeMerge
  );

  useEffect(() => {
    setWorktreeMode(effectiveWorktreeMode);
    setWorktreeBranchInput(effectiveWorktreeBranch);
    setWorktreeBaseInput(effectiveWorktreeBase);
    setWorktreeSetupInput(effectiveWorktreeSetup);
    setWorktreeKeepInput(effectiveWorktreeKeep);
    setWorktreeMergeInput(effectiveWorktreeMerge);
  }, [
    effectiveWorktreeBase,
    effectiveWorktreeBranch,
    effectiveWorktreeMode,
    effectiveWorktreeSetup,
    effectiveWorktreeKeep,
    effectiveWorktreeMerge,
  ]);

  const compatibility = useCompatibilityDiagnostics();
  const permissionDiagnostics = compatibility.diagnostics.filter(
    (diagnostic) =>
      diagnostic.capability === PERMISSION_CAPABILITY_KEYS.MODE ||
      diagnostic.capability === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS ||
      diagnostic.capability === PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
  );
  const hookDiagnostics = diagnosticsForHookEvents(compatibility.diagnostics);
  const mcpDiagnostics = diagnosticsForMcpFiltering(compatibility.diagnostics);
  const allowedDiagnostics = diagnosticsForPermissionField(
    compatibility.diagnostics,
    "allowedTools"
  );
  const deniedDiagnostics = diagnosticsForPermissionField(
    compatibility.diagnostics,
    "deniedTools"
  );
  const modeDiagnostics = diagnosticsForPermissionField(
    compatibility.diagnostics,
    "mode"
  );
  const allowedAggregate = compatibility.capabilitySnapshot
    ? workflowPermissionDiagnostic(
        "allowedTools",
        compatibility.executionTargets,
        compatibility.capabilitySnapshot
      )
    : undefined;
  const deniedAggregate = compatibility.capabilitySnapshot
    ? workflowPermissionDiagnostic(
        "deniedTools",
        compatibility.executionTargets,
        compatibility.capabilitySnapshot
      )
    : undefined;
  const allowedFieldDiagnostics = allowedAggregate
    ? [allowedAggregate]
    : allowedDiagnostics;
  const deniedFieldDiagnostics = deniedAggregate
    ? [deniedAggregate]
    : deniedDiagnostics;

  // Local input state for Additional Args — committed on blur/Enter to avoid
  // flooding the undo stack with every keystroke.
  const [additionalArgsInput, setAdditionalArgsInput] = useState(
    effectiveAdditionalArgs
  );

  // Sync local state when the effective value changes externally (harness switch, reset all).
  useEffect(() => {
    setAdditionalArgsInput(effectiveAdditionalArgs);
  }, [effectiveAdditionalArgs]);

  // Preview of what auto-resume would do for a new step appended to the
  // queue, shown when the Session ID field is blank.
  const steps = useWorkflowStore((s) => s.steps);
  const finalStep = useWorkflowStore((s) => s.finalStep);
  const inlineSecretNames = useMemo(
    () => [
      ...new Set(
        [...steps, ...(finalStep ? [finalStep] : [])].flatMap((step) =>
          "prompt" in step
            ? parseSecretReferences(step.prompt).map(
                (reference) => reference.name
              )
            : []
        )
      ),
    ],
    [finalStep, steps]
  );
  const {
    options: secretOptions,
    selectedValues: resolvedSecretGrants,
    lockedValues: inlineSecretGrantNames,
    nonHideableValues: secretNames,
    unresolvedSecretNames,
    unresolvedSecretDiagnostics,
  } = useSecretGrantOptions({
    declaredSecrets: effectiveSecrets,
    inlineSecretNames,
  });
  const autoResumePreview = getAutoResumePreview(
    steps,
    steps.length,
    effectiveHarness
  );

  // Derive the active model namespace from the current harness
  const modelNamespace = modelNamespaceForHarness(effectiveHarness);

  // Get models for current harness
  const currentHarnessModels = getModelsForHarness(effectiveHarness);
  const modelWarn = modelWarning(
    workflowProperties.model,
    effectiveHarness,
    currentHarnessModels
  );
  const agentWarn = agentWarning(workflowProperties.agent, availableAgents);
  const skillsWarn = skillsWarning(workflowProperties.skills, availableSkills);

  // Check if workflow value differs from global setting
  const isDifferentFromGlobal = useCallback(
    (property: keyof WorkflowProperties) => {
      const workflowValue = workflowProperties[property];
      if (workflowValue === undefined) return false;
      if (property === "worktree") {
        const normalize = (value: unknown) => {
          if (
            value === undefined ||
            value === false ||
            value === WORKTREE_MODES.NONE
          ) {
            return { mode: WORKTREE_MODES.NONE };
          }
          if (typeof value === "string") {
            return { mode: WORKTREE_MODES.NAMED, branch: value };
          }
          const config = value as {
            mode: string;
            branch?: string;
            base?: string;
            setup?: string;
            keep?: boolean;
            merge?: boolean;
          };
          if (config.mode === WORKTREE_MODES.NONE) {
            return { mode: WORKTREE_MODES.NONE };
          }
          return {
            mode: config.mode,
            branch: config.branch ?? "",
            base: config.base ?? "",
            setup: config.setup ?? "",
            keep: config.keep ?? false,
            merge: config.merge ?? false,
          };
        };
        return (
          JSON.stringify(normalize(workflowValue)) !==
          JSON.stringify(normalize(globalSettings.worktree))
        );
      }
      if (property === "model") {
        // Compare against the global default for the effective harness, not the
        // global harness default — they differ when a non-default harness is selected
        return (
          workflowValue !==
          globalSettings.harnessDefaultModels[effectiveHarness]
        );
      }
      if (property === "additionalArgs") {
        // Compare against the harness-specific default, treating empty string,
        // null, and undefined as equivalent — all mean "no args"
        const harnessDefault =
          globalSettings.harnessDefaultAdditionalArgs[effectiveHarness] ?? "";
        return (workflowValue || "") !== (harnessDefault || "");
      }
      if (property === PROMPT_PROPERTIES.AGENT) {
        // Persisted workflow agent uses null for "None" (see normalizeAgentSelection
        // in WorkflowStepSanitizer), while the global default uses "" — treat both
        // as equivalent so the button hides when the workflow matches the default.
        return (workflowValue || "") !== (globalSettings.agent || "");
      }
      // Array comparison for skills — compare against global default skills
      if (property === "skills") {
        return (
          JSON.stringify(workflowValue) !==
          JSON.stringify(globalSettings.skills ?? [])
        );
      }
      // Secret grants use the same replace-not-merge array semantics as skills.
      if (property === "secrets") {
        return (
          JSON.stringify(workflowValue ?? []) !==
          JSON.stringify(globalSettings.secrets ?? [])
        );
      }
      // JSON comparison for priorContext — value can be a string or number[]
      if (property === "priorContext") {
        return (
          JSON.stringify(workflowValue) !==
          JSON.stringify(globalSettings.priorContext)
        );
      }
      // Deep comparison for mcpServers — null and [] are both "no servers" and
      // must not trigger the "Set as Default" button when the global is also empty.
      if (property === "mcpServers") {
        const normalize = (v: unknown) => (Array.isArray(v) ? v : []);
        return (
          JSON.stringify(normalize(workflowValue)) !==
          JSON.stringify(normalize(globalSettings.mcpServers))
        );
      }
      // Deep comparison for hooks
      if (property === "hooks") {
        const normalize = (v: unknown) => (Array.isArray(v) ? v : []);
        return (
          JSON.stringify(normalize(workflowValue)) !==
          JSON.stringify(normalize(globalSettings.hooks))
        );
      }
      // Deep comparison for endCondition — null/undefined both mean "no condition"
      if (property === "endCondition") {
        const normalize = (v: unknown) => (v == null ? null : v);
        return (
          JSON.stringify(normalize(workflowValue)) !==
          JSON.stringify(normalize(globalSettings.defaultEndCondition))
        );
      }
      // Deep comparison for preCondition — null/undefined both mean "no condition"
      if (property === "preCondition") {
        const normalize = (v: unknown) => (v == null ? null : v);
        return (
          JSON.stringify(normalize(workflowValue)) !==
          JSON.stringify(normalize(globalSettings.defaultPreCondition))
        );
      }
      // Deep comparison for errorBehavior — null/undefined both fall back to
      // the hardcoded "stop" default, so they're equivalent to an explicit
      // { onError: "stop" } for this comparison.
      if (property === "errorBehavior") {
        const normalize = (v: unknown) => v ?? { onError: "stop" as const };
        return (
          JSON.stringify(normalize(workflowValue)) !==
          JSON.stringify(normalize(globalSettings.defaultErrorBehavior))
        );
      }
      // Deep comparison for toolPermissions — normalize null/undefined/none
      // to a canonical form so the button hides when values match the global defaults.
      if (property === "toolPermissions") {
        const wv = workflowValue as WorkflowProperties["toolPermissions"];
        const gv = globalSettings.toolPermissions;
        // null/undefined/none all mean "no override" — compare as empty
        const normalizePerms = (
          v:
            | WorkflowProperties["toolPermissions"]
            | GlobalSettings["toolPermissions"]
        ) => {
          if (
            v === null ||
            v === undefined ||
            v.mode === PERMISSION_MODES.NONE
          ) {
            return {
              mode: PERMISSION_MODES.NONE,
              allowedTools: [] as string[],
              deniedTools: [] as string[],
            };
          }
          return {
            mode: v.mode ?? PERMISSION_MODES.ALLOW_ALL,
            allowedTools: v.allowedTools ?? [],
            deniedTools: v.deniedTools ?? [],
          };
        };
        return (
          JSON.stringify(normalizePerms(wv)) !==
          JSON.stringify(normalizePerms(gv))
        );
      }
      const globalValue =
        globalSettings[property as keyof typeof globalSettings];
      return workflowValue !== globalValue;
    },
    [workflowProperties, globalSettings, effectiveHarness]
  );

  const postWorkflowPropertiesUpdate = useCallback(
    (updates: Partial<WorkflowProperties>) => {
      const settingsStore = useSettingsStore.getState();

      for (const [property, value] of Object.entries(updates)) {
        settingsStore.updateWorkflowProperty(
          property as keyof WorkflowProperties,
          value as WorkflowProperties[keyof WorkflowProperties]
        );
      }

      // Snapshot the full workflowProperties after all updates so this action
      // is tracked as a single undo entry.
      useWorkflowStore
        .getState()
        .setUndoWorkflowProperties(
          useSettingsStore.getState().workflowProperties
        );

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTIES,
        properties: updates,
      });
    },
    [vscode]
  );

  const syncWorkflowPropertiesForUndo = useCallback(() => {
    useWorkflowStore
      .getState()
      .setUndoWorkflowProperties(
        useSettingsStore.getState().workflowProperties
      );
  }, []);

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const handleHarnessChange = useCallback(
    (harness: string) => {
      const settingsStore = useSettingsStore.getState();

      // Update model dropdown options for new harness (like old implementation)
      // Get models for the new harness
      const newHarnessModels = getModelsForHarness(harness as any);
      const updates: Partial<WorkflowProperties> = { harness };

      // Always update model to the global default for the new harness
      if (newHarnessModels.length > 0) {
        const globalDefaultForHarness =
          settingsStore.globalSettings.harnessDefaultModels[harness];
        const isGlobalDefaultValid = newHarnessModels.some(
          (m) => m.value === globalDefaultForHarness
        );
        const defaultModel = isGlobalDefaultValid
          ? globalDefaultForHarness
          : newHarnessModels[0].value;

        updates.model = defaultModel;
      }

      // Always update additionalArgs to the global default for the new harness.
      // Use the empty string directly (not undefined) so JSON serialization
      // preserves the value and the extension receives the clear instruction.
      const globalDefaultAdditionalArgs =
        settingsStore.globalSettings.harnessDefaultAdditionalArgs[harness] ??
        "";
      updates.additionalArgs = globalDefaultAdditionalArgs;

      postWorkflowPropertiesUpdate(updates);
    },
    [getModelsForHarness, postWorkflowPropertiesUpdate]
  );

  const handleModelChange = useCallback(
    (model: string) => {
      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("model", model);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "model",
        value: model,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleExecutionModeChange = useCallback(
    (executionMode: string) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty(
        "executionMode",
        executionMode as WorkflowProperties["executionMode"]
      );
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "executionMode",
        value: executionMode,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleWorktreeModeChange = useCallback(
    (mode: string) => {
      if (mode === WORKTREE_MODES.NONE) {
        setWorktreeMode(WORKTREE_MODES.NONE);
        setWorktreeBranchInput("");
        setWorktreeBaseInput("");
        setWorktreeSetupInput("");
        setWorktreeKeepInput(false);
        setWorktreeMergeInput(false);
        postWorkflowPropertiesUpdate({ worktree: false });
        return;
      }

      const selectedMode = mode as Exclude<
        (typeof WORKTREE_MODES)[keyof typeof WORKTREE_MODES],
        typeof WORKTREE_MODES.NONE
      >;
      const seeded = worktreeConfigForMode(
        selectedMode,
        globalSettings.worktree
      );
      setWorktreeMode(selectedMode);
      setWorktreeBranchInput("branch" in seeded ? (seeded.branch ?? "") : "");
      setWorktreeBaseInput(seeded.base ?? "");
      setWorktreeSetupInput(seeded.setup ?? "");
      setWorktreeKeepInput(
        seeded.mode === WORKTREE_MODES.MANAGED ? (seeded.keep ?? false) : false
      );
      setWorktreeMergeInput(
        seeded.mode === WORKTREE_MODES.MANAGED ? (seeded.merge ?? false) : false
      );
      postWorkflowPropertiesUpdate({ worktree: seeded });
    },
    [globalSettings.worktree, postWorkflowPropertiesUpdate]
  );

  const handleWorktreeFieldChange = useCallback(
    (field: WorktreeField, value: string | boolean) => {
      const current = useSettingsStore.getState().getEffectiveWorktree();
      const currentConfig: WorktreeConfig =
        current !== false && current.mode === WORKTREE_MODES.MANAGED
          ? {
              mode: WORKTREE_MODES.MANAGED,
              base: current.base ?? "",
              setup: current.setup ?? "",
              merge: current.merge ?? false,
              keep: current.keep ?? false,
            }
          : {
              mode: WORKTREE_MODES.NAMED,
              branch:
                current !== false && current.mode === WORKTREE_MODES.NAMED
                  ? (current.branch ?? "")
                  : "",
              base: current !== false ? (current.base ?? "") : "",
              setup: current !== false ? (current.setup ?? "") : "",
            };
      const next = { ...currentConfig, [field]: value } as WorktreeConfig;
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("worktree", next);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "worktree",
        value: next,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleAgentChange = useCallback(
    (agent: string) => {
      // Optimistic update — store raw value (including "" for explicit "None")
      // so that getEffectiveAgent() can distinguish "no override" (undefined)
      // from "explicitly set to None" (""), which allows clearing a global default.
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("agent", agent);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "agent",
        value: agent,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleSkillsChange = useCallback(
    (skills: string[]) => {
      // Optimistic update — store raw array (including [] for explicit "None")
      // so that getEffectiveSkills() can distinguish "no override" (undefined)
      // from "explicitly cleared" ([]), which allows clearing a global default.
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("skills", skills);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "skills",
        value: skills,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleVarsChange = useCallback(
    (vars: Record<string, string>) => {
      // An empty map means the root property should be removed, not persisted
      // as an empty object. The extension's workflow-property path treats an
      // undefined value as an explicit delete.
      const nextVars = Object.keys(vars).length > 0 ? vars : undefined;
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("vars", nextVars);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "vars",
        value: nextVars,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleSecretsChange = useCallback(
    (secrets: string[]) => {
      // Inline !NAME references are authoritative and are represented as
      // locked selections, but remain prompt text rather than declarations.
      const explicitSecrets = filterExplicitSecretGrants(
        secrets,
        inlineSecretNames
      );
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("secrets", explicitSecrets);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "secrets",
        value: explicitSecrets,
      });
    },
    [inlineSecretNames, syncWorkflowPropertiesForUndo, vscode]
  );

  const handleResumeSessionChange = useCallback(
    (v: string) => {
      if (v === SESSION_ID_SENTINELS.FINAL_STEP) {
        setSessionIdInput(SESSION_ID_SENTINELS.FINAL_STEP);
        postWorkflowPropertiesUpdate({
          resumeSession: true,
          sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
        });
        return;
      }
      const checked = v === "yes";
      const updates: Partial<WorkflowProperties> = { resumeSession: checked };
      // Clear session ID when disabling or when switching away from Final Step Session.
      // Use "" instead of undefined so the value survives JSON serialization and the
      // extension receives the clear instruction (undefined is stripped by JSON.stringify).
      if (
        !checked ||
        workflowProperties.sessionId === SESSION_ID_SENTINELS.FINAL_STEP
      ) {
        setSessionIdInput("");
        updates.sessionId = "";
      }
      postWorkflowPropertiesUpdate(updates);
    },
    [postWorkflowPropertiesUpdate, workflowProperties.sessionId]
  );

  const handleSessionIdChange = useCallback(
    (value: string) => {
      setSessionIdInput(value);
      // Parse as number if valid integer, otherwise keep as string
      const parsedValue = /^\d+$/.test(value.trim())
        ? parseInt(value.trim(), 10)
        : value.trim() || undefined;

      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("sessionId", parsedValue);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "sessionId",
        value: parsedValue,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleMcpServersChange = useCallback(
    (newValue: McpServersValue) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty(
        "mcpServers",
        newValue as WorkflowProperties["mcpServers"]
      );
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "mcpServers",
        value: newValue,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleHooksChange = useCallback(
    (newValue: UserHookConfig[] | null | undefined) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("hooks", newValue);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "hooks",
        value: newValue,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleToolPermissionsChange = useCallback(
    (value: WorkflowProperties["toolPermissions"]) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("toolPermissions", value);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "toolPermissions",
        value: value,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleAdditionalArgsChange = useCallback(
    (value: string) => {
      const settingsStore = useSettingsStore.getState();
      // Store the empty string explicitly (not undefined) so the extension
      // receives the update and "Set as Default" can appear when the field
      // is cleared while a non-empty VS Code default exists.
      settingsStore.updateWorkflowProperty("additionalArgs", value);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "additionalArgs",
        value: value,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handlePriorContextChange = useCallback(
    (value: PriorContext | undefined) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("priorContext", value);
      syncWorkflowPropertiesForUndo();

      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "priorContext",
        value: value,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleEndConditionToggle = useCallback(
    (enabled: boolean) => {
      setEndConditionEnabled(enabled);

      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      if (!enabled) {
        // null is an explicit workflow-level disable. Using undefined would
        // inherit the global default again for a newly-created workflow.
        settingsStore.updateWorkflowProperty("endCondition", null);
        syncWorkflowPropertiesForUndo();
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "endCondition",
          value: null,
        });
      } else {
        // Initialize from global default if set, otherwise use hardcoded defaults
        const globalDefault =
          useSettingsStore.getState().globalSettings.defaultEndCondition;
        const defaultEndCondition = globalDefault ?? {
          script: "",
          returns: "true",
        };
        settingsStore.updateWorkflowProperty(
          "endCondition",
          defaultEndCondition
        );
        syncWorkflowPropertiesForUndo();
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "endCondition",
          value: defaultEndCondition,
        });
      }
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleEndConditionChange = useCallback(
    (updated: ScriptConditionValue) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty(
        "endCondition",
        updated as WorkflowProperties["endCondition"]
      );
      syncWorkflowPropertiesForUndo();
      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "endCondition",
        value: updated,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  // Pre-condition state
  const [preConditionEnabled, setPreConditionEnabled] = useState(
    effectivePreCondition !== null && effectivePreCondition !== undefined
  );

  // Sync preConditionEnabled with store
  useEffect(() => {
    setPreConditionEnabled(
      effectivePreCondition !== null && effectivePreCondition !== undefined
    );
  }, [effectivePreCondition]);

  const handlePreConditionToggle = useCallback(
    (enabled: boolean) => {
      setPreConditionEnabled(enabled);
      const settingsStore = useSettingsStore.getState();
      if (!enabled) {
        // null is an explicit workflow-level disable. Using undefined would
        // inherit the global default again for a newly-created workflow.
        settingsStore.updateWorkflowProperty("preCondition", null);
        syncWorkflowPropertiesForUndo();
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "preCondition",
          value: null,
        });
      } else {
        // Initialize from global default if set, otherwise use hardcoded defaults
        const globalDefault =
          useSettingsStore.getState().globalSettings.defaultPreCondition;
        const defaultPreCondition: import("@root/types/CtrlYokeTypes").PreCondition =
          globalDefault ?? {
            script: "",
            onFail: CONDITION_ACTIONS.SKIP_PROMPT,
          };
        settingsStore.updateWorkflowProperty(
          "preCondition",
          defaultPreCondition
        );
        syncWorkflowPropertiesForUndo();
        postWorkflowDefinitionMutation(vscode, {
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "preCondition",
          value: defaultPreCondition,
        });
      }
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handlePreConditionChange = useCallback(
    (updated: ScriptConditionValue) => {
      useSettingsStore
        .getState()
        .updateWorkflowProperty(
          "preCondition",
          updated as import("@root/types/CtrlYokeTypes").PreCondition
        );
      syncWorkflowPropertiesForUndo();
      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "preCondition",
        value: updated,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleErrorBehaviorChange = useCallback(
    (updated: ErrorBehavior) => {
      useSettingsStore
        .getState()
        .updateWorkflowProperty(
          "errorBehavior",
          updated as WorkflowProperties["errorBehavior"]
        );
      syncWorkflowPropertiesForUndo();
      postWorkflowDefinitionMutation(vscode, {
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "errorBehavior",
        value: updated,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleSetAsDefault = useCallback(
    (property: string, value: unknown, harness?: string) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.SET_AS_DEFAULT,
        property,
        value,
        harness:
          harness ?? (property === "model" ? effectiveHarness : undefined),
      });
    },
    [vscode, effectiveHarness]
  );

  const tabOverrides = useDrawerTabOverrides(
    workflowProperties,
    globalSettings,
    undefined,
    permissionDiagnostics.length > 0,
    hookDiagnostics.length > 0,
    mcpDiagnostics.length > 0
  );

  const handleResetAllToDefault = useCallback(() => {
    const globalHarness = globalSettings.harness as string;
    const resetWorktree = globalSettings.worktree;
    const updates: Partial<WorkflowProperties> = {
      harness: globalHarness,
      model: globalSettings.harnessDefaultModels[globalHarness],
      agent: globalSettings.agent,
      skills: globalSettings.skills ?? [],
      secrets: globalSettings.secrets ?? [],
      vars: undefined,
      additionalArgs:
        globalSettings.harnessDefaultAdditionalArgs[globalHarness] ?? "",
      executionMode: globalSettings.executionMode,
      resumeSession: globalSettings.resumeSession,
      sessionId: "",
      priorContext:
        globalSettings.priorContext as WorkflowProperties["priorContext"],
      mcpServers: globalSettings.mcpServers as WorkflowProperties["mcpServers"],
      toolPermissions:
        globalSettings.toolPermissions as WorkflowProperties["toolPermissions"],
      hooks: globalSettings.hooks as WorkflowProperties["hooks"],
      errorBehavior:
        globalSettings.defaultErrorBehavior as WorkflowProperties["errorBehavior"],
      endCondition:
        globalSettings.defaultEndCondition as WorkflowProperties["endCondition"],
      preCondition:
        globalSettings.defaultPreCondition as WorkflowProperties["preCondition"],
      worktree:
        resetWorktree?.mode === WORKTREE_MODES.NONE
          ? false
          : resetWorktree?.mode === WORKTREE_MODES.MANAGED
            ? {
                mode: WORKTREE_MODES.MANAGED,
                base: resetWorktree.base,
                setup: resetWorktree.setup,
                keep: resetWorktree.keep,
                merge: resetWorktree.merge,
              }
            : {
                mode: WORKTREE_MODES.NAMED,
                branch: resetWorktree?.branch ?? "",
                base: resetWorktree?.base,
                setup: resetWorktree?.setup,
              },
    };
    setSessionIdInput("");
    setWorktreeMode(resetWorktree?.mode ?? WORKTREE_MODES.NONE);
    setWorktreeBranchInput(
      resetWorktree?.mode === WORKTREE_MODES.NAMED
        ? (resetWorktree.branch ?? "")
        : ""
    );
    setWorktreeBaseInput(
      resetWorktree?.mode === WORKTREE_MODES.NAMED ||
        resetWorktree?.mode === WORKTREE_MODES.MANAGED
        ? (resetWorktree.base ?? "")
        : ""
    );
    setWorktreeSetupInput(
      resetWorktree?.mode === WORKTREE_MODES.NAMED ||
        resetWorktree?.mode === WORKTREE_MODES.MANAGED
        ? (resetWorktree.setup ?? "")
        : ""
    );
    setWorktreeMergeInput(
      resetWorktree?.mode === WORKTREE_MODES.MANAGED
        ? (resetWorktree.merge ?? false)
        : false
    );
    setWorktreeKeepInput(
      resetWorktree?.mode === WORKTREE_MODES.MANAGED
        ? (resetWorktree.keep ?? false)
        : false
    );
    setEndConditionEnabled(
      globalSettings.defaultEndCondition !== null &&
        globalSettings.defaultEndCondition !== undefined
    );
    setPreConditionEnabled(
      globalSettings.defaultPreCondition !== null &&
        globalSettings.defaultPreCondition !== undefined
    );
    postWorkflowPropertiesUpdate(updates);
  }, [globalSettings, postWorkflowPropertiesUpdate]);

  const worktreeBranchDiagnostics =
    worktreeMode === WORKTREE_MODES.NAMED && !worktreeBranchInput.trim()
      ? [
          {
            severity: "error" as const,
            message: "Branch is required for named worktree mode.",
          },
        ]
      : [];

  // Permissions page derived values
  const toolPerms = workflowProperties.toolPermissions;
  const permMode =
    toolPerms === null
      ? PERMISSION_MODES.NONE
      : (toolPerms?.mode ??
        globalSettings.toolPermissions.mode ??
        PERMISSION_MODES.ALLOW_ALL);
  const effectiveErrorBehavior = workflowProperties.errorBehavior ??
    globalSettings.defaultErrorBehavior ?? { onError: "stop" as const };
  // Fall back to global settings when workflow doesn't have lists yet
  const effectiveAllowedTools =
    toolPerms?.allowedTools ?? globalSettings.toolPermissions.allowedTools;
  const effectiveDeniedTools =
    toolPerms?.deniedTools ?? globalSettings.toolPermissions.deniedTools;

  // PermissionListEditor echoes lossless text on every edit so CodeMirror can
  // keep blank lines/cursor state intact. Keep that draft local and persist the
  // cleaned list only from its blur callback.
  const [allowedToolsInput, setAllowedToolsInput] = useState<string[]>(
    () => effectiveAllowedTools ?? []
  );
  const [deniedToolsInput, setDeniedToolsInput] = useState<string[]>(
    () => effectiveDeniedTools ?? []
  );

  useEffect(() => {
    setAllowedToolsInput(effectiveAllowedTools ?? []);
  }, [effectiveAllowedTools]);

  useEffect(() => {
    setDeniedToolsInput(effectiveDeniedTools ?? []);
  }, [effectiveDeniedTools]);

  // ============================================================================
  // RENDER
  // ============================================================================

  // In mobile mode (onRequestClose present), disable all collapse interactions —
  // the panel is a full-screen overlay and has its own close button.
  const isMobileMode = Boolean(onRequestClose);

  const reviewCompatibility = useCallback(() => {
    setActivePage(DRAWER_PAGES.PERMISSIONS);
    window.requestAnimationFrame(() => {
      const firstProperty = firstCompatibilityProperty(permissionDiagnostics);
      document.getElementById(firstProperty)?.focus();
    });
  }, [permissionDiagnostics]);

  function handleToggle() {
    if (isMobileMode) return;
    triggerPanelAnimation();
    toggleSettingsCollapse();
  }

  if (settingsCollapsed && !isMobileMode) {
    return (
      <PanelBar
        orientation={panelBarOrientation}
        icon="settings"
        title="Workflow Properties"
        onClick={handleToggle}
      />
    );
  }

  return (
    <div
      ref={drawerRef}
      className="flex flex-col h-full bg-sidebar-bg overflow-x-hidden"
    >
      {/* Section Header — clickable to collapse in desktop mode; non-interactive in mobile */}
      <div
        className={`flex items-center justify-between h-[30px] px-2 border-b border-panel-border${isMobileMode ? "" : " cursor-pointer select-none"}`}
        onClick={isMobileMode ? undefined : handleToggle}
        role={isMobileMode ? undefined : "button"}
        aria-label={isMobileMode ? undefined : "Collapse workflow properties"}
        tabIndex={isMobileMode ? undefined : 0}
        onKeyDown={
          isMobileMode
            ? undefined
            : (e) => e.key === KEYBOARD_KEYS.ENTER && handleToggle()
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 text-description-fg hover:text-foreground transition-colors">
          {!isMobileMode && (
            <i className="codicon codicon-chevron-right text-xs rotate-90 transition-transform duration-150" />
          )}
          <i className="codicon codicon-settings text-sm" />
          <span className="ml-0.5 min-w-0 truncate whitespace-nowrap text-xs font-semibold uppercase tracking-wide">
            Workflow Properties
          </span>
          <button
            type="button"
            className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-60 transition-all hover:bg-toolbar-hover-bg hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              handleResetAllToDefault();
            }}
            title="Reset all to defaults"
            aria-label="Reset all to defaults"
          >
            <i className="codicon codicon-debug-restart text-xs" />
          </button>
          <button
            type="button"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-60 transition-all hover:bg-toolbar-hover-bg hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              setWorkflowPortabilityReportOpen(true);
            }}
            title="Review workflow portability"
            aria-label="Review workflow portability"
          >
            <i className="codicon codicon-inspect text-xs" />
          </button>
        </div>
        {onRequestClose && (
          <ExitButton
            onClick={(e) => {
              e.stopPropagation();
              onRequestClose();
            }}
            title="Close workflow properties"
            aria-label="Close workflow properties"
          />
        )}
      </div>

      {/* Body - Scrollable (pointer-events disabled in CLI watch mode) */}
      <div
        className={`flex-1 overflow-y-auto${activePage === DRAWER_PAGES.MCP ? " flex flex-col" : ""}${isExternallyManaged || isViewingDeletedWorkflow || isSystemGeneratedWorkflow ? " pointer-events-none opacity-60 select-none" : ""}`}
      >
        <div
          className={`px-4 py-2${activePage === DRAWER_PAGES.MCP ? " flex flex-col flex-1 min-h-0 gap-2" : ` space-y-2${activePage === DRAWER_PAGES.PERMISSIONS ? " min-h-full flex flex-col" : ""}`}`}
        >
          {activePage === DRAWER_PAGES.HARNESS && (
            <>
              {/* Row 1: Harness + Model */}
              <DrawerRow narrow={isNarrow}>
                <FormField
                  label="Harness"
                  htmlFor="settings-harness"
                  description="AI harness for execution"
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="harness"
                      show={isDifferentFromGlobal("harness")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "harness",
                          workflowProperties.harness
                        )
                      }
                    />
                  }
                >
                  <HarnessDropdown
                    id="settings-harness"
                    value={effectiveHarness}
                    onChange={handleHarnessChange}
                    harnessStatus={harnessStatus}
                    hiddenValues={
                      hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? []
                    }
                    onHideOption={(v) =>
                      hideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
                    }
                    onUnhideOption={(v) =>
                      unhideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
                    }
                  />
                  <CompatibilitySummary
                    diagnostics={permissionDiagnostics}
                    onReview={reviewCompatibility}
                  />
                </FormField>

                <FormField
                  label="Model"
                  htmlFor="settings-model"
                  description="AI model for execution"
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="model"
                      show={isDifferentFromGlobal("model")}
                      onSetDefault={() =>
                        handleSetAsDefault("model", workflowProperties.model)
                      }
                    />
                  }
                >
                  <CustomSelect
                    id="settings-model"
                    value={effectiveModel}
                    onChange={handleModelChange}
                    options={
                      currentHarnessModels.length === 0
                        ? [
                            {
                              value: "",
                              label: "Loading models...",
                              disabled: true,
                            },
                          ]
                        : currentHarnessModels.map((m) => ({
                            value: m.value,
                            label: m.label,
                          }))
                    }
                    namespace={modelNamespace}
                    hiddenValues={hiddenDropdownOptions[modelNamespace] ?? []}
                    onHideOption={(v) => hideDropdownOption(modelNamespace, v)}
                    onUnhideOption={(v) =>
                      unhideDropdownOption(modelNamespace, v)
                    }
                    nonHideableValues={["default", ""]}
                    warning={modelWarn ?? undefined}
                  />
                </FormField>
              </DrawerRow>

              {/* Row 2: Agent + Skills */}
              <DrawerRow narrow={isNarrow}>
                <FormField
                  label="Agent"
                  htmlFor="settings-agent"
                  description="Custom agent file (.agent.md)"
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="agent"
                      show={isDifferentFromGlobal("agent")}
                      onSetDefault={() =>
                        handleSetAsDefault("agent", workflowProperties.agent)
                      }
                    />
                  }
                >
                  <CustomSelect
                    id="settings-agent"
                    value={effectiveAgent || ""}
                    onChange={handleAgentChange}
                    options={[
                      { value: "", label: "None" },
                      ...availableAgents.map((agent) =>
                        toAgentSelectOption(agent, agent.name || agent.path)
                      ),
                    ]}
                    namespace={DROPDOWN_NAMESPACES.AGENT}
                    hiddenValues={
                      hiddenDropdownOptions[DROPDOWN_NAMESPACES.AGENT] ?? []
                    }
                    onHideOption={(v) =>
                      hideDropdownOption(DROPDOWN_NAMESPACES.AGENT, v)
                    }
                    onUnhideOption={(v) =>
                      unhideDropdownOption(DROPDOWN_NAMESPACES.AGENT, v)
                    }
                    nonHideableValues={[]}
                    warning={agentWarn ?? undefined}
                  />
                </FormField>

                <FormField
                  label="Skills"
                  htmlFor="settings-skills"
                  description="Attach skills (frontmatter only, progressive disclosure)"
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="skills"
                      show={isDifferentFromGlobal("skills")}
                      onSetDefault={() =>
                        handleSetAsDefault("skills", workflowProperties.skills)
                      }
                    />
                  }
                >
                  <MultiCheckboxDropdown
                    id="settings-skills"
                    selectedValues={effectiveSkills}
                    onChange={handleSkillsChange}
                    options={availableSkills.map((s) => ({
                      value: s.name,
                      label: s.name,
                      description: s.description || undefined,
                    }))}
                    placeholder="No skills selected"
                    namespace={DROPDOWN_NAMESPACES.SKILLS}
                    hiddenValues={
                      hiddenDropdownOptions[DROPDOWN_NAMESPACES.SKILLS] ?? []
                    }
                    onHideOption={(v) =>
                      hideDropdownOption(DROPDOWN_NAMESPACES.SKILLS, v)
                    }
                    onUnhideOption={(v) =>
                      unhideDropdownOption(DROPDOWN_NAMESPACES.SKILLS, v)
                    }
                    warning={skillsWarn ?? undefined}
                  />
                  {effectiveSkills.length > 0 && (
                    <p className="text-xxs text-description-fg mt-0.5">
                      Active: {effectiveSkills.join(", ")}
                    </p>
                  )}
                </FormField>
              </DrawerRow>

              {/* Row 3: Additional Args + Execution Mode */}
              <DrawerRow narrow={isNarrow}>
                <FormField
                  label="Additional Args"
                  htmlFor="settings-append-args"
                  description="Extra CLI flags appended to ctrlyoke's standard argument set. Only applies to CLI harnesses."
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="additionalArgs"
                      show={isDifferentFromGlobal("additionalArgs")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "additionalArgs",
                          workflowProperties.additionalArgs,
                          effectiveHarness
                        )
                      }
                    />
                  }
                >
                  <AdditionalArgsEditor
                    id="settings-append-args"
                    aria-label="Additional arguments"
                    harnessId={effectiveHarness}
                    value={additionalArgsInput}
                    onChange={setAdditionalArgsInput}
                    onBlur={() =>
                      handleAdditionalArgsChange(additionalArgsInput)
                    }
                    className="w-full text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                  />
                </FormField>
                <FormField
                  label="Execution Mode"
                  htmlFor="settings-execution-mode"
                  description={EXECUTION_MODE_HELP_TEXT}
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="executionMode"
                      show={isDifferentFromGlobal("executionMode")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "executionMode",
                          workflowProperties.executionMode
                        )
                      }
                    />
                  }
                >
                  <CustomSelect
                    id="settings-execution-mode"
                    value={effectiveExecutionMode}
                    onChange={handleExecutionModeChange}
                    options={EXECUTION_MODE_OPTIONS}
                  />
                </FormField>
              </DrawerRow>

              {/* Row 4: Workflow worktree selection */}
              <DrawerRow narrow={isNarrow}>
                <FormField
                  label="Worktree"
                  htmlFor="settings-worktree-mode"
                  description={WORKTREE_MODE_HELP_TEXT}
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="worktree"
                      show={isDifferentFromGlobal("worktree")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "worktree",
                          workflowProperties.worktree
                        )
                      }
                    />
                  }
                >
                  <CustomSelect
                    id="settings-worktree-mode"
                    value={worktreeMode}
                    onChange={handleWorktreeModeChange}
                    options={WORKTREE_MODE_OPTIONS}
                  />
                </FormField>
              </DrawerRow>

              <AnimatedSection visible={worktreeMode !== WORKTREE_MODES.NONE}>
                <DrawerRow narrow={isNarrow}>
                  {worktreeMode === WORKTREE_MODES.NAMED && (
                    <FormField
                      label="Branch"
                      htmlFor="settings-worktree-branch"
                      description="Existing or new local Git branch for the named worktree."
                    >
                      <BranchNameEditor
                        id="settings-worktree-branch"
                        aria-label="Worktree branch"
                        value={worktreeBranchInput}
                        onChange={setWorktreeBranchInput}
                        onBlur={() =>
                          handleWorktreeFieldChange(
                            "branch",
                            worktreeBranchInput
                          )
                        }
                        aria-describedby={
                          worktreeBranchDiagnostics.length > 0
                            ? "settings-worktree-branch-diagnostic"
                            : undefined
                        }
                        className={`w-full bg-input-bg text-input-fg border ${fieldValidationBorderClass(worktreeBranchDiagnostics)} rounded focus:outline-none focus:border-focus-border font-mono`}
                      />
                      <FieldDiagnostic
                        id="settings-worktree-branch-diagnostic"
                        diagnostics={worktreeBranchDiagnostics}
                      />
                    </FormField>
                  )}
                  <FormField
                    label="Base"
                    htmlFor="settings-worktree-base"
                    description="Optional Git ref used as the starting point for a new worktree."
                  >
                    <BranchNameEditor
                      id="settings-worktree-base"
                      aria-label="Worktree base"
                      value={worktreeBaseInput}
                      onChange={setWorktreeBaseInput}
                      onBlur={() =>
                        handleWorktreeFieldChange("base", worktreeBaseInput)
                      }
                      placeholder="Current branch (HEAD)"
                      className="w-full bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                    />
                  </FormField>
                  <FormField
                    label="Setup"
                    htmlFor="settings-worktree-setup"
                    description="Optional command run after a new worktree is created. Setup is outside step errorBehavior; a failure blocks the worktree and the next Run retries it."
                  >
                    <ScriptCommandEditor
                      id="settings-worktree-setup"
                      aria-label="Worktree setup"
                      value={worktreeSetupInput}
                      onChange={setWorktreeSetupInput}
                      onBlur={() =>
                        handleWorktreeFieldChange("setup", worktreeSetupInput)
                      }
                      placeholder="e.g. npm ci"
                      className="w-full text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                    />
                  </FormField>
                  {worktreeMode === WORKTREE_MODES.MANAGED && (
                    <>
                      <FormField
                        label="Keep directory"
                        htmlFor="settings-worktree-keep"
                        description={WORKTREE_KEEP_HELP_TEXT}
                      >
                        <label className="flex items-center gap-2 min-h-7 text-xs text-foreground">
                          <input
                            type="checkbox"
                            id="settings-worktree-keep"
                            aria-label="Keep directory"
                            checked={worktreeKeepInput}
                            onChange={(event) => {
                              const keep = event.target.checked;
                              setWorktreeKeepInput(keep);
                              handleWorktreeFieldChange("keep", keep);
                            }}
                            className="accent-button-bg"
                          />
                          Keep managed worktree for review and undo
                        </label>
                      </FormField>
                      <FormField
                        label="Merge"
                        htmlFor="settings-worktree-merge"
                        description="Merge the managed branch into the working checkout after every run."
                      >
                        <label className="flex items-center gap-2 min-h-7 text-xs text-foreground">
                          <input
                            type="checkbox"
                            id="settings-worktree-merge"
                            aria-label="Merge"
                            checked={worktreeMergeInput}
                            onChange={(event) => {
                              const merge = event.target.checked;
                              setWorktreeMergeInput(merge);
                              handleWorktreeFieldChange("merge", merge);
                            }}
                            className="accent-button-bg"
                          />
                          Merge into the working checkout after every run
                        </label>
                      </FormField>
                    </>
                  )}
                </DrawerRow>
              </AnimatedSection>

              {workflowProperties.worktree === undefined &&
                worktreeMode !== WORKTREE_MODES.NONE && (
                  <p className="text-xxs text-warning-fg" role="status">
                    This worktree default is inherited from settings.
                    {worktreeMode === WORKTREE_MODES.NAMED &&
                      " It uses one workspace-wide exclusive lease, so concurrent runs of this workflow serialize on the same branch."}
                  </p>
                )}
            </>
          )}

          {activePage === DRAWER_PAGES.CONTEXT && (
            <>
              {/* Row 1: Resume Session (with paired Session ID) + Prior Context */}
              <DrawerRow narrow={isNarrow}>
                <FormField
                  label="Resume Session"
                  htmlFor="settings-resume-session"
                  description="Resume Session continues existing session. Session ID below resumes a specific session or reuses another prompt's session (by number). 'Final Step Session' resumes the session established by the Final Step gate."
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="resumeSession"
                      show={isDifferentFromGlobal("resumeSession")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "resumeSession",
                          workflowProperties.resumeSession
                        )
                      }
                    />
                  }
                >
                  <CustomSelect
                    id="settings-resume-session"
                    value={
                      workflowProperties.sessionId ===
                        SESSION_ID_SENTINELS.FINAL_STEP &&
                      effectiveResumeSession
                        ? SESSION_ID_SENTINELS.FINAL_STEP
                        : effectiveResumeSession
                          ? "yes"
                          : "no"
                    }
                    onChange={handleResumeSessionChange}
                    options={[...getResumeSessionOptions()]}
                  />
                  {/* Session ID input — always visible, grayed out when not applicable */}
                  <div
                    className={`mt-1 ${
                      effectiveResumeSession &&
                      workflowProperties.sessionId !==
                        SESSION_ID_SENTINELS.FINAL_STEP
                        ? ""
                        : "opacity-50 pointer-events-none"
                    }`}
                    title={
                      !effectiveResumeSession
                        ? "Enable Resume Session to specify a Session ID"
                        : workflowProperties.sessionId ===
                            SESSION_ID_SENTINELS.FINAL_STEP
                          ? "Using Final Step Session — no explicit Session ID needed"
                          : undefined
                    }
                  >
                    <input
                      type="text"
                      id="settings-session-id"
                      aria-label="Session ID"
                      value={sessionIdInput}
                      onChange={(e) => setSessionIdInput(e.target.value)}
                      onBlur={(e) => handleSessionIdChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === KEYBOARD_KEYS.ENTER)
                          e.currentTarget.blur();
                      }}
                      placeholder="Session ID, prompt number, or blank for auto-resume"
                      className="w-full px-2 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border h-7"
                      title="Enter session ID (UUID), prompt number (e.g., 1, 2, 3), or leave blank for auto-resume. Auto-resume continues the most recent session from an earlier prompt using the same harness."
                    />
                    {effectiveResumeSession &&
                      workflowProperties.sessionId !==
                        SESSION_ID_SENTINELS.FINAL_STEP &&
                      !sessionIdInput && (
                        <AutoResumeStatusRow preview={autoResumePreview} />
                      )}
                  </div>
                </FormField>

                <FormField
                  label="Prior Context"
                  htmlFor="settings-prior-context"
                  description="Send prior step outputs with the prompt"
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="priorContext"
                      show={isDifferentFromGlobal("priorContext")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "priorContext",
                          workflowProperties.priorContext
                        )
                      }
                    />
                  }
                >
                  <PriorContextSelect
                    id="settings-prior-context"
                    value={effectivePriorContext}
                    onChange={handlePriorContextChange}
                  />
                </FormField>
              </DrawerRow>

              <FormField
                label="Variables"
                description="Workflow-level defaults for {{name}} substitution in prompt text, model, additional arguments, hook command/env, pre- and end-condition script/env and retry prompts, script-step script/env, and worktree setup commands. CLI --var values override these defaults. Unresolved placeholders remain literal text and are reported as an advisory."
              >
                <KeyValueMapEditor
                  label="name=value"
                  id="settings-vars"
                  ariaLabel="Variables"
                  value={workflowProperties.vars ?? {}}
                  onChange={handleVarsChange}
                  rows={4}
                />
              </FormField>
            </>
          )}

          {activePage === DRAWER_PAGES.VALIDATION && (
            <div className="space-y-4">
              {/* Pre-Condition Section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label
                    htmlFor="settings-pre-condition-enabled"
                    className="flex items-center gap-2 text-xs font-semibold uppercase text-description-fg cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      id="settings-pre-condition-enabled"
                      aria-label="Enable Pre-Condition"
                      checked={preConditionEnabled}
                      onChange={(e) =>
                        handlePreConditionToggle(e.target.checked)
                      }
                      className="w-4 h-4 accent-focus-border cursor-pointer mt-1"
                    />
                    Pre-Condition
                  </label>
                  {preConditionEnabled && (
                    <SetAsDefaultButton
                      property="preCondition"
                      show={isDifferentFromGlobal("preCondition")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "preCondition",
                          workflowProperties.preCondition
                        )
                      }
                    />
                  )}
                </div>
                <p className="text-xs text-description-fg mb-3">
                  Runs a script before each prompt. Use to gate execution based
                  on a condition.
                </p>

                {/* Pre-condition fields — animated slide-down on show/hide */}
                <AnimatedSection visible={preConditionEnabled}>
                  <div className="space-y-3">
                    <ScriptConditionEditor
                      variant="preCondition"
                      value={
                        effectivePreCondition as
                          | ScriptConditionValue
                          | null
                          | undefined
                      }
                      onChange={handlePreConditionChange}
                      narrow={isNarrow}
                      disabled={!preConditionEnabled}
                      idPrefix="settings-pre"
                    />
                  </div>
                </AnimatedSection>
              </div>

              {/* End Condition Section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label
                    htmlFor="settings-end-condition-enabled"
                    className="flex items-center gap-2 text-xs font-semibold uppercase text-description-fg cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      id="settings-end-condition-enabled"
                      aria-label="Enable End Condition"
                      checked={endConditionEnabled}
                      onChange={(e) =>
                        handleEndConditionToggle(e.target.checked)
                      }
                      className="w-4 h-4 accent-focus-border cursor-pointer mt-1"
                    />
                    End Condition
                  </label>
                  {endConditionEnabled && (
                    <SetAsDefaultButton
                      property="endCondition"
                      show={isDifferentFromGlobal("endCondition")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "endCondition",
                          workflowProperties.endCondition
                        )
                      }
                    />
                  )}
                </div>
                <p className="text-xs text-description-fg mb-3">
                  Use to validate the prompt&apos;s work and determine whether
                  it should be re-run.
                </p>

                {/* End condition fields — animated slide-down on show/hide */}
                <AnimatedSection visible={endConditionEnabled}>
                  <div className="space-y-3">
                    <ScriptConditionEditor
                      variant="endCondition"
                      value={
                        effectiveEndCondition as
                          | ScriptConditionValue
                          | null
                          | undefined
                      }
                      onChange={handleEndConditionChange}
                      narrow={isNarrow}
                      disabled={!endConditionEnabled}
                      idPrefix="settings-end"
                    />
                  </div>
                </AnimatedSection>
              </div>

              {/* Error Behavior Section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label
                    htmlFor="settings-error-on-error"
                    className="text-xs font-semibold uppercase text-description-fg"
                  >
                    Error Behavior
                  </label>
                  <SetAsDefaultButton
                    property="errorBehavior"
                    show={isDifferentFromGlobal("errorBehavior")}
                    onSetDefault={() =>
                      handleSetAsDefault(
                        "errorBehavior",
                        workflowProperties.errorBehavior
                      )
                    }
                  />
                </div>
                <p className="text-xs text-description-fg mb-3">
                  What to do if a pre-condition, prompt/harness, end-condition,
                  or script step encounters an internal error: stop, retry, or
                  continue.
                </p>
                <ErrorBehaviorEditor
                  value={effectiveErrorBehavior}
                  onChange={handleErrorBehaviorChange}
                  idPrefix="settings-error"
                />
              </div>
            </div>
          )}

          {activePage === DRAWER_PAGES.MCP && (
            <div className="flex-1 flex flex-col min-h-0">
              <FormField
                label="MCP Servers"
                description="MCP servers to attach to the harness for this workflow. Include ctrlyoke to enable dynamic queue extension. Add custom McpServerConfig entries for additional MCP servers. Set to None to explicitly disable MCP injection."
                className="flex-1 min-h-0"
                setAsDefaultButton={
                  <SetAsDefaultButton
                    property="mcpServers"
                    show={isDifferentFromGlobal("mcpServers")}
                    onSetDefault={() =>
                      handleSetAsDefault(
                        "mcpServers",
                        workflowProperties.mcpServers
                      )
                    }
                  />
                }
              >
                <McpServersEditor
                  controlId="settings-mcp-servers"
                  value={effectiveMcpServers as McpServersValue}
                  onChange={handleMcpServersChange}
                  showDefault={false}
                  fillHeight={true}
                  diagnostics={mcpDiagnostics}
                />
              </FormField>
            </div>
          )}

          {activePage === DRAWER_PAGES.PERMISSIONS && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex-1 flex flex-col min-h-0">
                {/* Permission Mode */}
                <FormField
                  label="Permission Mode"
                  htmlFor="settings-permission-mode"
                  description="Tool permission mode for CLI harnesses"
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="toolPermissions"
                      show={isDifferentFromGlobal("toolPermissions")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "toolPermissions",
                          workflowProperties.toolPermissions
                        )
                      }
                    />
                  }
                >
                  <CustomSelect
                    id="settings-permission-mode"
                    value={permMode}
                    onChange={(mode) => {
                      handleToolPermissionsChange({
                        mode: mode as ToolPermissionMode,
                        allowedTools: allowedToolsInput,
                        deniedTools: deniedToolsInput,
                      });
                    }}
                    options={PERMISSION_MODE_OPTIONS}
                    warning={modeDiagnostics[0]?.message}
                    warningId="settings-permission-mode-diagnostic"
                  />
                </FormField>

                <FormField
                  label="Secrets"
                  htmlFor="settings-secrets"
                  description="Grant named credentials to this workflow. Inline !NAME references in prompt text are always granted."
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="secrets"
                      show={isDifferentFromGlobal("secrets")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "secrets",
                          workflowProperties.secrets
                        )
                      }
                    />
                  }
                >
                  <MultiCheckboxDropdown
                    id="settings-secrets"
                    selectedValues={resolvedSecretGrants}
                    onChange={handleSecretsChange}
                    options={secretOptions}
                    placeholder="No secrets granted"
                    lockedValues={inlineSecretGrantNames}
                    nonHideableValues={secretNames}
                    warning={
                      unresolvedSecretNames.length > 0
                        ? `${unresolvedSecretNames.length} unresolved secret${unresolvedSecretNames.length === 1 ? "" : "s"}`
                        : undefined
                    }
                  />
                  {resolvedSecretGrants.length > 0 && (
                    <p className="mt-0.5 text-xxs text-description-fg">
                      Active: {resolvedSecretGrants.join(", ")}
                    </p>
                  )}
                  <FieldDiagnostic
                    id="settings-secrets-diagnostic"
                    diagnostics={unresolvedSecretDiagnostics}
                  />
                </FormField>

                {/* Allowed / Denied Tools textareas — always visible, disabled by mode */}
                <div className="flex-1 flex flex-col gap-2 min-h-0 mt-2">
                  <FormField
                    label="Allowed Tools"
                    htmlFor="settings-allowed-tools"
                    description="Tool patterns to allow (one per line). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode; Qwen is inline and OpenCode uses OPENCODE_CONFIG_CONTENT."
                    className="flex-1 min-h-0"
                    setAsDefaultButton={
                      <SetAsDefaultButton
                        property="toolPermissions.allowedTools"
                        show={
                          JSON.stringify(effectiveAllowedTools) !==
                          JSON.stringify(
                            globalSettings.toolPermissions.allowedTools ?? []
                          )
                        }
                        onSetDefault={() =>
                          handleSetAsDefault("toolPermissions", {
                            ...(workflowProperties.toolPermissions ?? {}),
                            allowedTools: effectiveAllowedTools,
                            deniedTools: effectiveDeniedTools,
                          })
                        }
                      />
                    }
                  >
                    <PermissionListEditor
                      id="settings-allowed-tools"
                      aria-label="Allowed Tools"
                      value={allowedToolsInput}
                      onChange={setAllowedToolsInput}
                      onBlur={(allowedTools) =>
                        handleToolPermissionsChange({
                          ...(toolPerms || {}),
                          allowedTools,
                          deniedTools: deniedToolsInput,
                        })
                      }
                      disabled={permMode !== PERMISSION_MODES.CUSTOM}
                      aria-describedby={
                        allowedFieldDiagnostics.length > 0
                          ? "settings-allowed-tools-diagnostic"
                          : undefined
                      }
                      placeholder={"read\nglob\ngrep"}
                      fontSize="0.75rem"
                      className={`flex-1 min-h-[60px] w-full text-xs bg-input-bg text-input-fg border ${fieldValidationBorderClass(allowedFieldDiagnostics)} rounded focus:outline-none focus:border-focus-border font-mono${
                        permMode !== PERMISSION_MODES.CUSTOM
                          ? " opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                    />
                    <FieldDiagnostic
                      id="settings-allowed-tools-diagnostic"
                      diagnostics={
                        allowedAggregate
                          ? [allowedAggregate]
                          : allowedDiagnostics.map((diagnostic) =>
                              toFieldDiagnostic(
                                diagnostic,
                                formatCompatibilitySource(diagnostic.sourceTier)
                              )
                            )
                      }
                    />
                  </FormField>

                  <FormField
                    label="Denied Tools"
                    htmlFor="settings-denied-tools"
                    description="Tool patterns to deny (one per line, takes precedence over allow list). Codex and Antigravity do not enforce these lists."
                    className="flex-1 min-h-0"
                    setAsDefaultButton={
                      <SetAsDefaultButton
                        property="toolPermissions.deniedTools"
                        show={
                          JSON.stringify(effectiveDeniedTools) !==
                          JSON.stringify(
                            globalSettings.toolPermissions.deniedTools ?? []
                          )
                        }
                        onSetDefault={() =>
                          handleSetAsDefault("toolPermissions", {
                            ...(workflowProperties.toolPermissions ?? {}),
                            allowedTools: effectiveAllowedTools,
                            deniedTools: effectiveDeniedTools,
                          })
                        }
                      />
                    }
                  >
                    <PermissionListEditor
                      id="settings-denied-tools"
                      aria-label="Denied Tools"
                      value={deniedToolsInput}
                      onChange={setDeniedToolsInput}
                      onBlur={(deniedTools) =>
                        handleToolPermissionsChange({
                          ...(toolPerms || {}),
                          allowedTools: allowedToolsInput,
                          deniedTools,
                        })
                      }
                      disabled={
                        permMode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
                        permMode === PERMISSION_MODES.NONE
                      }
                      aria-describedby={
                        deniedFieldDiagnostics.length > 0
                          ? "settings-denied-tools-diagnostic"
                          : undefined
                      }
                      placeholder={"shell(rm:*)\nwrite"}
                      fontSize="0.75rem"
                      className={`flex-1 min-h-[60px] w-full text-xs bg-input-bg text-input-fg border ${fieldValidationBorderClass(deniedFieldDiagnostics)} rounded focus:outline-none focus:border-focus-border font-mono${
                        permMode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
                        permMode === PERMISSION_MODES.NONE
                          ? " opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                    />
                    <FieldDiagnostic
                      id="settings-denied-tools-diagnostic"
                      diagnostics={
                        deniedAggregate
                          ? [deniedAggregate]
                          : deniedDiagnostics.map((diagnostic) =>
                              toFieldDiagnostic(
                                diagnostic,
                                formatCompatibilitySource(diagnostic.sourceTier)
                              )
                            )
                      }
                    />
                  </FormField>
                </div>
              </div>
            </div>
          )}

          {activePage === DRAWER_PAGES.HOOKS && (
            <>
              <FormField
                label="User Hooks"
                description="User-defined hooks to run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness."
                setAsDefaultButton={
                  <SetAsDefaultButton
                    property="hooks"
                    show={isDifferentFromGlobal("hooks")}
                    onSetDefault={() =>
                      handleSetAsDefault("hooks", workflowProperties.hooks)
                    }
                  />
                }
              >
                <HooksEditor
                  value={effectiveHooks}
                  onChange={handleHooksChange}
                  showDefault={false}
                  diagnostics={hookDiagnostics}
                />
              </FormField>
            </>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <DrawerTabBar
        activeTab={activePage}
        onTabChange={setActivePage}
        harnessId={effectiveHarness as HarnessId}
        isNarrow={isNarrow}
        tabOverrides={tabOverrides}
      />
    </div>
  );
};

WorkflowPropertiesPanelInner.displayName = "WorkflowPropertiesPanel";

export const WorkflowPropertiesPanel = React.memo(WorkflowPropertiesPanelInner);
