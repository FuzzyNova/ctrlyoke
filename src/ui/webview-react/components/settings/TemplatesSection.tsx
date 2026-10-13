import { useEffect, useMemo, useRef, useState } from "react";
import {
  HARNESS_IDS,
  MESSAGE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@/types/messages";
import {
  DASHBOARD_HOST_CAPABILITIES,
  TEMPLATE_VARIABLE_TYPES,
  TEMPLATE_SOURCES,
  WORKSPACE_ENTRY_KINDS,
  type HarnessId,
} from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import type { TemplateInfo, TemplateVariable } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import {
  classifyTemplateVariableDefaults,
  shouldClearTemplateVariableDefaults,
} from "@root/utils/TemplateVariableDefaults";
import { defaultModelForHarness } from "@utils/harnessChangeCascade";
import { SettingInputRow } from "../shared/SettingInputRow";
import { TemplateVariableField } from "../workflow/TemplateVariableField";
import { Icon } from "../shared/Icon";
import { CustomSelect } from "../shared/CustomSelect";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { FieldDiagnostic } from "../shared/FieldDiagnostic";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

type CardState = { templateId: string; adding: boolean };
type DraftValues = Record<string, Record<string, string>>;
const EMPTY_TEMPLATE_VALUES: Record<string, Record<string, string>> = {};

function pairedModels(template: TemplateInfo): Map<string, TemplateVariable[]> {
  const pairs = new Map<string, TemplateVariable[]>();
  for (const variable of template.variables ?? []) {
    if (variable.type !== TEMPLATE_VARIABLE_TYPES.MODEL || !variable.harness)
      continue;
    pairs.set(variable.harness, [
      ...(pairs.get(variable.harness) ?? []),
      variable,
    ]);
  }
  return pairs;
}

function variablesForRows(template: TemplateInfo): TemplateVariable[] {
  return (template.variables ?? []).filter(
    (variable) =>
      !(variable.type === TEMPLATE_VARIABLE_TYPES.MODEL && variable.harness)
  );
}

function isMultiline(variable: TemplateVariable): boolean {
  return (
    !!variable.multiline &&
    variable.type !== WORKSPACE_ENTRY_KINDS.FILE &&
    variable.type !== WORKSPACE_ENTRY_KINDS.DIRECTORY &&
    variable.type !== TEMPLATE_VARIABLE_TYPES.SELECT &&
    variable.type !== TEMPLATE_VARIABLE_TYPES.HARNESS
  );
}

function scopeLabel(scope: SettingWriteScope): string {
  return scope === SETTING_SCOPES.WORKSPACE ? "Workspace" : "User";
}

export function TemplatesSection(props: Props) {
  return <TemplateDefaultsPage {...props} />;
}

function TemplateDefaultsPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const vscode = useVsCodeApi();
  const templates = useUiStore((state) => state.templateCatalog);
  const hostCapabilities = useUiStore((state) => state.hostCapabilities);
  const openFileBrowser = useUiStore((state) => state.openFileBrowser);
  const fileSelection = useUiStore((state) => state.templateFileSelection);
  const setFileSelection = useUiStore(
    (state) => state.setTemplateFileSelection
  );
  const modelOptions = useSettingsStore((state) => state.modelOptions);
  const harnessStatus = useSettingsStore((state) => state.harnessStatus);
  const harnessDefaults = useSettingsStore(
    (state) => state.globalSettings.harnessDefaultModels
  );
  const workspaceRoot = useSettingsStore(
    (state) => state.globalSettings.workspaceRoot
  );
  const hasWorkspace = Boolean(workspaceRoot?.trim());
  const scoped = settings.templateVariableDefaultsByScope ?? {
    [SETTING_SCOPES.USER]: {},
    [SETTING_SCOPES.WORKSPACE]: {},
  };
  const currentValues = scoped[activeScope] ?? EMPTY_TEMPLATE_VALUES;
  const otherScope =
    activeScope === SETTING_SCOPES.USER
      ? SETTING_SCOPES.WORKSPACE
      : SETTING_SCOPES.USER;
  const otherValues = scoped[otherScope] ?? {};
  const [extraCards, setExtraCards] = useState<CardState[]>([]);
  const [drafts, setDrafts] = useState<DraftValues>({});
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [noticeByTemplate, setNoticeByTemplate] = useState<
    Record<string, boolean>
  >({});
  const selectRefs = useRef<Record<string, HTMLSelectElement | null>>({});
  const pendingBrowse = useRef<{ templateId: string; variable: string } | null>(
    null
  );

  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.TEMPLATE_CATALOG_REQUEST });
  }, [vscode]);

  useEffect(() => {
    setExtraCards([]);
    setDrafts({});
    setFocusTarget(null);
  }, [activeScope]);

  // Once refreshed settings carry a committed value, its draft is redundant;
  // dropping it lets later edits (including hand edits of settings.json) show.
  useEffect(() => {
    setDrafts((previous) => {
      let changed = false;
      const next: DraftValues = {};
      for (const [templateId, values] of Object.entries(previous)) {
        const kept = Object.fromEntries(
          Object.entries(values).filter(
            ([name, value]) => currentValues[templateId]?.[name] !== value
          )
        );
        if (Object.keys(kept).length !== Object.keys(values).length)
          changed = true;
        if (Object.keys(kept).length) next[templateId] = kept;
      }
      return changed ? next : previous;
    });
  }, [currentValues]);

  useEffect(() => {
    if (!fileSelection) return;
    const target = pendingBrowse.current;
    if (target)
      commit(target.templateId, { [target.variable]: fileSelection.path });
    pendingBrowse.current = null;
    setFileSelection(null);
    // File selection is an event payload; commit is intentionally current to this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSelection]);

  const sortedTemplates = useMemo(() => {
    const ranks = (template: TemplateInfo) =>
      template.isBuiltIn
        ? 0
        : template.source !== TEMPLATE_SOURCES.USER
          ? 1
          : 2;
    return [...templates].sort(
      (a, b) =>
        ranks(a) - ranks(b) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    );
  }, [templates]);
  const templatesById = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates]
  );
  const cardIds = useMemo(() => {
    const ids = new Set(
      Object.keys(currentValues).filter(
        (id) => Object.keys(currentValues[id] ?? {}).length > 0
      )
    );
    for (const card of extraCards) ids.add(card.templateId);
    return [...ids].sort((a, b) => {
      const ta = templatesById.get(a);
      const tb = templatesById.get(b);
      if (!ta) return tb ? 1 : a.localeCompare(b);
      if (!tb) return -1;
      return sortedTemplates.indexOf(ta) - sortedTemplates.indexOf(tb);
    });
  }, [currentValues, extraCards, sortedTemplates, templatesById]);

  function commit(templateId: string, values: Record<string, string | null>) {
    vscode.postMessage({
      type: MESSAGE_TYPES.SET_TEMPLATE_VARIABLE_DEFAULTS,
      templateId,
      values,
      scope: activeScope,
    });
    setDrafts((previous) => {
      const next = { ...previous };
      const templateDrafts = { ...(next[templateId] ?? {}) };
      for (const [name, value] of Object.entries(values)) {
        if (value === null) delete templateDrafts[name];
        else templateDrafts[name] = value;
      }
      if (Object.keys(templateDrafts).length) next[templateId] = templateDrafts;
      else delete next[templateId];
      return next;
    });
  }

  function clearAll(templateId: string, saved: Record<string, string>) {
    const savedNames = Object.keys(saved);
    if (savedNames.length)
      commit(
        templateId,
        Object.fromEntries(savedNames.map((name) => [name, null]))
      );
    // Unsaved rows go too, and the card with them.
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[templateId];
      return next;
    });
    setExtraCards((previous) =>
      previous.filter((card) => card.templateId !== templateId)
    );
  }

  function addCard(templateId: string) {
    setExtraCards((previous) =>
      previous.some((card) => card.templateId === templateId)
        ? previous
        : [...previous, { templateId, adding: true }]
    );
    requestAnimationFrame(() => {
      const picker = selectRefs.current[templateId];
      picker?.focus();
      try {
        (
          picker as (HTMLSelectElement & { showPicker?: () => void }) | null
        )?.showPicker?.();
      } catch {
        // Some browsers require the picker to be opened directly in the input event.
      }
    });
  }

  function addRow(template: TemplateInfo, variable: TemplateVariable) {
    const values = currentValues[template.id] ?? {};
    const group =
      variable.type === TEMPLATE_VARIABLE_TYPES.HARNESS
        ? [variable, ...(pairedModels(template).get(variable.name) ?? [])]
        : [variable];
    const initial: Record<string, string> = {};
    for (const item of group) {
      initial[item.name] =
        values[item.name] ??
        item.default ??
        (item.type === TEMPLATE_VARIABLE_TYPES.SELECT
          ? (item.options?.[0] ?? "")
          : item.type === TEMPLATE_VARIABLE_TYPES.HARNESS
            ? HARNESS_IDS.CLAUDE_CLI
            : "");
    }
    const effective = { ...initial };
    const key = `${template.id}:${variable.name}`;
    setDrafts((previous) => ({
      ...previous,
      [template.id]: { ...(previous[template.id] ?? {}), ...effective },
    }));
    setExtraCards((previous) =>
      previous.some((card) => card.templateId === template.id)
        ? previous
        : [...previous, { templateId: template.id, adding: false }]
    );
    setFocusTarget(key);
    requestAnimationFrame(() =>
      document
        .getElementById(`template-${template.id}-${variable.name}`)
        ?.focus()
    );
    setExtraCards((previous) =>
      previous.map((card) =>
        card.templateId === template.id ? { ...card, adding: false } : card
      )
    );
  }

  function effectiveValue(
    template: TemplateInfo,
    variable: TemplateVariable
  ): string {
    const draftValue = drafts[template.id]?.[variable.name];
    if (draftValue !== undefined) return draftValue;
    return (
      currentValues[template.id]?.[variable.name] ??
      variable.default ??
      (variable.type === TEMPLATE_VARIABLE_TYPES.SELECT
        ? (variable.options?.[0] ?? "")
        : variable.type === TEMPLATE_VARIABLE_TYPES.HARNESS
          ? HARNESS_IDS.CLAUDE_CLI
          : "")
    );
  }

  function onVariableCommit(
    template: TemplateInfo,
    variable: TemplateVariable,
    name: string,
    value: string
  ) {
    const pairModels =
      variable.type === TEMPLATE_VARIABLE_TYPES.HARNESS
        ? (pairedModels(template).get(variable.name) ?? [])
        : [];
    const valuesToPin: Record<string, string> = {};
    if (name !== variable.name) {
      // A model edit saves its harness and every linked model with it, so a
      // pair is never half-written.
      valuesToPin[variable.name] = effectiveValue(template, variable);
      for (const model of pairModels)
        valuesToPin[model.name] =
          model.name === name ? value : effectiveValue(template, model);
    } else if (pairModels.length) {
      valuesToPin[name] = value;
      const harness = value as HarnessId;
      const fallback = defaultModelForHarness(
        harness,
        harnessDefaults,
        modelOptions[harness] ?? []
      );
      for (const model of pairModels) valuesToPin[model.name] = fallback ?? "";
    } else {
      valuesToPin[name] = value;
    }
    if (
      shouldClearTemplateVariableDefaults(
        template.variables ?? [],
        activeScope,
        scoped[SETTING_SCOPES.USER]?.[template.id],
        scoped[SETTING_SCOPES.WORKSPACE]?.[template.id],
        valuesToPin
      )
    ) {
      setNoticeByTemplate((previous) => ({ ...previous, [template.id]: true }));
      window.setTimeout(
        () =>
          setNoticeByTemplate((previous) => ({
            ...previous,
            [template.id]: false,
          })),
        4000
      );
      commit(
        template.id,
        Object.fromEntries(Object.keys(valuesToPin).map((key) => [key, null]))
      );
      return;
    }
    const values: Record<string, string | null> = Object.fromEntries(
      Object.entries(valuesToPin).map(([key, next]) => [
        key,
        next.trim() ? next : null,
      ])
    );
    commit(template.id, values);
  }

  function browse(template: TemplateInfo, variable: TemplateVariable) {
    const selectFolder = variable.type === WORKSPACE_ENTRY_KINDS.DIRECTORY;
    const canUseNative = hostCapabilities.includes(
      DASHBOARD_HOST_CAPABILITIES.selectWorkspacePath
    );
    if (canUseNative) {
      pendingBrowse.current = {
        templateId: template.id,
        variable: variable.name,
      };
      vscode.postMessage({
        type: MESSAGE_TYPES.BROWSE_TEMPLATE_FILE,
        variable: variable.name,
        fileFilter: variable.fileFilter,
        selectFolder,
      });
    } else {
      openFileBrowser({
        mode: selectFolder
          ? WORKSPACE_ENTRY_KINDS.DIRECTORY
          : WORKSPACE_ENTRY_KINDS.FILE,
        fileFilter: variable.fileFilter,
        onSelect: (path) => commit(template.id, { [variable.name]: path }),
      });
    }
  }

  const optionsForDefault = (group: "builtIn" | "workspace" | "user") =>
    sortedTemplates.filter((template) =>
      group === "builtIn"
        ? template.isBuiltIn
        : !template.isBuiltIn &&
          (group === "workspace"
            ? template.source !== TEMPLATE_SOURCES.USER
            : template.source === TEMPLATE_SOURCES.USER)
    );
  const noWorkspace = activeScope === SETTING_SCOPES.WORKSPACE && !hasWorkspace;

  if (noWorkspace)
    return (
      <div className="p-4 text-sm text-description-fg">
        Open a workspace to edit Workspace template values.
      </div>
    );

  return (
    <div
      className="space-y-4"
      data-settings-search-id="landmark:templates.tab"
      data-testid="templates-section"
    >
      <SettingInputRow
        settingKey="general.defaultTemplate"
        id="general-default-template"
        sources={settings.sources}
        onReset={onReset}
        activeScope={activeScope}
      >
        <select
          id="general-default-template"
          value={settings.settings.general.defaultTemplate}
          onChange={(event) =>
            onUpdate("general.defaultTemplate", event.target.value)
          }
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1.5 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        >
          {(
            [
              ["Built-in", optionsForDefault("builtIn")],
              ["Custom (Workspace)", optionsForDefault("workspace")],
              ["Custom (User)", optionsForDefault("user")],
            ] as const
          ).map(([label, entries]) =>
            entries.length ? (
              <optgroup key={label} label={label}>
                {entries.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            ) : null
          )}
        </select>
      </SettingInputRow>

      <section
        data-settings-search-id="landmark:templates.savedValues"
        className="space-y-3"
      >
        <div>
          <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
            Saved variable values
          </h3>
          <p className="mt-1 text-xs text-description-fg">
            Values pre-filled when you create a workflow from a template.
          </p>
        </div>
        {cardIds.length === 0 && (
          <p className="text-sm text-description-fg">
            No saved values in {scopeLabel(activeScope)} settings. Pin a value
            in New Workflow, or add one here.
          </p>
        )}
        {cardIds.map((templateId) => {
          const template = templatesById.get(templateId);
          const saved = currentValues[templateId] ?? {};
          const modelPairs = template
            ? pairedModels(template)
            : new Map<string, TemplateVariable[]>();
          const fields = template ? variablesForRows(template) : [];
          const classified = template
            ? classifyTemplateVariableDefaults(
                template.variables ?? [],
                scoped[SETTING_SCOPES.USER]?.[templateId],
                scoped[SETTING_SCOPES.WORKSPACE]?.[templateId]
              )
            : null;
          const issues = new Map(
            classified?.issues
              .filter((issue) => issue.scope === activeScope)
              .map((issue) => [issue.variableName, issue]) ?? []
          );
          const hasValue = (name: string) =>
            Object.prototype.hasOwnProperty.call(saved, name);
          const hasDraft = (name: string) =>
            drafts[templateId]?.[name] !== undefined;
          const savedRows = template
            ? fields.filter((field) =>
                field.type === TEMPLATE_VARIABLE_TYPES.HARNESS
                  ? hasValue(field.name) ||
                    (modelPairs.get(field.name) ?? []).some((m) =>
                      hasValue(m.name)
                    )
                  : hasValue(field.name)
              )
            : [];
          const available = template
            ? fields.filter(
                (field) =>
                  !hasValue(field.name) &&
                  !hasDraft(field.name) &&
                  !(
                    field.type === TEMPLATE_VARIABLE_TYPES.HARNESS &&
                    (modelPairs.get(field.name) ?? []).some((m) =>
                      hasValue(m.name)
                    )
                  ) &&
                  !isMultiline(field)
              )
            : [];
          const card = extraCards.find(
            (item) => item.templateId === templateId
          );
          // Declaration order, whether a row is saved or still a draft.
          const showFields = fields.filter(
            (field) => savedRows.includes(field) || hasDraft(field.name)
          );
          return (
            <article
              key={templateId}
              className="rounded border border-panel-border bg-panel-bg/40 p-3 space-y-3"
              data-testid={`template-card-${templateId}`}
            >
              <header className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-medium text-foreground">
                    {template?.name ?? templateId}
                    {!template && (
                      <span className="ml-1 text-description-fg">
                        (template not found)
                      </span>
                    )}
                  </h4>
                  <p className="font-mono text-xs text-description-fg">
                    {templateId}
                  </p>
                </div>
                <button
                  type="button"
                  className="text-xs text-description-fg hover:text-error-fg"
                  aria-label={`Clear all ${templateId}`}
                  onClick={() => clearAll(templateId, saved)}
                >
                  Clear all
                </button>
              </header>
              {noticeByTemplate[templateId] && (
                <p role="status" className="text-xs text-description-fg">
                  Matches the inherited value, so nothing is saved
                </p>
              )}
              {showFields.map((variable) => {
                const paired =
                  variable.type === TEMPLATE_VARIABLE_TYPES.HARNESS
                    ? (modelPairs.get(variable.name) ?? [])
                    : [];
                const names = [
                  variable.name,
                  ...paired.map((model) => model.name),
                ];
                const stale =
                  !template ||
                  names.some(
                    (name) => issues.get(name)?.reason === "unknown-variable"
                  );
                const invalidHarness =
                  issues.get(variable.name)?.reason === "invalid-harness";
                const invalidSelect =
                  issues.get(variable.name)?.reason === "invalid-select";
                const stored = template
                  ? effectiveValue(template, variable)
                  : (saved[variable.name] ?? "");
                const inherited = variable.authoredDefault ?? "none";
                const crossHint = names.some(
                  (name) => otherValues[templateId]?.[name] !== undefined
                );
                const invalidOptions: Array<{ value: string; label: string }> =
                  invalidHarness
                    ? Object.values(HARNESS_IDS).map((harness) => ({
                        value: harness,
                        label: harness,
                      }))
                    : (variable.options ?? []).map((option) => ({
                        value: option,
                        label: option,
                      }));
                if (
                  (invalidHarness || invalidSelect) &&
                  !invalidOptions.some((option) => option.value === stored)
                )
                  invalidOptions.push({ value: stored, label: stored });
                return (
                  <div
                    key={variable.name}
                    data-focus-target={
                      focusTarget === `${templateId}:${variable.name}`
                        ? "true"
                        : undefined
                    }
                    className="grid grid-cols-[minmax(7rem,0.7fr)_minmax(0,2fr)_auto] gap-x-2 gap-y-1 items-start border-t border-panel-border pt-3"
                  >
                    <span className="pt-2 font-mono text-xs text-foreground">
                      {variable.name}
                      {paired.map((model) => (
                        <span key={model.name} className="block mt-3">
                          {model.name}
                        </span>
                      ))}
                    </span>
                    <div className="min-w-0 space-y-1">
                      {stale ? (
                        <div className="px-2 py-1.5 font-mono text-xs text-description-fg">
                          {names
                            .map((name) => `${name}: ${saved[name] ?? ""}`)
                            .join(" · ")}
                        </div>
                      ) : invalidHarness || invalidSelect ? (
                        <CustomSelect
                          id={`template-${templateId}-${variable.name}`}
                          schemaPath={`vars.${variable.name}`}
                          triggerAriaLabel={variable.name}
                          value={stored}
                          onChange={(value) =>
                            onVariableCommit(
                              template,
                              variable,
                              variable.name,
                              value
                            )
                          }
                          options={invalidOptions}
                          warning={
                            invalidHarness
                              ? "Not a known harness; the value is ignored"
                              : "This value is not an option; the value is ignored"
                          }
                        />
                      ) : (
                        <TemplateVariableField
                          variable={variable}
                          value={stored}
                          values={{ ...saved, ...drafts[templateId] }}
                          pairedModels={paired}
                          modelOptions={modelOptions}
                          harnessStatus={harnessStatus}
                          multiline={isMultiline(variable)}
                          idPrefix={`template-${templateId}`}
                          onChange={(name, value) =>
                            setDrafts((previous) => ({
                              ...previous,
                              [templateId]: {
                                ...(previous[templateId] ?? {}),
                                [name]: value,
                              },
                            }))
                          }
                          onCommit={(name, value) =>
                            onVariableCommit(template, variable, name, value)
                          }
                          onBrowse={(selected) => browse(template, selected)}
                          commitTextOnBlur
                        />
                      )}
                      <p className="text-xs text-description-fg">
                        Template default: {inherited}
                      </p>
                      {crossHint && (
                        <p className="text-xs text-description-fg">
                          {activeScope === SETTING_SCOPES.USER
                            ? "Workspace also saves this; its value wins in this workspace."
                            : `Overrides your User value: ${otherValues[templateId]?.[variable.name] ?? otherValues[templateId]?.[names[0]]}`}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="icon-btn mt-1 text-description-fg hover:text-error-fg"
                      aria-label={`Clear ${variable.name}`}
                      onClick={() =>
                        commit(
                          templateId,
                          Object.fromEntries(names.map((name) => [name, null]))
                        )
                      }
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                );
              })}
              {Object.keys(saved)
                .filter(
                  (name) =>
                    !template?.variables?.some(
                      (variable) => variable.name === name
                    )
                )
                .map((name) => (
                  <div
                    key={name}
                    className="grid grid-cols-[minmax(7rem,0.7fr)_minmax(0,2fr)_auto] gap-2 items-start border-t border-panel-border pt-3"
                  >
                    <span className="pt-2 font-mono text-xs">{name}</span>
                    <div>
                      <p className="font-mono text-xs text-description-fg">
                        {saved[name]}
                      </p>
                      {template && (
                        <FieldDiagnostic
                          id={`stale-${templateId}-${name}`}
                          diagnostics={[
                            {
                              severity: "warning",
                              message:
                                "This template no longer has this variable; the value is ignored",
                            },
                          ]}
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      className="icon-btn mt-1 text-description-fg hover:text-error-fg"
                      aria-label={`Clear ${name}`}
                      onClick={() => commit(templateId, { [name]: null })}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                ))}
              {template && (
                <div className="border-t border-panel-border pt-3">
                  <label
                    className="sr-only"
                    htmlFor={`add-value-${templateId}`}
                  >
                    Add value
                  </label>
                  <select
                    ref={(node) => {
                      selectRefs.current[templateId] = node;
                    }}
                    id={`add-value-${templateId}`}
                    value=""
                    onChange={(event) => {
                      const chosen = available.find(
                        (entry) => entry.name === event.target.value
                      );
                      if (chosen) addRow(template, chosen);
                    }}
                    className="bg-input-bg border border-input-border rounded-sm px-2 py-1 text-xs text-foreground"
                  >
                    <option value="">+ Add value</option>
                    {available.map((variable) => (
                      <option key={variable.name} value={variable.name}>
                        {variable.name}
                      </option>
                    ))}
                  </select>
                  {card?.adding && (
                    <span className="ml-2 text-xs text-description-fg">
                      Choose a variable to add.
                    </span>
                  )}
                </div>
              )}
            </article>
          );
        })}
        <label className="sr-only" htmlFor="add-template">
          Add template
        </label>
        <select
          id="add-template"
          value=""
          onChange={(event) => {
            if (event.target.value) addCard(event.target.value);
          }}
          className="bg-input-bg border border-input-border rounded-sm px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">+ Add template</option>
          {sortedTemplates
            .filter((template) => !cardIds.includes(template.id))
            .map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
        </select>
      </section>
    </div>
  );
}
