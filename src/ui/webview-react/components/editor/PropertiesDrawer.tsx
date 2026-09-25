import React, { useCallback, useMemo } from "react";
import type { ErrorBehavior } from "@root/types/CtrlYokeTypes";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { useCompatibilityDiagnostics } from "../../hooks/useCompatibilityDiagnostics";
import {
  useEditorStore,
  END_CONDITION_DEFAULTS,
} from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import {
  CONDITION_ACTIONS,
  type HarnessId,
  type ToolPermissionsOverride,
  type ToolPermissionMode,
  type PriorContext,
} from "../../types/messages";
import {
  INHERIT_DEFAULT_OPTION,
  NONE_OPTION,
  PROMPT_PROPERTIES,
  RESUME_SESSION_SELECTIONS,
  EXECUTION_MODE_HELP_TEXT,
  EXECUTION_MODE_OPTIONS,
  PERMISSION_MODES,
  PERMISSION_CAPABILITY_KEYS,
  PROPERTY_EDITOR_MODES,
  STEP_COLOR_MODES,
  STEP_TYPES,
  type ExecutionMode,
} from "../../../../types/DashboardConstants";
import {
  DROPDOWN_NAMESPACES,
  modelNamespaceForHarness,
  getResumeSessionOptions,
  resumeSessionSelection,
} from "../../types/dropdownNamespaces";
import { SESSION_ID_SENTINELS } from "../../types/messages";
import {
  CustomSelect,
  getAgentDisplayName,
  toAgentSelectOption,
  DrawerRow,
  HarnessDropdown,
  HARNESS_DISPLAY_NAMES,
  PriorContextSelect,
  PRIOR_CONTEXT_KEYWORD_LABELS,
  SkillsSelect,
  McpServersEditor,
  buildMcpDefaultLabel,
  type McpServersValue,
  PERMISSION_MODE_OPTIONS,
  FieldDiagnostic,
  CompatibilitySummary,
  buildPermissionsDefaultLabel,
  ErrorBehaviorEditor,
  SecretGrantsEditor,
  ScriptConditionEditor,
  type ScriptConditionValue,
  AnimatedSection,
  AutoResumeStatusRow,
  ExitButton,
  AdditionalArgsEditor,
} from "../shared";
import { getAutoResumePreview } from "../../utils/autoResumePreview";
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
} from "@utils/compatibilityDiagnostics";
import { HooksEditor } from "./HooksEditor";
import { StepColorField } from "./StepColorField";
import { EDITOR_FOOTER_HEIGHT_REM } from "./EditorFooter";
import { DRAWER_PAGES, type DrawerPage } from "../../types/drawerPages";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { getExecutionPreviewEditorSnapshot } from "@utils/executionPreview";
import { parseSecretReferences } from "@root/utils/SecretReferenceParser";
import { Icon } from "../shared/Icon";

interface PropertiesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activePage: DrawerPage;
  onRequestPage?: (page: DrawerPage, focusId: string) => void;
  hasPreCondition?: boolean;
}

/**
 * PropertiesDrawer - Slide-up panel for prompt properties
 *
 * Layout (two-column grid throughout, matching WorkflowPropertiesPanel ordering):
 * - Row 1: Harness + Model
 * - Row 2: Agent + Skills
 * - Row 3: Additional Args + Prior Context
 * - Row 4: Allow Dynamic Extension + Resume Session (with paired Session ID)
 * - End Condition section (full width)
 */
export const PropertiesDrawer: React.FC<PropertiesDrawerProps> = ({
  isOpen,
  onClose,
  activePage,
  onRequestPage,
  hasPreCondition = false,
}) => {
  const {
    properties,
    setProperty,
    setEndCondition,
    clearEndCondition,
    selectedPromptIndex,
    selectionTarget,
  } = useEditorStore();

  const {
    availableAgents,
    availableSkills,
    globalSettings,
    workflowProperties,
    getModelsForHarness,
  } = useSettingsStore();
  const steps = useWorkflowStore((s) => s.steps);
  const hasEditorContent = useEditorStore((s) =>
    s.stepType === STEP_TYPES.SCRIPT
      ? s.scriptCommand.trim().length > 0
      : s.promptText.trim().length > 0
  );
  const promptText = useEditorStore((s) => s.promptText);
  const { hiddenDropdownOptions, hideDropdownOption, unhideDropdownOption } =
    useUiStore();
  const handleResetAllToInherit = useCallback(() => {
    setProperty(PROMPT_PROPERTIES.HARNESS, undefined);
    setProperty(PROMPT_PROPERTIES.MODEL, undefined);
    setProperty(PROMPT_PROPERTIES.AGENT, undefined);
    setProperty(PROMPT_PROPERTIES.SKILLS, undefined);
    setProperty(PROMPT_PROPERTIES.SECRETS, undefined);
    setProperty(PROMPT_PROPERTIES.ADDITIONAL_ARGS, undefined);
    setProperty(PROMPT_PROPERTIES.EXECUTION_MODE, undefined);
    setProperty(PROMPT_PROPERTIES.COLOR, undefined);
    setProperty(PROMPT_PROPERTIES.RESUME_SESSION, undefined);
    setProperty(PROMPT_PROPERTIES.SESSION_ID, "");
    setProperty(PROMPT_PROPERTIES.PRIOR_CONTEXT, undefined);
    setProperty(PROMPT_PROPERTIES.MCP_SERVERS, undefined);
    setProperty(PROMPT_PROPERTIES.TOOL_PERMISSIONS, undefined);
    setProperty(PROMPT_PROPERTIES.HOOKS, undefined);
    setProperty(PROMPT_PROPERTIES.ERROR_BEHAVIOR, undefined);
    setProperty(PROMPT_PROPERTIES.PRE_CONDITION, undefined);
    clearEndCondition();
  }, [setProperty, clearEndCondition]);

  const [drawerRef, isNarrow] = useElementNarrow<HTMLDivElement>(576);

  // ── Resolved "Default (X)" labels ────────────────────────────────────────
  // Each label shows what value the prompt will actually use when set to Default,
  // resolving through the three-tier chain: prompt → workflow → global settings.

  const resolvedHarness = (workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const defaultHarnessLabel = `Inherit (${HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness})`;

  const resolvedModels = getModelsForHarness(resolvedHarness);
  const resolvedModelValue =
    workflowProperties.model ??
    globalSettings.harnessDefaultModels[resolvedHarness] ??
    globalSettings.model;
  const resolvedModelLabel =
    resolvedModels.find((m) => m.value === resolvedModelValue)?.label ??
    resolvedModelValue;
  const defaultModelLabel = `Inherit (${resolvedModelLabel || "None"})`;

  const resolvedAgent =
    workflowProperties.agent === undefined
      ? globalSettings.agent
      : workflowProperties.agent;
  const resolvedAgentName = !resolvedAgent
    ? "None"
    : (() => {
        const agent = availableAgents.find(
          (a) => a.path === resolvedAgent || a.name === resolvedAgent
        );
        return agent ? getAgentDisplayName(agent) : resolvedAgent;
      })();
  const defaultAgentLabel = `Inherit (${resolvedAgentName})`;

  const resolvedSkills =
    workflowProperties.skills === undefined
      ? (globalSettings.skills ?? [])
      : (workflowProperties.skills ?? []);
  const defaultSkillsLabel =
    resolvedSkills.length === 0
      ? "Inherit (None)"
      : resolvedSkills.length <= 2
        ? `Inherit (${resolvedSkills.join(", ")})`
        : `Inherit (${resolvedSkills.slice(0, 2).join(", ")} +${resolvedSkills.length - 2})`;

  const resolvedSecrets =
    workflowProperties.secrets !== undefined
      ? (workflowProperties.secrets ?? [])
      : (globalSettings.secrets ?? []);
  const inlineSecretNames = useMemo(
    () => [
      ...new Set(
        parseSecretReferences(promptText).map((reference) => reference.name)
      ),
    ],
    [promptText]
  );
  const resolvedAdditionalArgs =
    workflowProperties.additionalArgs === undefined
      ? (globalSettings.harnessDefaultAdditionalArgs[resolvedHarness] ?? "")
      : workflowProperties.additionalArgs;
  const defaultAdditionalArgsLabel = !resolvedAdditionalArgs
    ? "Inherit (None)"
    : `Inherit (${resolvedAdditionalArgs})`;

  const resolvedExecutionMode =
    workflowProperties.executionMode ?? globalSettings.executionMode;
  const defaultExecutionModeLabel = `Inherit (${
    EXECUTION_MODE_OPTIONS.find(
      (option) => option.value === resolvedExecutionMode
    )?.label ?? resolvedExecutionMode
  })`;

  const resolvedResumeSession =
    workflowProperties.resumeSession ?? globalSettings.resumeSession;
  const resolvedSessionId = workflowProperties.sessionId;

  // Whether a blank Session ID field currently means "auto-resume the most
  // recent session with the same harness", accounting for prompt-level
  // overrides falling back to the resolved workflow/global values.
  const effectiveResumeSessionForHint =
    properties.resumeSession ?? resolvedResumeSession;
  const effectiveSessionIdForHint =
    properties.sessionId !== undefined
      ? properties.sessionId
      : resolvedSessionId;
  const showAutoResumeHint =
    effectiveResumeSessionForHint === true &&
    effectiveSessionIdForHint !== SESSION_ID_SENTINELS.FINAL_STEP &&
    !effectiveSessionIdForHint;

  const defaultResumeSessionLabel =
    resolvedResumeSession &&
    resolvedSessionId === SESSION_ID_SENTINELS.FINAL_STEP
      ? "Inherit (Final Step Session)"
      : `Inherit (${resolvedResumeSession ? "Yes" : "No"})`;

  // Session ID display in prompt-level drawer
  const isSessionIdDefault = properties.resumeSession === undefined;
  const isSessionIdActive =
    properties.resumeSession === true &&
    properties.sessionId !== SESSION_ID_SENTINELS.FINAL_STEP;
  const sessionIdDisplayValue = isSessionIdActive
    ? (properties.sessionId ?? "")
    : isSessionIdDefault &&
        resolvedResumeSession &&
        resolvedSessionId !== SESSION_ID_SENTINELS.FINAL_STEP
      ? (resolvedSessionId ?? "")
      : "";
  const sessionIdTooltip = isSessionIdActive
    ? undefined
    : isSessionIdDefault
      ? "Using workflow-level Resume Session setting. Select Yes to override."
      : properties.resumeSession === true &&
          properties.sessionId === SESSION_ID_SENTINELS.FINAL_STEP
        ? "Using Final Step Session — no explicit Session ID needed"
        : "Set Resume Session to Yes to specify a Session ID";

  // Additional Args display mode
  const additionalArgsMode =
    properties.additionalArgs === undefined
      ? INHERIT_DEFAULT_OPTION
      : properties.additionalArgs === null
        ? NONE_OPTION
        : PROPERTY_EDITOR_MODES.CUSTOM;
  const isAdditionalArgsActive =
    additionalArgsMode === PROPERTY_EDITOR_MODES.CUSTOM;
  const additionalArgsDisplayValue = isAdditionalArgsActive
    ? typeof properties.additionalArgs === "string"
      ? properties.additionalArgs
      : ""
    : additionalArgsMode === INHERIT_DEFAULT_OPTION
      ? (resolvedAdditionalArgs ?? "")
      : "";
  const additionalArgsTooltip = isAdditionalArgsActive
    ? undefined
    : additionalArgsMode === INHERIT_DEFAULT_OPTION
      ? "Inheriting from workflow settings. Select Custom to override."
      : "Set to None — no additional args will be passed";

  const resolvedMcpServers =
    workflowProperties.mcpServers !== undefined
      ? workflowProperties.mcpServers
      : globalSettings.mcpServers;
  const defaultMcpServersLabel = buildMcpDefaultLabel(
    resolvedMcpServers as McpServersValue
  );

  // ── Permissions page derived values ──────────────────────────────────────
  const defaultPermissionsLabel = buildPermissionsDefaultLabel(
    workflowProperties.toolPermissions,
    globalSettings.toolPermissions as ToolPermissionsOverride
  );
  const compatibility = useCompatibilityDiagnostics({
    promptProperties: properties,
    promptTarget: selectionTarget,
  });
  const permissionDiagnostics = compatibility.diagnostics.filter(
    (diagnostic) =>
      diagnostic.capability === PERMISSION_CAPABILITY_KEYS.MODE ||
      diagnostic.capability === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS ||
      diagnostic.capability === PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
  );
  const hookDiagnostics = diagnosticsForHookEvents(compatibility.diagnostics);
  const mcpDiagnostics = diagnosticsForMcpFiltering(compatibility.diagnostics);
  const allowedDiagnostics = diagnosticsForPermissionField(
    permissionDiagnostics,
    "allowedTools"
  );
  const deniedDiagnostics = diagnosticsForPermissionField(
    permissionDiagnostics,
    "deniedTools"
  );
  const modeDiagnostics = diagnosticsForPermissionField(
    permissionDiagnostics,
    "mode"
  );
  const reviewCompatibility = () => {
    const focusId = firstCompatibilityProperty(permissionDiagnostics, "prop");
    onRequestPage?.(DRAWER_PAGES.PERMISSIONS, focusId);
  };

  const openDryRunStep = () => {
    if (selectedPromptIndex === null && !hasEditorContent) return;
    const stepIndex = selectedPromptIndex ?? steps.length;
    useExecutionPreviewStore
      .getState()
      .open({ kind: "step", stepIndex }, getExecutionPreviewEditorSnapshot());
  };
  // Resolved permission mode (prompt → workflow fallback) used for tab icon styling
  const resolvedPermMode =
    properties.toolPermissions === undefined
      ? workflowProperties.toolPermissions === null
        ? PERMISSION_MODES.NONE
        : (workflowProperties.toolPermissions?.mode ??
          PERMISSION_MODES.ALLOW_ALL)
      : properties.toolPermissions === null
        ? PERMISSION_MODES.NONE
        : (properties.toolPermissions.mode ?? PERMISSION_MODES.ALLOW_ALL);

  // ── Hooks page derived values ───────────────────────────────────────────
  const resolvedHooks = useMemo(() => {
    const effective =
      workflowProperties.hooks !== undefined
        ? workflowProperties.hooks
        : globalSettings.hooks;
    return Array.isArray(effective) ? effective : [];
  }, [workflowProperties.hooks, globalSettings.hooks]);

  const resolvedPriorContext =
    workflowProperties.priorContext ??
    (globalSettings.priorContext as PriorContext);
  const defaultPriorContextLabel = (() => {
    if (Array.isArray(resolvedPriorContext)) {
      return `Inherit (Custom: [${resolvedPriorContext.join(", ")}])`;
    }
    const label =
      PRIOR_CONTEXT_KEYWORD_LABELS[
        resolvedPriorContext as keyof typeof PRIOR_CONTEXT_KEYWORD_LABELS
      ];
    return `Inherit (${label ?? resolvedPriorContext})`;
  })();

  // Get models for current harness
  const currentHarness = (properties.harness ??
    workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const models = getModelsForHarness(currentHarness);
  const modelNamespace = modelNamespaceForHarness(currentHarness);
  const modelWarn = modelWarning(properties.model, currentHarness, models);
  const agentWarn = agentWarning(properties.agent, availableAgents);
  const skillsWarn = skillsWarning(properties.skills, availableSkills);

  // Preview of what auto-resume would do for this prompt, shown when the
  // Session ID field is blank (see showAutoResumeHint above).
  const autoResumeBeforeIndex = selectedPromptIndex ?? steps.length;
  const autoResumePreview = getAutoResumePreview(
    steps,
    autoResumeBeforeIndex,
    currentHarness
  );

  // Handle harness change - also set model and additionalArgs to global defaults for the new harness
  const handleHarnessChange = (newHarness: string) => {
    if (newHarness === INHERIT_DEFAULT_OPTION) {
      setProperty(PROMPT_PROPERTIES.HARNESS, undefined);
      setProperty(PROMPT_PROPERTIES.MODEL, undefined);
      setProperty(PROMPT_PROPERTIES.ADDITIONAL_ARGS, undefined);
    } else {
      setProperty(PROMPT_PROPERTIES.HARNESS, newHarness);
      const defaultModel = globalSettings.harnessDefaultModels[newHarness];
      setProperty(PROMPT_PROPERTIES.MODEL, defaultModel || undefined);
      const defaultArgs =
        globalSettings.harnessDefaultAdditionalArgs[newHarness];
      setProperty(PROMPT_PROPERTIES.ADDITIONAL_ARGS, defaultArgs || null);
    }
  };

  // ── Condition mode derivations ──────────────────────────────────────────────
  const endConditionMode =
    properties.endCondition === undefined
      ? PROPERTY_EDITOR_MODES.INHERIT
      : properties.endCondition === null
        ? NONE_OPTION
        : PROPERTY_EDITOR_MODES.CUSTOM;

  const preConditionMode =
    properties.preCondition === undefined
      ? PROPERTY_EDITOR_MODES.INHERIT
      : properties.preCondition === null
        ? NONE_OPTION
        : PROPERTY_EDITOR_MODES.CUSTOM;

  const errorBehaviorMode =
    properties.errorBehavior === undefined
      ? PROPERTY_EDITOR_MODES.INHERIT
      : PROPERTY_EDITOR_MODES.CUSTOM;

  const resolvedEndConditionForInherit =
    workflowProperties.endCondition !== undefined
      ? workflowProperties.endCondition
      : globalSettings.defaultEndCondition;

  const resolvedPreConditionForInherit =
    workflowProperties.preCondition !== undefined
      ? workflowProperties.preCondition
      : globalSettings.defaultPreCondition;

  const resolvedErrorBehaviorForInherit =
    workflowProperties.errorBehavior !== undefined
      ? workflowProperties.errorBehavior
      : globalSettings.defaultErrorBehavior;

  const buildConditionInheritLabel = (
    resolved: { script?: string } | null | undefined
  ): string => {
    if (!resolved?.script) return "Inherit (None)";
    const words = resolved.script.trim().split(/\s+/);
    return words.length <= 3
      ? `Inherit (${resolved.script})`
      : `Inherit (${words.slice(0, 3).join(" ")}…)`;
  };

  const endConditionInheritLabel = buildConditionInheritLabel(
    resolvedEndConditionForInherit
  );
  const preConditionInheritLabel = buildConditionInheritLabel(
    resolvedPreConditionForInherit
  );

  const buildErrorBehaviorInheritLabel = (
    resolved: ErrorBehavior | null | undefined
  ) => {
    if (!resolved) return "Inherit (Stop Workflow)";
    if (resolved.onError === CONDITION_ACTIONS.RETRY) {
      return `Inherit (Retry ${resolved.maxRetries ?? 1}x)`;
    }
    return resolved.onError === CONDITION_ACTIONS.CONTINUE
      ? "Inherit (Continue Workflow)"
      : "Inherit (Stop Workflow)";
  };

  const errorBehaviorInheritLabel = buildErrorBehaviorInheritLabel(
    resolvedErrorBehaviorForInherit
  );

  const buildConditionOptions = (inheritLabel: string) => [
    { value: PROPERTY_EDITOR_MODES.INHERIT, label: inheritLabel },
    { value: NONE_OPTION, label: "None" },
    { value: PROPERTY_EDITOR_MODES.CUSTOM, label: "Custom" },
  ];

  const errorBehaviorOptions = [
    {
      value: PROPERTY_EDITOR_MODES.INHERIT,
      label: errorBehaviorInheritLabel,
    },
    { value: PROPERTY_EDITOR_MODES.CUSTOM, label: "Custom" },
  ];

  return (
    <div
      ref={drawerRef}
      /* duration-300: App.tsx grows the editor panel over the same duration
         and easing (DRAWER_EXPANSION_ANIMATION_MS / _EASING) so the panel
         moves with this slide rather than snapping ahead of it. */
      className={`properties-drawer absolute bottom-0 left-0 right-0 bg-sidebar-bg border-t-2 border-panel-border shadow-lg transition-transform duration-300 z-panel h-full flex flex-col overflow-hidden ${
        isOpen ? "translate-y-0" : ""
      }`}
      role="region"
      aria-labelledby="prompt-properties-heading"
      style={{
        transform: isOpen
          ? "translateY(0)"
          : `translateY(calc(100% + ${EDITOR_FOOTER_HEIGHT_REM}rem + 2px))`,
      }}
      {...(!isOpen && { inert: true })}
    >
      {/* Header */}
      <div className="drawer-header shrink-0 flex items-center justify-between px-4 py-0 border-b border-panel-border bg-sidebar-drop-bg">
        <div className="flex items-center gap-2">
          <h3
            id="prompt-properties-heading"
            className="flex items-center gap-1 text-xs font-semibold uppercase leading-none text-foreground"
          >
            <Icon name="settings" className="text-xs leading-none" />
            <span>Prompt Properties</span>
          </h3>
          <button
            type="button"
            className="w-5 h-5 flex items-center justify-center rounded opacity-60 hover:opacity-100 hover:bg-toolbar-hover-bg transition-all"
            onClick={handleResetAllToInherit}
            title="Reset all to inherit"
            aria-label="Reset all to inherit"
          >
            <Icon name="debug-restart" className="text-xs" />
          </button>
        </div>
        <ExitButton
          onClick={onClose}
          title="Close properties drawer"
          aria-label="Close properties drawer"
        />
      </div>

      {/* Body - Scrollable */}
      <div
        className={`drawer-body flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-2${activePage === DRAWER_PAGES.PERMISSIONS ? " flex flex-col" : ""}`}
      >
        {/* Page: Harness */}
        {activePage === DRAWER_PAGES.HARNESS && (
          <div className="space-y-2">
            {/* Harness + Model */}
            <DrawerRow narrow={isNarrow}>
              {/* Harness */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-harness"
                  className="text-xs font-semibold uppercase text-description-fg"
                >
                  Harness
                </label>
                <HarnessDropdown
                  id="prop-harness"
                  triggerAriaLabel="Harness"
                  value={properties.harness ?? INHERIT_DEFAULT_OPTION}
                  onChange={handleHarnessChange}
                  showDefault={true}
                  defaultLabel={defaultHarnessLabel}
                  defaultHarnessId={resolvedHarness}
                  showStatus={false}
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
              </div>

              {/* Model */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-model"
                  className="text-xs font-semibold uppercase text-description-fg"
                >
                  Model
                </label>
                <CustomSelect
                  id="prop-model"
                  triggerAriaLabel="Model"
                  value={properties.model ?? INHERIT_DEFAULT_OPTION}
                  onChange={(v) =>
                    setProperty(
                      PROMPT_PROPERTIES.MODEL,
                      v === INHERIT_DEFAULT_OPTION ? undefined : v
                    )
                  }
                  options={[
                    { value: INHERIT_DEFAULT_OPTION, label: defaultModelLabel },
                    ...(models.length === 0
                      ? [
                          {
                            value: "",
                            label: "Loading models...",
                            disabled: true,
                          },
                        ]
                      : models.map((m) => ({
                          value: m.value,
                          label: m.label,
                        }))),
                  ]}
                  namespace={modelNamespace}
                  hiddenValues={hiddenDropdownOptions[modelNamespace] ?? []}
                  onHideOption={(v) => hideDropdownOption(modelNamespace, v)}
                  onUnhideOption={(v) =>
                    unhideDropdownOption(modelNamespace, v)
                  }
                  nonHideableValues={[INHERIT_DEFAULT_OPTION, ""]}
                  warning={modelWarn ?? undefined}
                />
              </div>
            </DrawerRow>

            {/* Row 2: Agent + Skills */}
            <DrawerRow narrow={isNarrow}>
              {/* Agent — single flat dropdown: Default / None / each agent */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-agent"
                  className="text-xs font-semibold uppercase text-description-fg"
                >
                  Agent
                </label>
                <CustomSelect
                  id="prop-agent"
                  triggerAriaLabel="Agent"
                  value={
                    properties.agent === undefined
                      ? INHERIT_DEFAULT_OPTION
                      : properties.agent === null
                        ? NONE_OPTION
                        : properties.agent
                  }
                  onChange={(v) => {
                    if (v === INHERIT_DEFAULT_OPTION) {
                      setProperty(PROMPT_PROPERTIES.AGENT, undefined);
                    } else if (v === NONE_OPTION) {
                      setProperty(PROMPT_PROPERTIES.AGENT, null);
                    } else {
                      setProperty(PROMPT_PROPERTIES.AGENT, v);
                    }
                  }}
                  options={[
                    { value: INHERIT_DEFAULT_OPTION, label: defaultAgentLabel },
                    { value: NONE_OPTION, label: "None" },
                    ...availableAgents.map((agent) =>
                      toAgentSelectOption(agent, agent.name)
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
                  nonHideableValues={[INHERIT_DEFAULT_OPTION]}
                  warning={agentWarn ?? undefined}
                />
              </div>

              {/* Skills — hybrid dropdown with Default/None keywords + checkbox list */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-skills"
                  className="text-xs font-semibold uppercase text-description-fg"
                >
                  Skills
                </label>
                <SkillsSelect
                  id="prop-skills"
                  triggerAriaLabel="Skills"
                  value={properties.skills as string[] | null | undefined}
                  onChange={(v) => setProperty(PROMPT_PROPERTIES.SKILLS, v)}
                  availableSkills={availableSkills.map((s) => ({
                    name: s.name,
                    description: s.description || undefined,
                  }))}
                  defaultLabel={defaultSkillsLabel}
                  warning={skillsWarn ?? undefined}
                />
              </div>
            </DrawerRow>

            {/* Additional Args */}
            <DrawerRow narrow={isNarrow}>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-additional-args-mode"
                  className="text-xs font-semibold uppercase text-description-fg"
                  title="Extra CLI flags appended to ctrlyoke's standard argument set. Only applies to CLI harnesses."
                >
                  Additional Args
                </label>
                <CustomSelect
                  id="prop-additional-args-mode"
                  triggerAriaLabel="Additional Args"
                  value={additionalArgsMode}
                  onChange={(v) => {
                    if (v === INHERIT_DEFAULT_OPTION) {
                      setProperty(PROMPT_PROPERTIES.ADDITIONAL_ARGS, undefined);
                    } else if (v === NONE_OPTION) {
                      setProperty(PROMPT_PROPERTIES.ADDITIONAL_ARGS, null);
                    } else {
                      setProperty(
                        PROMPT_PROPERTIES.ADDITIONAL_ARGS,
                        typeof properties.additionalArgs === "string"
                          ? properties.additionalArgs
                          : ""
                      );
                    }
                  }}
                  options={[
                    {
                      value: INHERIT_DEFAULT_OPTION,
                      label: defaultAdditionalArgsLabel,
                    },
                    { value: NONE_OPTION, label: "None" },
                    { value: PROPERTY_EDITOR_MODES.CUSTOM, label: "Custom" },
                  ]}
                />
                {/* Narrow mode: input always below the dropdown */}
                {isNarrow && (
                  <div
                    className={
                      isAdditionalArgsActive
                        ? ""
                        : "opacity-50 pointer-events-none"
                    }
                    title={additionalArgsTooltip}
                  >
                    <AdditionalArgsEditor
                      id="prop-additional-args"
                      harnessId={currentHarness}
                      value={additionalArgsDisplayValue}
                      onChange={(value) =>
                        setProperty(PROMPT_PROPERTIES.ADDITIONAL_ARGS, value)
                      }
                      className="w-full text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                    />
                  </div>
                )}
              </div>

              {/* Wide mode: input in the right column, aligned to bottom */}
              {!isNarrow && (
                <div
                  className={`flex flex-col justify-end ${
                    isAdditionalArgsActive
                      ? ""
                      : "opacity-50 pointer-events-none"
                  }`}
                  title={additionalArgsTooltip}
                >
                  <AdditionalArgsEditor
                    id="prop-additional-args-wide"
                    harnessId={currentHarness}
                    value={additionalArgsDisplayValue}
                    onChange={(value) =>
                      setProperty(PROMPT_PROPERTIES.ADDITIONAL_ARGS, value)
                    }
                    className="w-full text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                  />
                </div>
              )}
            </DrawerRow>

            {/* Execution Mode */}
            <DrawerRow narrow={isNarrow}>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-execution-mode"
                  className="text-xs font-semibold uppercase text-description-fg"
                  title={EXECUTION_MODE_HELP_TEXT}
                >
                  Execution Mode
                </label>
                <CustomSelect
                  id="prop-execution-mode"
                  triggerAriaLabel="Execution Mode"
                  value={properties.executionMode ?? INHERIT_DEFAULT_OPTION}
                  onChange={(v) =>
                    setProperty(
                      PROMPT_PROPERTIES.EXECUTION_MODE,
                      v === INHERIT_DEFAULT_OPTION
                        ? undefined
                        : (v as ExecutionMode)
                    )
                  }
                  options={[
                    {
                      value: INHERIT_DEFAULT_OPTION,
                      label: defaultExecutionModeLabel,
                    },
                    ...EXECUTION_MODE_OPTIONS,
                  ]}
                />
              </div>
              {globalSettings.stepColorMode !== STEP_COLOR_MODES.OFF && (
                <StepColorField idPrefix="prop-step" />
              )}
            </DrawerRow>
          </div>
        )}

        {/* Page: Context */}
        {activePage === DRAWER_PAGES.CONTEXT && (
          <div className="space-y-2">
            <DrawerRow narrow={isNarrow}>
              {/* Resume Session — paired control with Session ID below */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-resume-session"
                  className="text-xs font-semibold uppercase text-description-fg"
                >
                  Resume Session
                </label>
                <CustomSelect
                  id="prop-resume-session"
                  triggerAriaLabel="Resume Session"
                  value={
                    properties.resumeSession === undefined
                      ? INHERIT_DEFAULT_OPTION
                      : properties.sessionId ===
                            SESSION_ID_SENTINELS.FINAL_STEP &&
                          properties.resumeSession
                        ? SESSION_ID_SENTINELS.FINAL_STEP
                        : properties.resumeSession
                          ? RESUME_SESSION_SELECTIONS.YES
                          : RESUME_SESSION_SELECTIONS.NO
                  }
                  onChange={(v) => {
                    const next = resumeSessionSelection(
                      v,
                      properties.sessionId
                    );
                    setProperty(
                      PROMPT_PROPERTIES.RESUME_SESSION,
                      next.resumeSession
                    );
                    setProperty(PROMPT_PROPERTIES.SESSION_ID, next.sessionId);
                  }}
                  options={[
                    ...getResumeSessionOptions(defaultResumeSessionLabel),
                  ]}
                />
                {/* Session ID — always visible, grayed out when not applicable */}
                <div
                  className={`mt-1 ${
                    isSessionIdActive ? "" : "opacity-50 pointer-events-none"
                  }`}
                  title={sessionIdTooltip}
                >
                  <input
                    type="text"
                    id="prop-session-id"
                    value={sessionIdDisplayValue}
                    onChange={(e) =>
                      setProperty(PROMPT_PROPERTIES.SESSION_ID, e.target.value)
                    }
                    placeholder={
                      isSessionIdDefault
                        ? "Inherited from workflow"
                        : "Session ID, prompt number, or blank for auto-resume"
                    }
                    className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                    title="Enter session ID (UUID), prompt number (e.g., 1, 2, 3), or leave blank for auto-resume. Auto-resume continues the most recent session from an earlier prompt using the same harness."
                  />
                  {showAutoResumeHint && (
                    <AutoResumeStatusRow preview={autoResumePreview} />
                  )}
                </div>
              </div>

              {/* Prior Context */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-prior-context"
                  className="text-xs font-semibold uppercase text-description-fg"
                  title="Send prior step outputs with the prompt"
                >
                  Prior Context
                </label>
                <PriorContextSelect
                  id="prop-prior-context"
                  value={properties.priorContext}
                  onChange={(v) =>
                    setProperty(PROMPT_PROPERTIES.PRIOR_CONTEXT, v)
                  }
                  showDefault
                  defaultLabel={defaultPriorContextLabel}
                />
              </div>
            </DrawerRow>
          </div>
        )}

        {/* Page: Validation */}
        {activePage === DRAWER_PAGES.VALIDATION && (
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-panel-border pb-2">
              <h4 className="text-xs font-semibold uppercase text-description-fg">
                Validation
              </h4>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded text-description-fg transition-colors hover:bg-toolbar-hover-bg hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                onClick={openDryRunStep}
                disabled={!hasEditorContent}
                title="Dry Run Step"
                aria-label="Dry Run Step"
              >
                <Icon name="telescope" />
              </button>
            </div>
            {/* Pre-Condition Section */}
            <div className="space-y-2">
              <label
                htmlFor="prop-pre-condition-mode"
                className="text-xs font-semibold uppercase text-description-fg"
                title="Runs a script before the prompt. Use to gate execution on a condition."
              >
                Pre-Condition
              </label>
              <CustomSelect
                id="prop-pre-condition-mode"
                triggerAriaLabel="Pre-Condition"
                value={preConditionMode}
                onChange={(v) => {
                  if (v === PROPERTY_EDITOR_MODES.INHERIT) {
                    setProperty(PROMPT_PROPERTIES.PRE_CONDITION, undefined);
                  } else if (v === NONE_OPTION) {
                    setProperty(PROMPT_PROPERTIES.PRE_CONDITION, null);
                  } else {
                    setProperty(PROMPT_PROPERTIES.PRE_CONDITION, {
                      script: "",
                      onFail: CONDITION_ACTIONS.SKIP_PROMPT,
                    } as import("../../../../types/CtrlYokeTypes").PreCondition);
                  }
                }}
                options={buildConditionOptions(preConditionInheritLabel)}
              />
              <AnimatedSection
                visible={preConditionMode === PROPERTY_EDITOR_MODES.CUSTOM}
              >
                <div className="space-y-3 p-3 bg-editor-bg border border-panel-border rounded">
                  <ScriptConditionEditor
                    variant={PROMPT_PROPERTIES.PRE_CONDITION}
                    value={
                      properties.preCondition as
                        ScriptConditionValue | null | undefined
                    }
                    onChange={(updated) =>
                      setProperty(
                        PROMPT_PROPERTIES.PRE_CONDITION,
                        updated as import("../../../../types/CtrlYokeTypes").PreCondition
                      )
                    }
                    narrow={isNarrow}
                    disabled={false}
                    idPrefix="prop-pre"
                  />
                </div>
              </AnimatedSection>
            </div>

            {/* End Condition Section */}
            <div className="space-y-2">
              <label
                htmlFor="prop-end-condition-mode"
                className="text-xs font-semibold uppercase text-description-fg"
                title="Validation runs after the prompt completes. Use to gate retries on a condition."
              >
                End Condition
              </label>
              <CustomSelect
                id="prop-end-condition-mode"
                triggerAriaLabel="End Condition"
                value={endConditionMode}
                onChange={(v) => {
                  if (v === PROPERTY_EDITOR_MODES.INHERIT) {
                    clearEndCondition();
                  } else if (v === NONE_OPTION) {
                    setEndCondition(null);
                  } else {
                    setEndCondition({ ...END_CONDITION_DEFAULTS });
                  }
                }}
                options={buildConditionOptions(endConditionInheritLabel)}
              />
              <AnimatedSection
                visible={endConditionMode === PROPERTY_EDITOR_MODES.CUSTOM}
              >
                <div className="space-y-3 p-3 bg-editor-bg border border-panel-border rounded">
                  <ScriptConditionEditor
                    variant={PROMPT_PROPERTIES.END_CONDITION}
                    hasPreCondition={hasPreCondition}
                    value={
                      properties.endCondition as
                        ScriptConditionValue | null | undefined
                    }
                    onChange={(updated) =>
                      setEndCondition(
                        updated as import("../../store/editorStore").EndConditionConfig
                      )
                    }
                    narrow={isNarrow}
                    disabled={false}
                    idPrefix="prop-end"
                  />
                </div>
              </AnimatedSection>
            </div>

            {/* Error Behavior Section */}
            <div className="space-y-2">
              <label
                htmlFor="prop-error-behavior-mode"
                className="text-xs font-semibold uppercase text-description-fg"
                title="Controls what happens when a pre-condition, prompt/harness, end-condition, or script step encounters an internal error."
              >
                Error Behavior
              </label>
              <CustomSelect
                id="prop-error-behavior-mode"
                triggerAriaLabel="Error Behavior"
                value={errorBehaviorMode}
                onChange={(v) => {
                  if (v === PROPERTY_EDITOR_MODES.INHERIT) {
                    setProperty(PROMPT_PROPERTIES.ERROR_BEHAVIOR, undefined);
                  } else {
                    setProperty(PROMPT_PROPERTIES.ERROR_BEHAVIOR, {
                      onError: CONDITION_ACTIONS.STOP_WORKFLOW,
                    } as ErrorBehavior);
                  }
                }}
                options={errorBehaviorOptions}
              />
              <AnimatedSection
                visible={errorBehaviorMode === PROPERTY_EDITOR_MODES.CUSTOM}
              >
                <div className="space-y-3 p-3 bg-editor-bg border border-panel-border rounded">
                  <ErrorBehaviorEditor
                    value={properties.errorBehavior}
                    onChange={(updated) =>
                      setProperty(PROMPT_PROPERTIES.ERROR_BEHAVIOR, updated)
                    }
                    disabled={false}
                    idPrefix="prop-error"
                  />
                </div>
              </AnimatedSection>
            </div>
          </div>
        )}

        {/* Page: MCP */}
        {activePage === DRAWER_PAGES.MCP && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase text-description-fg">
              MCP Servers
            </p>
            <McpServersEditor
              controlId="prop-mcp-servers"
              value={properties.mcpServers as McpServersValue}
              onChange={(v) => setProperty(PROMPT_PROPERTIES.MCP_SERVERS, v)}
              defaultLabel={defaultMcpServersLabel}
              inheritedValue={resolvedMcpServers as McpServersValue}
              diagnostics={mcpDiagnostics}
            />
          </div>
        )}

        {/* Page: Permissions */}
        {activePage === DRAWER_PAGES.PERMISSIONS && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 flex flex-col min-h-0">
              {/* Permission Mode */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-permission-mode"
                  className="text-xs font-semibold uppercase text-description-fg"
                  title="Tool permission mode override for this prompt"
                >
                  Permission Mode
                </label>
                <CustomSelect
                  id="prop-permission-mode"
                  triggerAriaLabel="Permission Mode"
                  value={
                    properties.toolPermissions === undefined
                      ? INHERIT_DEFAULT_OPTION
                      : properties.toolPermissions === null
                        ? PERMISSION_MODES.NONE
                        : (properties.toolPermissions.mode ??
                          PERMISSION_MODES.ALLOW_ALL)
                  }
                  onChange={(v) => {
                    if (v === INHERIT_DEFAULT_OPTION) {
                      setProperty(
                        PROMPT_PROPERTIES.TOOL_PERMISSIONS,
                        undefined
                      );
                    } else {
                      const current =
                        (properties.toolPermissions as
                          ToolPermissionsOverride | undefined) || {};
                      setProperty(PROMPT_PROPERTIES.TOOL_PERMISSIONS, {
                        ...current,
                        mode: v as ToolPermissionMode,
                      });
                    }
                  }}
                  options={[
                    {
                      value: INHERIT_DEFAULT_OPTION,
                      label: defaultPermissionsLabel,
                    },
                    ...PERMISSION_MODE_OPTIONS,
                  ]}
                  warning={modeDiagnostics[0]?.message}
                  warningId="prop-permission-mode-diagnostic"
                />
              </div>

              {/* Secrets — workflow grants plus locked inline !NAME references */}
              <div className="flex flex-col gap-1 mt-2">
                <SecretGrantsEditor
                  value={properties.secrets}
                  inheritedValue={resolvedSecrets}
                  inlineSecretNames={inlineSecretNames}
                  onChange={(secrets) =>
                    setProperty(PROMPT_PROPERTIES.SECRETS, secrets)
                  }
                  idPrefix="prop-secrets"
                  title="Grant named credentials to this prompt. Inline !NAME references in prompt text are always granted. Reset all to inherit to remove the prompt override."
                />
              </div>

              {/* Allowed / Denied Tools textareas — always visible, disabled by mode */}
              {(() => {
                const effectivePermMode = resolvedPermMode;
                const isInheriting = properties.toolPermissions === undefined;
                const allowedDisabled =
                  isInheriting || effectivePermMode !== PERMISSION_MODES.CUSTOM;
                const deniedDisabled =
                  isInheriting ||
                  effectivePermMode ===
                    PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
                  effectivePermMode === PERMISSION_MODES.NONE;

                return (
                  <div className="flex-1 flex flex-col min-h-0 mt-2">
                    <div
                      className={`flex-1 flex min-h-0 gap-2 ${isNarrow ? "flex-col" : "flex-row"}`}
                    >
                      {/* Allowed Tools */}
                      <div className="flex-1 flex flex-col gap-1 min-h-0">
                        <label
                          htmlFor="prop-allowed-tools"
                          className="text-xs font-semibold uppercase text-description-fg"
                          title="Tool patterns to allow (one per line). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode; Qwen is inline and OpenCode uses OPENCODE_CONFIG_CONTENT."
                        >
                          Allowed Tools
                        </label>
                        <textarea
                          id="prop-allowed-tools"
                          value={(
                            (
                              properties.toolPermissions as
                                ToolPermissionsOverride | undefined
                            )?.allowedTools ?? []
                          ).join("\n")}
                          onChange={(e) => {
                            const current =
                              (properties.toolPermissions as
                                ToolPermissionsOverride | undefined) || {};
                            setProperty(PROMPT_PROPERTIES.TOOL_PERMISSIONS, {
                              ...current,
                              allowedTools: e.target.value.split("\n"),
                            });
                          }}
                          disabled={allowedDisabled}
                          aria-describedby={
                            allowedDiagnostics.length > 0
                              ? "prop-allowed-tools-diagnostic"
                              : undefined
                          }
                          placeholder={"read\nglob\ngrep"}
                          className={`flex-1 min-h-[60px] w-full px-2 py-1 text-xs bg-input-bg text-input-fg border ${fieldValidationBorderClass(allowedDiagnostics)} rounded focus:outline-none focus:border-focus-border resize-none font-mono${
                            allowedDisabled
                              ? " opacity-50 cursor-not-allowed"
                              : ""
                          }`}
                        />
                        <FieldDiagnostic
                          id="prop-allowed-tools-diagnostic"
                          diagnostics={allowedDiagnostics.map((diagnostic) =>
                            toFieldDiagnostic(
                              diagnostic,
                              formatCompatibilitySource(diagnostic.sourceTier)
                            )
                          )}
                        />
                      </div>

                      {/* Denied Tools */}
                      <div className="flex-1 flex flex-col gap-1 min-h-0">
                        <label
                          htmlFor="prop-denied-tools"
                          className="text-xs font-semibold uppercase text-description-fg"
                          title="Tool patterns to deny (one per line, takes precedence over allow list). Codex and Antigravity do not enforce these lists."
                        >
                          Denied Tools
                        </label>
                        <textarea
                          id="prop-denied-tools"
                          value={(
                            (
                              properties.toolPermissions as
                                ToolPermissionsOverride | undefined
                            )?.deniedTools ?? []
                          ).join("\n")}
                          onChange={(e) => {
                            const current =
                              (properties.toolPermissions as
                                ToolPermissionsOverride | undefined) || {};
                            setProperty(PROMPT_PROPERTIES.TOOL_PERMISSIONS, {
                              ...current,
                              deniedTools: e.target.value.split("\n"),
                            });
                          }}
                          disabled={deniedDisabled}
                          aria-describedby={
                            deniedDiagnostics.length > 0
                              ? "prop-denied-tools-diagnostic"
                              : undefined
                          }
                          placeholder={"shell(rm:*)\nwrite"}
                          className={`flex-1 min-h-[60px] w-full px-2 py-1 text-xs bg-input-bg text-input-fg border ${fieldValidationBorderClass(deniedDiagnostics)} rounded focus:outline-none focus:border-focus-border resize-none font-mono${
                            deniedDisabled
                              ? " opacity-50 cursor-not-allowed"
                              : ""
                          }`}
                        />
                        <FieldDiagnostic
                          id="prop-denied-tools-diagnostic"
                          diagnostics={deniedDiagnostics.map((diagnostic) =>
                            toFieldDiagnostic(
                              diagnostic,
                              formatCompatibilitySource(diagnostic.sourceTier)
                            )
                          )}
                        />
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Page: Hooks */}
        {activePage === DRAWER_PAGES.HOOKS && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase text-description-fg">
              User Hooks
            </p>
            <HooksEditor
              value={properties.hooks}
              onChange={(v) => setProperty(PROMPT_PROPERTIES.HOOKS, v)}
              inheritedValue={resolvedHooks}
              diagnostics={hookDiagnostics}
            />
          </div>
        )}
      </div>
    </div>
  );
};
