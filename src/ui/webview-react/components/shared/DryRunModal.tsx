import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HARNESS_INFO, MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type {
  CompatibilityDiagnostic,
  CompatibilityDiagnosticSeverity,
} from "@root/types/CompatibilityTypes";
import type {
  CategorizedPromptSectionPreview,
  ConditionDefinitionPreview,
  StepExecutionPreview,
  WorkflowExecutionPreview,
  WorkspaceMutationPreview,
} from "@root/types/ExecutionPreviewTypes";
import type { ExecutionPreviewScope } from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";
import { isStandalone } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { getExecutionPreviewEditorSnapshot } from "@utils/executionPreview";
import { downloadTextFile } from "@utils/diff";
import {
  buildCollapsedOutputPreview,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  formatCollapsedOutputToggleLabel,
  MAX_COLLAPSED_OUTPUT_MAX_CHARS,
} from "@utils/outputTruncation";
import { CustomSelect, type SelectOption } from "./CustomSelect";
import { HarnessIcon } from "./HarnessIcon";
import { Modal } from "./Modal";
import {
  SegmentedTabBar,
  type SegmentedTab,
} from "./SegmentedTabBar";
import {
  getPermissionTabOverride,
  type TabIconOverride,
} from "./tabBadgeUtils";

const DRY_RUN_TABS = {
  SUMMARY: "summary",
  PAYLOAD: "payload",
  COMMAND: "command",
  CONDITIONS: "conditions",
} as const;

type DryRunTab = (typeof DRY_RUN_TABS)[keyof typeof DRY_RUN_TABS];
type RailSelection = "overview" | number;

const DRY_RUN_TAB_DEFINITIONS = [
  { id: DRY_RUN_TABS.SUMMARY, label: "Summary", codicon: "info" },
  { id: DRY_RUN_TABS.PAYLOAD, label: "Payload", codicon: "file-code" },
  { id: DRY_RUN_TABS.COMMAND, label: "Command", codicon: "terminal" },
  {
    id: DRY_RUN_TABS.CONDITIONS,
    label: "Conditions",
    codicon: "symbol-event",
  },
] satisfies readonly SegmentedTab<DryRunTab>[];

const DIAGNOSTIC_SEVERITY_RANK: Record<
  CompatibilityDiagnosticSeverity,
  number
> = {
  info: 1,
  warning: 2,
  error: 3,
};

const DIAGNOSTIC_SEVERITY_STYLE: Record<
  CompatibilityDiagnosticSeverity,
  { icon: string; text: string; dot: string }
> = {
  info: { icon: "info", text: "text-description-fg", dot: "bg-description-fg" },
  warning: { icon: "warning", text: "text-warning-fg", dot: "bg-warning-fg" },
  error: { icon: "error", text: "text-error-fg", dot: "bg-error-fg" },
};

const TRUNCATION_REASON_COPY = {
  reference:
    "Harness will not receive this content: it is represented as a reference.",
  "over-inline-cap":
    "Harness will not receive this content: it exceeded the inline content cap.",
  "chunk-collapsed":
    "Modal view is collapsed: expand this chunk to inspect its body.",
  "body-budget":
    "Harness will not receive this content: the preview body budget omitted it.",
} as const;

export interface DryRunModalProps {
  scope: ExecutionPreviewScope;
  /** Required when opened from within WorkspaceViewerModal. */
  elevated?: boolean;
}

function sameScope(left: ExecutionPreviewScope | null, right: ExecutionPreviewScope) {
  return (
    left?.kind === right.kind &&
    (right.kind !== "step" ||
      (left?.kind === "step" && left.stepIndex === right.stepIndex))
  );
}

function getWorstSeverity(
  diagnostics: readonly CompatibilityDiagnostic[]
): CompatibilityDiagnosticSeverity | undefined {
  return diagnostics.reduce<CompatibilityDiagnosticSeverity | undefined>(
    (worst, diagnostic) => {
      if (
        !worst ||
        DIAGNOSTIC_SEVERITY_RANK[diagnostic.severity] >
          DIAGNOSTIC_SEVERITY_RANK[worst]
      ) {
        return diagnostic.severity;
      }
      return worst;
    },
    undefined
  );
}

function stepLabel(step: StepExecutionPreview): string {
  return step.stepName?.trim() || `${step.type} step`;
}

function stepForScope(
  preview: WorkflowExecutionPreview,
  scope: ExecutionPreviewScope
): StepExecutionPreview | undefined {
  if (scope.kind !== "step") return undefined;
  return preview.steps.find((step) => step.stepIndex === scope.stepIndex);
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function getTokenContribution(step: StepExecutionPreview): number {
  return step.prompt?.sections.reduce(
    (total, section) => total + (section.tokenEstimate ?? 0),
    0
  ) ?? 0;
}

function getPermissionOverride(step: StepExecutionPreview): TabIconOverride | undefined {
  const diagnostics = step.permissionApplication?.diagnostics ?? [];
  return getPermissionTabOverride(
    step.resolvedProperties.permissions.mode ?? "",
    diagnostics.some((diagnostic) => diagnostic.severity !== "info")
  );
}

function DiagnosticList({
  diagnostics,
}: {
  diagnostics: readonly CompatibilityDiagnostic[];
}): React.ReactElement | null {
  if (diagnostics.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" role="list" aria-label="Diagnostics">
      {diagnostics.map((diagnostic, index) => {
        const style = DIAGNOSTIC_SEVERITY_STYLE[diagnostic.severity];
        return (
          <div
            key={`${diagnostic.code}-${diagnostic.propertyPointer ?? ""}-${index}`}
            className={`flex items-start gap-2 rounded border border-panel-border px-3 py-2 text-xs ${style.text}`}
            role="listitem"
          >
            <i
              className={`codicon codicon-${style.icon} mt-px flex-shrink-0`}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div>{diagnostic.message}</div>
              {diagnostic.remediation && (
                <div className="mt-1 text-description-fg">
                  {diagnostic.remediation}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DefinitionList({
  entries,
}: {
  entries: readonly [string, React.ReactNode][];
}): React.ReactElement {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
      {entries.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-description-fg">{label}</dt>
          <dd className="min-w-0 break-words text-editor-fg">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function MutationList({
  mutations,
}: {
  mutations: readonly WorkspaceMutationPreview[];
}): React.ReactElement {
  if (mutations.length === 0) {
    return <p className="text-xs text-description-fg">No workspace mutations.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {mutations.map((mutation, index) => (
        <div
          key={`${mutation.path}-${mutation.operation}-${index}`}
          className="rounded border border-panel-border px-3 py-2 text-xs"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <code className="break-all text-editor-fg">{mutation.path}</code>
            <span className="text-description-fg">{mutation.operation}</span>
          </div>
          {mutation.ownedKeys.length > 0 && (
            <div className="mt-1 text-description-fg">
              Owned keys: {mutation.ownedKeys.join(", ")}
            </div>
          )}
          {mutation.warning && (
            <div className="mt-1 text-warning-fg">{mutation.warning}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function OverviewPanel({
  preview,
}: {
  preview: WorkflowExecutionPreview;
}): React.ReactElement {
  const mutations = preview.steps.flatMap((step) => step.workspaceMutations);
  return (
    <div className="flex flex-col gap-5 p-4">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">Workflow summary</h3>
        <DefinitionList
          entries={[
            ["Steps", formatCount(preview.workflow.stepCount)],
            ["Payload bytes", formatCount(preview.workflow.totalByteCount)],
            ["Token estimate", formatCount(preview.workflow.totalTokenEstimate)],
            ["Workspace mutations", formatCount(mutations.length)],
            ["Harnesses", preview.workflow.harnessIds.join(", ") || "None"],
            ...(preview.workflow.sourcePath
              ? [["Source path", preview.workflow.sourcePath] as [string, React.ReactNode]]
              : []),
          ]}
        />
      </div>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Workflow diagnostics
        </h3>
        {preview.diagnostics.length > 0 ? (
          <DiagnosticList diagnostics={preview.diagnostics} />
        ) : (
          <p className="text-xs text-description-fg">No workflow diagnostics.</p>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Workspace mutations across all steps
        </h3>
        <MutationList mutations={mutations} />
      </section>
    </div>
  );
}

function SummaryPanel({ step }: { step: StepExecutionPreview }): React.ReactElement {
  const properties = step.resolvedProperties;
  const permissionMode = properties.permissions.mode ?? "none";
  return (
    <div className="flex flex-col gap-5 p-4">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">Resolved execution</h3>
        <DefinitionList
          entries={[
            ["Harness", HARNESS_INFO[properties.harnessId]?.name ?? properties.harnessId],
            ["Harness version", properties.harnessVersion ?? "Not reported"],
            ["Model", properties.model ?? "Default"],
            ["Execution mode", properties.executionMode ?? "Default"],
            ["Continuation", properties.continuationMode ?? "Default"],
            ["Session", properties.session.present ? "Present" : "Not present"],
            ["Permission mode", permissionMode],
            ["MCP servers", properties.mcpServerIds.join(", ") || "None"],
            ["Token contribution", formatCount(getTokenContribution(step))],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">Diagnostics</h3>
        {step.diagnostics.length > 0 ? (
          <DiagnosticList diagnostics={step.diagnostics} />
        ) : (
          <p className="text-xs text-description-fg">No step diagnostics.</p>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">Workspace mutations</h3>
        <MutationList mutations={step.workspaceMutations} />
      </section>
    </div>
  );
}

function truncationReasonLabel(
  reason: CategorizedPromptSectionPreview["truncationReason"]
): string | undefined {
  return reason ? TRUNCATION_REASON_COPY[reason] : undefined;
}

function PayloadSection({
  section,
  expanded,
  onToggle,
}: {
  section: CategorizedPromptSectionPreview;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const body = section.body ?? "";
  const collapsed = buildCollapsedOutputPreview(body, {
    expanded,
    maxLines: DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
    maxChars: MAX_COLLAPSED_OUTPUT_MAX_CHARS,
  });
  const reason = truncationReasonLabel(section.truncationReason);
  return (
    <section className="rounded border border-panel-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-panel-border px-3 py-2">
        <div className="min-w-0 text-xs font-semibold text-foreground">
          {section.category} · chunk {section.chunkIndex + 1}
        </div>
        <div className="text-xxs text-description-fg">
          {formatCount(section.byteCount)} bytes
          {section.tokenEstimate != null && ` · ${formatCount(section.tokenEstimate)} tokens`}
        </div>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2">
        {(section.path || section.providerReference) && (
          <div className="break-all text-xxs text-description-fg">
            {section.path ?? section.providerReference}
          </div>
        )}
        {reason && (
          <div className="flex items-start gap-1 text-xxs text-warning-fg" role="note">
            <i className="codicon codicon-warning mt-px flex-shrink-0" aria-hidden="true" />
            <span>{reason}</span>
          </div>
        )}
        {body ? (
          <>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-input-bg p-2 font-mono text-xxs leading-relaxed text-editor-fg">
              {collapsed.visibleText}
            </pre>
            <button
              type="button"
              className="self-start text-xxs text-link-fg hover:underline"
              onClick={onToggle}
            >
              {formatCollapsedOutputToggleLabel(collapsed, expanded)}
            </button>
          </>
        ) : (
          <p className="text-xs text-description-fg">No inline body in this preview.</p>
        )}
      </div>
    </section>
  );
}

function PayloadPanel({
  step,
  expandedChunks,
  onToggleChunk,
}: {
  step: StepExecutionPreview;
  expandedChunks: Readonly<Record<string, boolean>>;
  onToggleChunk: (chunkIndex: number) => void;
}): React.ReactElement {
  const sections = step.prompt?.sections ?? [];
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Categorized payload</h3>
        {step.prompt && (
          <span className="text-xxs text-description-fg">
            {formatCount(step.prompt.includedBodyByteCount)} of {formatCount(step.prompt.totalByteCount)} body bytes shown
          </span>
        )}
      </div>
      {sections.length > 0 ? (
        sections.map((section) => (
          <PayloadSection
            key={`${section.chunkIndex}-${section.category}`}
            section={section}
            expanded={
              expandedChunks[`${step.stepIndex}:${section.chunkIndex}`] ?? false
            }
            onToggle={() => onToggleChunk(section.chunkIndex)}
          />
        ))
      ) : (
        <p className="text-xs text-description-fg">This step has no categorized payload.</p>
      )}
    </div>
  );
}

function CommandPanel({ step }: { step: StepExecutionPreview }): React.ReactElement {
  const command = step.command;
  if (!command) {
    return <p className="p-4 text-xs text-description-fg">This step has no command.</p>;
  }

  return (
    <div className="flex flex-col gap-5 p-4">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">Command</h3>
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-input-bg p-3 font-mono text-xs text-editor-fg">
          {command.displayCommand}
        </pre>
      </section>
      <DefinitionList
        entries={[
          ["Executable", command.executable],
          ["Working directory", command.cwd],
          ["Arguments", command.args.join(" ") || "None"],
          ["Environment keys", command.environmentKeys.join(", ") || "None"],
          [
            "Native permission arguments",
            step.permissionApplication?.nativeArguments.join(" ") || "None",
          ],
        ]}
      />
    </div>
  );
}

function ConditionList({
  title,
  conditions,
}: {
  title: string;
  conditions: readonly ConditionDefinitionPreview[];
}): React.ReactElement {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
      {conditions.length === 0 ? (
        <p className="text-xs text-description-fg">None configured.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {conditions.map((condition, index) => (
            <div
              key={`${condition.kind}-${condition.scriptPath ?? ""}-${index}`}
              className="rounded border border-panel-border px-3 py-2 text-xs"
            >
              <div className="font-semibold text-foreground">{condition.kind}</div>
              <div className="text-description-fg">
                {condition.configured ? condition.description ?? "Configured" : "Not configured"}
              </div>
              {condition.scriptPath && (
                <code className="mt-1 block break-all text-xxs text-editor-fg">
                  {condition.scriptPath}
                </code>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ConditionsPanel({ step }: { step: StepExecutionPreview }): React.ReactElement {
  const conditions = step.conditions;
  return (
    <div className="flex flex-col gap-5 p-4">
      <ConditionList title="Pre-conditions" conditions={conditions.pre} />
      <ConditionList title="End conditions" conditions={conditions.end} />
      <section>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Retry</h3>
        <DefinitionList
          entries={[
            ["Maximum attempts", formatCount(conditions.retry.maxAttempts)],
            ["Backoff", conditions.retry.backoffSeconds == null ? "None" : `${conditions.retry.backoffSeconds}s`],
            ["Error behavior", conditions.errorBehavior ?? "Default"],
          ]}
        />
      </section>
    </div>
  );
}

function StepDetail({
  step,
  activeTab,
  onTabChange,
  expandedChunks,
  onToggleChunk,
}: {
  step: StepExecutionPreview;
  activeTab: DryRunTab;
  onTabChange: (tab: DryRunTab) => void;
  expandedChunks: Readonly<Record<string, boolean>>;
  onToggleChunk: (chunkIndex: number) => void;
}): React.ReactElement {
  const tabOverrides = useMemo(() => {
    const overrides: Partial<Record<DryRunTab, TabIconOverride>> = {};
    const worst = getWorstSeverity(step.diagnostics);
    const permissionOverride = getPermissionOverride(step);
    if (worst) {
      const style = DIAGNOSTIC_SEVERITY_STYLE[worst];
      overrides[DRY_RUN_TABS.SUMMARY] = {
        codicon: "warning",
        color: style.text,
        hoverColor: style.text.replace("text-", "hover:text-"),
        activeColor: style.text,
      };
    } else if (permissionOverride) {
      overrides[DRY_RUN_TABS.SUMMARY] = permissionOverride;
    }
    return overrides;
  }, [step]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-panel-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{stepLabel(step)}</div>
          <div className="mt-1 flex items-center gap-2 text-xxs text-description-fg">
            <HarnessIcon harnessId={step.resolvedProperties.harnessId} size={14} />
            <span>{HARNESS_INFO[step.resolvedProperties.harnessId]?.name ?? step.resolvedProperties.harnessId}</span>
          </div>
        </div>
        <span className="flex-shrink-0 text-xxs text-description-fg">Step {step.stepIndex + 1}</span>
      </div>
      <SegmentedTabBar
        tabs={DRY_RUN_TAB_DEFINITIONS}
        activeTab={activeTab}
        onTabChange={onTabChange}
        harnessId={step.resolvedProperties.harnessId}
        tabOverrides={tabOverrides}
        className="flex flex-shrink-0 items-center border-b border-panel-border bg-sidebar-bg overflow-x-hidden h-10"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === DRY_RUN_TABS.SUMMARY && <SummaryPanel step={step} />}
        {activeTab === DRY_RUN_TABS.PAYLOAD && (
          <PayloadPanel
            step={step}
            expandedChunks={expandedChunks}
            onToggleChunk={onToggleChunk}
          />
        )}
        {activeTab === DRY_RUN_TABS.COMMAND && <CommandPanel step={step} />}
        {activeTab === DRY_RUN_TABS.CONDITIONS && <ConditionsPanel step={step} />}
      </div>
    </div>
  );
}

function Rail({
  preview,
  selection,
  onSelect,
}: {
  preview: WorkflowExecutionPreview;
  selection: RailSelection;
  onSelect: (selection: RailSelection) => void;
}): React.ReactElement {
  return (
    <nav className="flex w-[200px] flex-shrink-0 flex-col border-r border-panel-border bg-sidebar-bg p-2" aria-label="Dry run sections">
      <button
        type="button"
        className={`flex items-center gap-2 rounded px-2 py-2 text-left text-xs transition-colors ${selection === "overview" ? "bg-list-active-selection-bg text-list-active-fg" : "text-description-fg hover:bg-list-hover-bg hover:text-foreground"}`}
        onClick={() => onSelect("overview")}
      >
        <i className="codicon codicon-dashboard" aria-hidden="true" />
        <span className="min-w-0 truncate">Overview</span>
      </button>
      <div className="my-2 border-t border-panel-border" />
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {preview.steps.map((step) => {
          const severity = getWorstSeverity(step.diagnostics);
          const style = severity ? DIAGNOSTIC_SEVERITY_STYLE[severity] : undefined;
          return (
            <button
              key={step.stepIndex}
              type="button"
              className={`flex items-center gap-2 rounded px-2 py-2 text-left text-xs transition-colors ${selection === step.stepIndex ? "bg-list-active-selection-bg text-list-active-fg" : "text-description-fg hover:bg-list-hover-bg hover:text-foreground"}`}
              onClick={() => onSelect(step.stepIndex)}
              title={stepLabel(step)}
            >
              <span className="w-4 flex-shrink-0 text-right text-xxs">{step.stepIndex + 1}</span>
              <HarnessIcon harnessId={step.resolvedProperties.harnessId} size={15} />
              <span className="min-w-0 flex-1 truncate">{stepLabel(step)}</span>
              {style && (
                <span
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${style.dot}`}
                  title={`${severity} diagnostic`}
                  aria-label={`${severity} diagnostic`}
                />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export const DryRunModal: React.FC<DryRunModalProps> = ({ scope, elevated = false }) => {
  const storeScope = useExecutionPreviewStore((state) => state.scope);
  const status = useExecutionPreviewStore((state) => state.status);
  const preview = useExecutionPreviewStore((state) => state.preview);
  const isStale = useExecutionPreviewStore((state) => state.isStale);
  const open = useExecutionPreviewStore((state) => state.open);
  const close = useExecutionPreviewStore((state) => state.close);
  const [selection, setSelection] = useState<RailSelection>(
    scope.kind === "step" ? scope.stepIndex : "overview"
  );
  const [activeTabs, setActiveTabs] = useState<Record<number, DryRunTab>>({});
  const [expandedChunks, setExpandedChunks] = useState<Record<string, boolean>>({});
  const [copiedAction, setCopiedAction] = useState<"command" | "payload" | null>(null);
  const [contentRef, isNarrow] = useElementNarrow(640);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeStepIndex = scope.kind === "step" ? scope.stepIndex : null;

  useEffect(() => {
    setSelection(scopeStepIndex ?? "overview");
    setActiveTabs({});
    setExpandedChunks({});
  }, [scope.kind, scopeStepIndex]);

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    []
  );

  const handleCopy = useCallback(
    async (action: "command" | "payload", value: string | undefined) => {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopiedAction(action);
        if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
        copyResetTimer.current = setTimeout(() => setCopiedAction(null), 1500);
      } catch {
        setCopiedAction(null);
      }
    },
    []
  );

  const handleExport = useCallback(() => {
    if (!preview) return;
    const content = formatJson(preview);
    const filename = `ctrlyoke-${preview.workflow.name.replace(/[^a-z0-9_]/gi, "-").toLowerCase()}-dry-run.json`;
    if (isStandalone) {
      downloadTextFile(filename, content);
    } else {
      sendMessage(MESSAGE_TYPES.EXPORT_CONTENT_PREVIEW, {
        content,
        language: "json",
        title: `Dry run — ${preview.workflow.name}`,
      });
    }
  }, [preview]);

  const handleRun = useCallback(() => {
    close();
    sendMessage(MESSAGE_TYPES.RUN);
  }, [close]);

  const handleRefresh = useCallback(() => {
    open(scope, getExecutionPreviewEditorSnapshot());
  }, [open, scope]);

  if (!sameScope(storeScope, scope)) return null;

  const activeStep =
    preview &&
    (scope.kind === "step"
      ? stepForScope(preview, scope)
      : typeof selection === "number"
        ? preview.steps.find((step) => step.stepIndex === selection)
        : undefined);
  const activeTab = activeStep
    ? (activeTabs[activeStep.stepIndex] ?? DRY_RUN_TABS.SUMMARY)
    : DRY_RUN_TABS.SUMMARY;
  const commandText = activeStep?.command?.displayCommand;
  const payloadText = activeStep?.prompt ? formatJson(activeStep.prompt) : undefined;
  const workflowNarrow = scope.kind === "workflow" && isNarrow;
  const selectOptions: SelectOption[] = [
    { value: "overview", label: "Overview", description: "Workflow summary" },
    ...(preview?.steps.map((step) => ({
      value: String(step.stepIndex),
      label: `${step.stepIndex + 1}. ${stepLabel(step)}`,
      description: HARNESS_INFO[step.resolvedProperties.harnessId]?.name ?? step.resolvedProperties.harnessId,
    })) ?? []),
  ];

  return (
    <Modal
      isOpen
      title={`Dry Run${preview ? ` — ${preview.workflow.name}` : ""}`}
      onClose={close}
      size="xl"
      fullWidthOnNarrow
      bodyClassName="p-0"
      elevated={elevated}
      footer={
        <>
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded transition-colors ${commandText ? "text-description-fg hover:text-foreground" : "cursor-not-allowed text-description-fg opacity-50"}`}
            onClick={() => void handleCopy("command", commandText)}
            disabled={!commandText}
          >
            <i className={`codicon ${copiedAction === "command" ? "codicon-check" : "codicon-copy"}`} />
            Copy command
          </button>
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded transition-colors ${payloadText ? "text-description-fg hover:text-foreground" : "cursor-not-allowed text-description-fg opacity-50"}`}
            onClick={() => void handleCopy("payload", payloadText)}
            disabled={!payloadText}
          >
            <i className={`codicon ${copiedAction === "payload" ? "codicon-check" : "codicon-copy"}`} />
            Copy payload
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-description-fg hover:text-foreground rounded transition-colors"
            onClick={handleExport}
            disabled={!preview}
          >
            <i className="codicon codicon-cloud-download" />
            Export
          </button>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1.5 rounded bg-btn-bg px-3 py-1.5 text-sm text-btn-fg transition-colors hover:bg-btn-hover"
            onClick={handleRun}
          >
            <i className="codicon codicon-play" />
            Run workflow
          </button>
        </>
      }
    >
      {status === "checking" || !preview ? (
        <div className="flex min-h-48 items-center justify-center p-6 text-sm text-description-fg">
          <i className="codicon codicon-loading mr-2 animate-spin" />
          Preparing dry run…
        </div>
      ) : (
        <div ref={contentRef} className="flex min-h-[28rem] min-w-0 flex-col">
          {isStale && (
            <div className="flex items-center gap-2 border-b border-warning-fg border-opacity-40 bg-severity-warning-bg px-4 py-2 text-xs text-warning-fg" role="status">
              <i className="codicon codicon-warning" aria-hidden="true" />
              <span>Definition changed —</span>
              <button
                type="button"
                className="ml-auto rounded px-2 py-1 font-semibold underline hover:bg-toolbar-hover-bg"
                onClick={handleRefresh}
              >
                Refresh
              </button>
            </div>
          )}
          {workflowNarrow && (
            <div className="flex-shrink-0 border-b border-panel-border p-3">
              <CustomSelect
                value={String(selection)}
                onChange={(value) => setSelection(value === "overview" ? "overview" : Number(value))}
                options={selectOptions}
                triggerAriaLabel="Select dry run section"
              />
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            {!workflowNarrow && scope.kind === "workflow" && (
              <Rail preview={preview} selection={selection} onSelect={setSelection} />
            )}
            {selection === "overview" && scope.kind === "workflow" ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <OverviewPanel preview={preview} />
              </div>
            ) : activeStep ? (
              <StepDetail
                step={activeStep}
                activeTab={activeTab}
                onTabChange={(tab) =>
                  setActiveTabs((current) => ({ ...current, [activeStep.stepIndex]: tab }))
                }
                expandedChunks={expandedChunks}
                onToggleChunk={(chunkIndex) => {
                  const key = `${activeStep.stepIndex}:${chunkIndex}`;
                  setExpandedChunks((current) => ({ ...current, [key]: !current[key] }));
                }}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-description-fg">
                The selected step is not available in this preview.
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};
