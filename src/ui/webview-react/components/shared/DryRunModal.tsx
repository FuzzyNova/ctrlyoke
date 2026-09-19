import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  HARNESS_INFO,
  MESSAGE_TYPES,
  PREVIEW_MUTATION_SCOPES,
  PREVIEW_SCOPES,
  PREVIEW_RAIL_SELECTIONS,
  PREVIEW_STATUSES,
  PREVIEW_PROMPT_CATEGORIES,
  PREVIEW_PROMPT_CATEGORY_LABELS,
  PREVIEW_TRUNCATION_REASON_COPY,
  PREVIEW_TRUNCATION_REASONS,
  WORKTREE_CONFIG_ORIGINS,
  WORKTREE_MODE_OPTIONS,
  WORKTREE_MODES,
} from "@root/types/DashboardConstants";
import type {
  CompatibilityDiagnostic,
  CompatibilityDiagnosticSeverity,
} from "@root/types/CompatibilityTypes";
import type {
  CategorizedPromptPreview,
  CategorizedPromptSectionPreview,
  CommandPreview,
  ConditionDefinitionPreview,
  StepExecutionPreview,
  WorkflowExecutionPreview,
  WorkspaceMutationPreview,
  WorktreeExecutionPreview,
} from "@root/types/ExecutionPreviewTypes";
import type { ExecutionPreviewScope } from "@root/types/WebviewMessageTypes";
import type { PortabilityReport } from "@root/types/PortabilityReport";
import {
  COMMAND_DISPLAY_SHELL_LABELS,
  renderCommandForDisplay,
  type CommandDisplayShell,
} from "@root/types/CommandDisplayFormatter";
import { sendMessage } from "@hooks/useMessageHandler";
import { isStandalone } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { useCompatibilityDiagnostics } from "@hooks/useCompatibilityDiagnostics";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { getExecutionPreviewEditorSnapshot } from "@utils/executionPreview";
import { downloadTextFile } from "@utils/diff";
import {
  buildStepTimeline,
  STEP_TIMELINE_ENTRY_KINDS,
  type StepTimelineEntry,
} from "@utils/dryRunTimeline";
import {
  buildCollapsedOutputPreview,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  formatCollapsedOutputToggleLabel,
  MAX_COLLAPSED_OUTPUT_MAX_CHARS,
} from "@utils/outputTruncation";
import { formatMagnitude } from "@utils/number";
import { CustomSelect, type SelectOption } from "./CustomSelect";
import { HarnessIcon } from "./HarnessIcon";
import { Modal } from "./Modal";
import { PortabilityReportSection } from "./PortabilityReportSection";
import { SegmentedTabBar, type SegmentedTab } from "./SegmentedTabBar";
import { getPermissionModeBadge, type TabIconOverride } from "./tabBadgeUtils";
import { Icon } from "./Icon";

const DRY_RUN_TABS = {
  SUMMARY: "summary",
  PAYLOAD: "payload",
  COMMAND: "command",
  CONDITIONS: "conditions",
} as const;

type DryRunTab = (typeof DRY_RUN_TABS)[keyof typeof DRY_RUN_TABS];
type RailSelection = typeof PREVIEW_RAIL_SELECTIONS.OVERVIEW | number;

const DRY_RUN_TAB_DEFINITIONS = [
  { id: DRY_RUN_TABS.SUMMARY, label: "Summary", codicon: "map-vertical" },
  { id: DRY_RUN_TABS.COMMAND, label: "Command", codicon: "terminal" },
  { id: DRY_RUN_TABS.PAYLOAD, label: "Payload", codicon: "file-code" },
  {
    id: DRY_RUN_TABS.CONDITIONS,
    label: "Conditions",
    codicon: "coverage",
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

export interface DryRunModalProps {
  scope: ExecutionPreviewScope;
  /** Required when opened from within WorkspaceViewerModal. */
  elevated?: boolean;
}

function sameScope(
  left: ExecutionPreviewScope | null,
  right: ExecutionPreviewScope
) {
  return (
    left?.kind === right.kind &&
    (right.kind !== PREVIEW_SCOPES.STEP ||
      (left?.kind === PREVIEW_SCOPES.STEP &&
        left.stepIndex === right.stepIndex))
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
  if (scope.kind !== PREVIEW_SCOPES.STEP) return undefined;
  return preview.steps.find((step) => step.stepIndex === scope.stepIndex);
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function getTokenContribution(step: StepExecutionPreview): number {
  return (
    step.prompt?.sections.reduce(
      (total, section) => total + (section.tokenEstimate ?? 0),
      0
    ) ?? 0
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
            <Icon name={style.icon} className="mt-px flex-shrink-0" />
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

const WORKTREE_MODE_LABEL: Record<string, string> = Object.fromEntries(
  WORKTREE_MODE_OPTIONS.map((option) => [option.value, option.label])
);

function WorktreeSummary({
  worktree,
}: {
  worktree: WorktreeExecutionPreview;
}): React.ReactElement {
  const entries: [string, React.ReactNode][] = [
    ["Mode", WORKTREE_MODE_LABEL[worktree.mode] ?? worktree.mode],
    [
      "Source",
      worktree.origin === WORKTREE_CONFIG_ORIGINS.AUTHORED
        ? "Workflow"
        : "Default setting",
    ],
    ...(worktree.branch
      ? ([["Branch", worktree.branch]] as [string, React.ReactNode][])
      : []),
    ...(worktree.base
      ? ([["Base", worktree.base]] as [string, React.ReactNode][])
      : []),
    [
      "Working directory",
      worktree.plannedDirectory ? (
        <code className="break-all">{worktree.plannedDirectory}</code>
      ) : (
        "Not yet known"
      ),
    ],
  ];
  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-foreground">Worktree</h3>
      <DefinitionList entries={entries} />
      {!worktree.eligible && (
        <div className="mt-2 flex items-start gap-1 rounded border border-error-fg border-opacity-40 bg-severity-error-bg px-3 py-2 text-xs text-error-fg">
          <Icon name="error" className="mt-px flex-shrink-0" />
          <span>
            This run will not use a worktree
            {worktree.eligibilityReason
              ? `: ${worktree.eligibilityReason}`
              : "."}
          </span>
        </div>
      )}
      {worktree.eligible && worktree.plannedDirectoryNotice && (
        <div className="mt-2 flex items-start gap-1 text-xxs text-description-fg">
          <Icon name="info" className="mt-px flex-shrink-0" />
          <span>{worktree.plannedDirectoryNotice}</span>
        </div>
      )}
    </section>
  );
}

const TIMELINE_BLOCK_KINDS = {
  ENTRY: "entry",
  RUN_LOCAL_GROUP: "run-local-group",
} as const;

type TimelineBlock =
  | {
      kind: typeof TIMELINE_BLOCK_KINDS.ENTRY;
      entry: StepTimelineEntry;
      index: number;
    }
  | {
      kind: typeof TIMELINE_BLOCK_KINDS.RUN_LOCAL_GROUP;
      groupId: string;
      mutations: readonly WorkspaceMutationPreview[];
    };

function buildTimelineBlocks(
  entries: readonly StepTimelineEntry[]
): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let index = 0;

  while (index < entries.length) {
    const entry = entries[index];
    if (
      entry.kind === STEP_TIMELINE_ENTRY_KINDS.MUTATION &&
      entry.mutation.scope === PREVIEW_MUTATION_SCOPES.RUN_LOCAL
    ) {
      const mutations: WorkspaceMutationPreview[] = [];
      const groupStart = index;
      while (index < entries.length) {
        const groupedEntry = entries[index];
        if (
          groupedEntry.kind !== STEP_TIMELINE_ENTRY_KINDS.MUTATION ||
          groupedEntry.mutation.scope !== PREVIEW_MUTATION_SCOPES.RUN_LOCAL
        ) {
          break;
        }
        mutations.push(groupedEntry.mutation);
        index += 1;
      }
      blocks.push({
        kind: TIMELINE_BLOCK_KINDS.RUN_LOCAL_GROUP,
        groupId: `run-local-${groupStart}`,
        mutations,
      });
      continue;
    }

    blocks.push({ kind: TIMELINE_BLOCK_KINDS.ENTRY, entry, index });
    index += 1;
  }

  return blocks;
}

function formatPayloadFileCount(fileCount: number): string {
  return `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
}

function TimelineEntryRow({
  entry,
  onNavigate,
}: {
  entry: StepTimelineEntry;
  onNavigate: (tab: DryRunTab) => void;
}): React.ReactElement {
  if (entry.kind === STEP_TIMELINE_ENTRY_KINDS.PAYLOAD) {
    return (
      <div className="flex items-center justify-between gap-3 rounded border border-panel-border px-3 py-2 text-xs">
        <div className="min-w-0 truncate text-editor-fg">
          <Icon name="file-code" className="mr-2 text-description-fg" />
          Payload — {formatPayloadFileCount(entry.fileCount)},{" "}
          {formatMagnitude(entry.totalByteCount)} bytes
        </div>
        <button
          type="button"
          className="flex-shrink-0 text-link-fg hover:underline"
          onClick={() => onNavigate(DRY_RUN_TABS.PAYLOAD)}
        >
          View in Payload tab
        </button>
      </div>
    );
  }

  if (entry.kind === STEP_TIMELINE_ENTRY_KINDS.COMMAND) {
    return (
      <div className="flex items-center justify-between gap-3 rounded border border-panel-border px-3 py-2 text-xs">
        <div className="min-w-0 truncate text-editor-fg">
          <Icon name="terminal" className="mr-2 text-description-fg" />
          Command — <code>{entry.executable}</code> · cwd:{" "}
          <code>{entry.cwd}</code>
        </div>
        <button
          type="button"
          className="flex-shrink-0 text-link-fg hover:underline"
          onClick={() => onNavigate(DRY_RUN_TABS.COMMAND)}
        >
          View in Command tab
        </button>
      </div>
    );
  }

  const { mutation } = entry;
  const isShared = mutation.scope === PREVIEW_MUTATION_SCOPES.SHARED;
  return (
    <div
      className={`rounded border px-3 py-2 text-xs ${
        isShared
          ? "border-warning-fg border-opacity-40 bg-severity-warning-bg"
          : "border-panel-border"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {mutation.path && (
          <code className="break-all text-editor-fg">{mutation.path}</code>
        )}
        <span className={isShared ? "text-warning-fg" : "text-description-fg"}>
          {mutation.operation}
        </span>
      </div>
      {isShared ? (
        <div className="mt-1 flex items-start gap-1 text-warning-fg">
          <Icon name="warning" className="mt-px flex-shrink-0" />
          <span>{mutation.warning ?? "Workspace-wide side effect."}</span>
        </div>
      ) : (
        <div className="mt-1 text-description-fg">
          Internal — .ctrlyoke/temp, cleared after this run
        </div>
      )}
      {isShared && mutation.ownedKeys.length > 0 && (
        <div className="mt-1 text-description-fg">
          Merges into existing keys: {mutation.ownedKeys.join(", ")}
        </div>
      )}
    </div>
  );
}

function TimelineSection({
  entries,
  onNavigate,
}: {
  entries: readonly StepTimelineEntry[];
  onNavigate: (tab: DryRunTab) => void;
}): React.ReactElement {
  const blocks = useMemo(() => buildTimelineBlocks(entries), [entries]);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {}
  );

  if (blocks.length === 0) {
    return <p className="text-xs text-description-fg">No timeline entries.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block) => {
        if (block.kind === TIMELINE_BLOCK_KINDS.ENTRY) {
          return (
            <TimelineEntryRow
              key={`timeline-${block.index}`}
              entry={block.entry}
              onNavigate={onNavigate}
            />
          );
        }

        const expanded = expandedGroups[block.groupId] ?? false;
        if (expanded) {
          return (
            <div key={block.groupId} className="flex flex-col gap-2">
              {block.mutations.map((mutation, index) => (
                <TimelineEntryRow
                  key={`${block.groupId}-${mutation.path ?? "no-path"}-${mutation.operation}-${index}`}
                  entry={{ kind: STEP_TIMELINE_ENTRY_KINDS.MUTATION, mutation }}
                  onNavigate={onNavigate}
                />
              ))}
              <button
                type="button"
                className="self-start text-xxs text-link-fg hover:underline"
                aria-expanded="true"
                onClick={() =>
                  setExpandedGroups((current) => ({
                    ...current,
                    [block.groupId]: false,
                  }))
                }
              >
                Collapse internal changes
              </button>
            </div>
          );
        }

        return (
          <button
            key={block.groupId}
            type="button"
            className="flex items-center justify-between gap-3 rounded border border-panel-border px-3 py-2 text-left text-xs text-description-fg hover:text-foreground"
            aria-expanded="false"
            onClick={() =>
              setExpandedGroups((current) => ({
                ...current,
                [block.groupId]: true,
              }))
            }
          >
            <span>
              {block.mutations.length} internal{" "}
              {block.mutations.length === 1 ? "change" : "changes"} —
              .ctrlyoke/temp, cleared after this run
            </span>
            <span aria-hidden="true">▸</span>
          </button>
        );
      })}
    </div>
  );
}

function StepTimelineHeading({
  step,
}: {
  step: StepExecutionPreview;
}): React.ReactElement {
  return (
    <div
      className="flex items-center gap-2 rounded px-2 py-2 text-left text-xs text-description-fg"
      aria-label={`Step ${step.stepIndex + 1}: ${stepLabel(step)}`}
    >
      <span className="w-4 flex-shrink-0 text-right text-xxs">
        {step.stepIndex + 1}
      </span>
      <HarnessIcon harnessId={step.resolvedProperties.harnessId} size={15} />
      <span className="min-w-0 flex-1 truncate">{stepLabel(step)}</span>
    </div>
  );
}

function OverviewPanel({
  preview,
  onNavigateToStepTab,
  portabilityReport,
  portabilityReportChecking,
}: {
  preview: WorkflowExecutionPreview;
  onNavigateToStepTab: (stepIndex: number, tab: DryRunTab) => void;
  portabilityReport: PortabilityReport | null;
  portabilityReportChecking: boolean;
}): React.ReactElement {
  const mutations = preview.steps.flatMap((step) => step.workspaceMutations);
  const stepsWithTimeline = preview.steps
    .map((step) => ({ step, entries: buildStepTimeline(step) }))
    .filter(({ entries }) => entries.length > 0);
  const renderedGroupIds = new Set<string>();
  return (
    <div className="flex flex-col gap-5 p-4">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Workflow summary
        </h3>
        <DefinitionList
          entries={[
            ["Steps", formatCount(preview.workflow.stepCount)],
            ["Payload bytes", formatMagnitude(preview.workflow.totalByteCount)],
            [
              "Token estimate",
              formatMagnitude(preview.workflow.totalTokenEstimate),
            ],
            ["Workspace mutations", formatCount(mutations.length)],
            ["Harnesses", preview.workflow.harnessIds.join(", ") || "None"],
            ...(preview.workflow.sourcePath
              ? [
                  ["Source path", preview.workflow.sourcePath] as [
                    string,
                    React.ReactNode,
                  ],
                ]
              : []),
          ]}
        />
      </div>

      {preview.worktree && <WorktreeSummary worktree={preview.worktree} />}

      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Workflow diagnostics
        </h3>
        {preview.diagnostics.length > 0 ? (
          <DiagnosticList diagnostics={preview.diagnostics} />
        ) : (
          <p className="text-xs text-description-fg">
            No workflow diagnostics.
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Workflow timeline
        </h3>
        <div className="flex flex-col gap-3">
          {stepsWithTimeline.flatMap(({ step, entries }) => {
            const group = step.parallelGroupId
              ? preview.parallelGroups.find(
                  (candidate) => candidate.id === step.parallelGroupId
                )
              : undefined;
            if (!group) {
              return [
                <section key={step.stepIndex} className="flex flex-col gap-2">
                  <StepTimelineHeading step={step} />
                  <TimelineSection
                    entries={entries}
                    onNavigate={(tab) =>
                      onNavigateToStepTab(step.stepIndex, tab)
                    }
                  />
                </section>,
              ];
            }
            if (renderedGroupIds.has(group.id)) return [];
            renderedGroupIds.add(group.id);
            const groupPreflight = preview.parallelGroupPreflights.find(
              (candidate) => candidate.parallelGroupId === group.id
            );
            const effectiveWidth = groupPreflight?.effectiveWidth ?? 1;
            const executableMemberCount =
              groupPreflight?.executableMemberCount ??
              group.endIndex - group.startIndex + 1;
            const members = stepsWithTimeline.filter(
              (candidate) => candidate.step.parallelGroupId === group.id
            );
            const executionSummary =
              effectiveWidth <= 1
                ? "runs sequentially"
                : `${Math.min(executableMemberCount, effectiveWidth)} of ${executableMemberCount} will run concurrently (width ${effectiveWidth})`;
            return [
              <section
                key={group.id}
                className="flex flex-col gap-2 rounded border border-panel-border p-2"
                aria-label={`Parallel steps ${group.startIndex + 1}–${group.endIndex + 1}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-foreground">
                    Parallel steps {group.startIndex + 1}–{group.endIndex + 1}
                  </span>
                  <span className="text-description-fg">
                    failFast: {String(group.failFast)} · {executionSummary}
                  </span>
                </div>
                {members.map((member) => (
                  <div
                    key={member.step.stepIndex}
                    className="flex flex-col gap-2 border-l border-panel-border pl-2"
                  >
                    <StepTimelineHeading step={member.step} />
                    <TimelineSection
                      entries={member.entries}
                      onNavigate={(tab) =>
                        onNavigateToStepTab(member.step.stepIndex, tab)
                      }
                    />
                  </div>
                ))}
              </section>,
            ];
          })}
        </div>
      </section>

      <PortabilityReportSection
        report={portabilityReport}
        isChecking={portabilityReportChecking}
      />
    </div>
  );
}

function SummaryPanel({
  step,
  onNavigate,
}: {
  step: StepExecutionPreview;
  onNavigate: (tab: DryRunTab) => void;
}): React.ReactElement {
  const properties = step.resolvedProperties;
  const permissionMode = properties.permissions.mode ?? "none";
  return (
    <div className="flex flex-col gap-5 p-4">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Resolved execution
        </h3>
        <DefinitionList
          entries={[
            [
              "Harness",
              HARNESS_INFO[properties.harnessId]?.name ?? properties.harnessId,
            ],
            ["Harness version", properties.harnessVersion ?? "Not reported"],
            ["Model", properties.model ?? "Default"],
            ["Execution mode", properties.executionMode ?? "Default"],
            ["Continuation", properties.continuationMode ?? "Default"],
            ["Session", properties.session.present ? "Present" : "Not present"],
            ["Permission mode", permissionMode],
            [
              "Granted secrets",
              properties.secrets && properties.secrets.length > 0
                ? properties.secrets
                    .map((name) => `${name} [REDACTED]`)
                    .join(", ")
                : "None",
            ],
            ["MCP servers", properties.mcpServerIds.join(", ") || "None"],
            ["Token contribution", formatMagnitude(getTokenContribution(step))],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Diagnostics
        </h3>
        {step.diagnostics.length > 0 ? (
          <DiagnosticList diagnostics={step.diagnostics} />
        ) : (
          <p className="text-xs text-description-fg">No step diagnostics.</p>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">Timeline</h3>
        <TimelineSection
          entries={buildStepTimeline(step)}
          onNavigate={onNavigate}
        />
      </section>
    </div>
  );
}

function truncationReasonLabel(
  reason: CategorizedPromptSectionPreview["truncationReason"]
): string | undefined {
  return reason ? PREVIEW_TRUNCATION_REASON_COPY[reason] : undefined;
}

function isNeutralTruncationReason(
  reason: CategorizedPromptSectionPreview["truncationReason"]
): boolean {
  return (
    reason === PREVIEW_TRUNCATION_REASONS.REFERENCE ||
    reason === PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE
  );
}

function getPathBasename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

function FileReferenceSection({
  section,
}: {
  section: CategorizedPromptSectionPreview;
}): React.ReactElement {
  const path = section.path ?? section.providerReference ?? "";
  const basename = section.path ? getPathBasename(section.path) : path;

  return (
    <section className="rounded border border-panel-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-panel-border px-3 py-2">
        <div className="min-w-0 text-xs font-semibold text-foreground">
          {
            PREVIEW_PROMPT_CATEGORY_LABELS[
              PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE
            ]
          }{" "}
          {basename}
        </div>
        <div className="text-xxs text-description-fg">
          {formatMagnitude(section.byteCount)} bytes
          {section.tokenEstimate != null &&
            ` · ${formatMagnitude(section.tokenEstimate)} tokens`}
        </div>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2">
        {section.path && (
          <div className="break-all text-xxs text-description-fg">
            {section.path}
          </div>
        )}
        <p className="text-xxs text-description-fg" role="note">
          {PREVIEW_TRUNCATION_REASON_COPY[PREVIEW_TRUNCATION_REASONS.REFERENCE]}
        </p>
      </div>
    </section>
  );
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
  if (section.category === PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE) {
    return <FileReferenceSection section={section} />;
  }

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
          {PREVIEW_PROMPT_CATEGORY_LABELS[section.category]} · chunk{" "}
          {section.chunkIndex + 1}
        </div>
        <div className="text-xxs text-description-fg">
          {formatMagnitude(section.byteCount)} bytes
          {section.tokenEstimate != null &&
            ` · ${formatMagnitude(section.tokenEstimate)} tokens`}
        </div>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2">
        {(section.path || section.providerReference) && (
          <div className="break-all text-xxs text-description-fg">
            {section.path ?? section.providerReference}
          </div>
        )}
        {reason && (
          <div
            className={`flex items-start gap-1 text-xxs ${
              isNeutralTruncationReason(section.truncationReason)
                ? "text-description-fg"
                : "text-warning-fg"
            }`}
            role="note"
          >
            {!isNeutralTruncationReason(section.truncationReason) && (
              <Icon name="warning" className="mt-px flex-shrink-0" />
            )}
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
          <p className="text-xs text-description-fg">
            No inline body in this preview.
          </p>
        )}
      </div>
    </section>
  );
}

/** Reconstructs the categorized payload as one plain-text document, in
 * delivery order, for pasting into a harness ctrlyoke does not natively
 * support. File references render as their provider-formatted marker (never
 * their content — Tier 1 never embeds file bytes); a section with no body
 * (Tier 2/3 content cut by a size or budget cap) renders a placeholder
 * naming why, so an omission is never silently invisible in the copy. */
function buildExpandedPayloadText(prompt: CategorizedPromptPreview): string {
  return prompt.sections
    .map((section) => {
      if (section.category === PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE) {
        return section.providerReference ?? section.path ?? "";
      }
      if (section.body) return section.body;
      const reason = truncationReasonLabel(section.truncationReason);
      return `[${PREVIEW_PROMPT_CATEGORY_LABELS[section.category]} omitted${reason ? `: ${reason}` : ""}]`;
    })
    .join("\n\n");
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
        <h3 className="text-sm font-semibold text-foreground">
          Categorized payload
        </h3>
        {step.prompt && (
          <span className="text-xxs text-description-fg">
            {formatMagnitude(step.prompt.includedBodyByteCount)} of{" "}
            {formatMagnitude(step.prompt.totalByteCount)} body bytes shown
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
        <p className="text-xs text-description-fg">
          This step has no categorized payload.
        </p>
      )}
    </div>
  );
}

/** On the default shell, return the DTO's own `displayCommand` byte-for-byte
 * (the snapshot rule: the plan renders what it was given). Only a shell the
 * user explicitly toggled to is recomputed from `args`. */
function resolveCommandDisplayText(
  command: CommandPreview,
  shell: CommandDisplayShell
): string {
  if (shell === command.displayShell) return command.displayCommand;
  return renderCommandForDisplay(command.executable, command.args, shell, {
    requiresShellVerbatimArgs: command.requiresShellVerbatimArgs,
  });
}

function summarizeCommandDisplayText(displayText: string): string {
  const firstNewline = displayText.search(/\r?\n/);
  return firstNewline === -1
    ? displayText
    : `${displayText.slice(0, firstNewline)} …`;
}

/** Windows commands can be rendered for either terminal; POSIX ones and the
 * rare `.cmd`/`.bat` verbatim fallback have exactly one valid rendering. */
function canToggleCommandShell(command: CommandPreview): boolean {
  return command.displayShell !== "posix" && !command.requiresShellVerbatimArgs;
}

const WINDOWS_COMMAND_DISPLAY_SHELLS = ["powershell", "cmd"] as const;

function CommandPanel({
  step,
  worktree,
  selectedShell,
  onSelectShell,
}: {
  step: StepExecutionPreview;
  worktree: WorktreeExecutionPreview | undefined;
  selectedShell: CommandDisplayShell | undefined;
  onSelectShell: (shell: CommandDisplayShell) => void;
}): React.ReactElement {
  const command = step.command;
  if (!command) {
    return (
      <p className="p-4 text-xs text-description-fg">
        This step has no command.
      </p>
    );
  }
  const activeShell = selectedShell ?? command.displayShell;
  const displayText = resolveCommandDisplayText(command, activeShell);
  const summarizedDisplayText = summarizeCommandDisplayText(displayText);

  return (
    <div className="flex flex-col gap-5 p-4">
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            Command{" "}
            <span className="font-normal text-description-fg">
              ({COMMAND_DISPLAY_SHELL_LABELS[activeShell]})
            </span>
          </h3>
          {canToggleCommandShell(command) && (
            <div className="inline-flex overflow-hidden rounded border border-panel-border text-xxs">
              {WINDOWS_COMMAND_DISPLAY_SHELLS.map((shell) => (
                <button
                  key={shell}
                  type="button"
                  aria-pressed={activeShell === shell}
                  className={`px-2 py-1 transition-colors ${
                    activeShell === shell
                      ? "bg-btn-bg text-btn-fg"
                      : "text-description-fg hover:text-foreground"
                  }`}
                  onClick={() => onSelectShell(shell)}
                >
                  {COMMAND_DISPLAY_SHELL_LABELS[shell]}
                </button>
              ))}
            </div>
          )}
        </div>
        <pre
          className="overflow-auto whitespace-pre-wrap break-words rounded bg-input-bg p-3 font-mono text-xs text-editor-fg"
          title={displayText}
        >
          {summarizedDisplayText}
        </pre>
        {command.requiresShellVerbatimArgs && (
          <p className="mt-2 text-xxs text-description-fg">
            This launcher requires cmd.exe; no other shell rendering is
            available.
          </p>
        )}
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
      {worktree?.eligible && worktree.mode === WORKTREE_MODES.MANAGED && (
        <div className="flex items-start gap-1 text-xxs text-description-fg">
          <Icon name="info" className="mt-px flex-shrink-0" />
          <span>
            This step actually runs inside a managed worktree, not the directory
            shown above — its exact path is assigned when this workflow runs.
            See Worktree in the Overview tab for details.
          </span>
        </div>
      )}
      {worktree?.eligible &&
        worktree.mode === WORKTREE_MODES.NAMED &&
        !worktree.plannedDirectoryIsExact && (
          <div className="flex items-start gap-1 text-xxs text-description-fg">
            <Icon name="info" className="mt-px flex-shrink-0" />
            <span>
              The working directory above is a best-effort guess for this named
              worktree. See Worktree in the Overview tab for details.
            </span>
          </div>
        )}
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
              <div className="font-semibold text-foreground">
                {condition.kind}
              </div>
              <div className="text-description-fg">
                {condition.configured
                  ? (condition.description ?? "Configured")
                  : "Not configured"}
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

function ConditionsPanel({
  step,
}: {
  step: StepExecutionPreview;
}): React.ReactElement {
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
            [
              "Backoff",
              conditions.retry.backoffSeconds == null
                ? "None"
                : `${conditions.retry.backoffSeconds}s`,
            ],
            ["Error behavior", conditions.errorBehavior ?? "Default"],
          ]}
        />
      </section>
    </div>
  );
}

function StepDetail({
  step,
  worktree,
  activeTab,
  onTabChange,
  onNavigateToTab,
  expandedChunks,
  onToggleChunk,
  selectedShell,
  onSelectShell,
}: {
  step: StepExecutionPreview;
  worktree: WorktreeExecutionPreview | undefined;
  activeTab: DryRunTab;
  onTabChange: (tab: DryRunTab) => void;
  onNavigateToTab: (tab: DryRunTab) => void;
  expandedChunks: Readonly<Record<string, boolean>>;
  onToggleChunk: (chunkIndex: number) => void;
  selectedShell: CommandDisplayShell | undefined;
  onSelectShell: (shell: CommandDisplayShell) => void;
}): React.ReactElement {
  const tabOverrides = useMemo(() => {
    const overrides: Partial<Record<DryRunTab, TabIconOverride>> = {};
    const worst = getWorstSeverity(step.diagnostics);
    if (worst) {
      const style = DIAGNOSTIC_SEVERITY_STYLE[worst];
      overrides[DRY_RUN_TABS.SUMMARY] = {
        badgeCodicon: style.icon,
        badgeColor: style.text,
      };
    }
    const permissionBadge = getPermissionModeBadge(
      step.resolvedProperties.permissions.mode ?? ""
    );
    if (permissionBadge) {
      overrides[DRY_RUN_TABS.COMMAND] = permissionBadge;
    }
    return overrides;
  }, [step]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-panel-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {stepLabel(step)}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xxs text-description-fg">
            <HarnessIcon
              harnessId={step.resolvedProperties.harnessId}
              size={14}
            />
            <span>
              {HARNESS_INFO[step.resolvedProperties.harnessId]?.name ??
                step.resolvedProperties.harnessId}
            </span>
          </div>
        </div>
        <span className="flex-shrink-0 text-xxs text-description-fg">
          Step {step.stepIndex + 1}
        </span>
      </div>
      <SegmentedTabBar
        tabs={DRY_RUN_TAB_DEFINITIONS}
        activeTab={activeTab}
        onTabChange={onTabChange}
        ariaLabel="Dry run sections"
        harnessId={step.resolvedProperties.harnessId}
        tabOverrides={tabOverrides}
        className="flex flex-shrink-0 items-center border-b border-panel-border bg-sidebar-bg overflow-x-hidden h-10"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === DRY_RUN_TABS.SUMMARY && (
          <SummaryPanel step={step} onNavigate={onNavigateToTab} />
        )}
        {activeTab === DRY_RUN_TABS.PAYLOAD && (
          <PayloadPanel
            step={step}
            expandedChunks={expandedChunks}
            onToggleChunk={onToggleChunk}
          />
        )}
        {activeTab === DRY_RUN_TABS.COMMAND && (
          <CommandPanel
            step={step}
            worktree={worktree}
            selectedShell={selectedShell}
            onSelectShell={onSelectShell}
          />
        )}
        {activeTab === DRY_RUN_TABS.CONDITIONS && (
          <ConditionsPanel step={step} />
        )}
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
    <nav
      className="flex w-[200px] flex-shrink-0 flex-col border-r border-panel-border bg-sidebar-bg p-2"
      aria-label="Dry run sections"
    >
      <button
        type="button"
        className={`flex items-center gap-2 rounded px-2 py-2 text-left text-xs transition-colors ${selection === PREVIEW_RAIL_SELECTIONS.OVERVIEW ? "bg-list-active-selection-bg text-list-active-fg" : "text-description-fg hover:bg-list-hover-bg hover:text-foreground"}`}
        onClick={() => onSelect(PREVIEW_RAIL_SELECTIONS.OVERVIEW)}
      >
        <Icon name="dashboard" />
        <span className="min-w-0 truncate">Overview</span>
      </button>
      <div className="my-2 border-t border-panel-border" />
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {preview.steps.map((step) => {
          const severity = getWorstSeverity(step.diagnostics);
          const style = severity
            ? DIAGNOSTIC_SEVERITY_STYLE[severity]
            : undefined;
          return (
            <button
              key={step.stepIndex}
              type="button"
              className={`flex items-center gap-2 rounded px-2 py-2 text-left text-xs transition-colors ${selection === step.stepIndex ? "bg-list-active-selection-bg text-list-active-fg" : "text-description-fg hover:bg-list-hover-bg hover:text-foreground"}`}
              onClick={() => onSelect(step.stepIndex)}
              title={stepLabel(step)}
              aria-label={stepLabel(step)}
            >
              <span className="w-4 flex-shrink-0 text-right text-xxs">
                {step.stepIndex + 1}
              </span>
              <HarnessIcon
                harnessId={step.resolvedProperties.harnessId}
                size={15}
              />
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

export const DryRunModal: React.FC<DryRunModalProps> = ({
  scope,
  elevated = false,
}) => {
  const storeScope = useExecutionPreviewStore((state) => state.scope);
  const status = useExecutionPreviewStore((state) => state.status);
  const preview = useExecutionPreviewStore((state) => state.preview);
  const isStale = useExecutionPreviewStore((state) => state.isStale);
  const open = useExecutionPreviewStore((state) => state.open);
  const close = useExecutionPreviewStore((state) => state.close);
  const [selection, setSelection] = useState<RailSelection>(
    scope.kind === PREVIEW_SCOPES.STEP
      ? scope.stepIndex
      : PREVIEW_RAIL_SELECTIONS.OVERVIEW
  );
  const [activeTabs, setActiveTabs] = useState<Record<number, DryRunTab>>({});
  const [expandedChunks, setExpandedChunks] = useState<Record<string, boolean>>(
    {}
  );
  const [selectedShells, setSelectedShells] = useState<
    Record<number, CommandDisplayShell>
  >({});
  const [copiedAction, setCopiedAction] = useState<
    "command" | "payload" | null
  >(null);
  const [contentRef, isNarrow] = useElementNarrow(640);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeStepIndex =
    scope.kind === PREVIEW_SCOPES.STEP ? scope.stepIndex : null;
  const compatibility = useCompatibilityDiagnostics({
    includePortabilityReport: scope.kind === PREVIEW_SCOPES.WORKFLOW,
  });

  useEffect(() => {
    setSelection(scopeStepIndex ?? PREVIEW_RAIL_SELECTIONS.OVERVIEW);
    setActiveTabs({});
    setExpandedChunks({});
    setSelectedShells({});
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

  const handleOverviewTimelineNavigation = useCallback(
    (stepIndex: number, tab: DryRunTab) => {
      setSelection(stepIndex);
      setActiveTabs((current) => ({ ...current, [stepIndex]: tab }));
    },
    []
  );

  if (!sameScope(storeScope, scope)) return null;

  const activeStep =
    preview &&
    (scope.kind === PREVIEW_SCOPES.STEP
      ? stepForScope(preview, scope)
      : typeof selection === "number"
        ? preview.steps.find((step) => step.stepIndex === selection)
        : undefined);
  const activeTab = activeStep
    ? (activeTabs[activeStep.stepIndex] ?? DRY_RUN_TABS.SUMMARY)
    : DRY_RUN_TABS.SUMMARY;
  const activeCommandShell = activeStep?.command
    ? (selectedShells[activeStep.stepIndex] ?? activeStep.command.displayShell)
    : undefined;
  const commandText =
    activeStep?.command && activeCommandShell
      ? resolveCommandDisplayText(activeStep.command, activeCommandShell)
      : undefined;
  const payloadText = activeStep?.prompt
    ? buildExpandedPayloadText(activeStep.prompt)
    : undefined;
  const workflowNarrow = scope.kind === PREVIEW_SCOPES.WORKFLOW && isNarrow;
  const selectOptions: SelectOption[] = [
    {
      value: PREVIEW_RAIL_SELECTIONS.OVERVIEW,
      label: "Overview",
      description: "Workflow summary",
    },
    ...(preview?.steps.map((step) => ({
      value: String(step.stepIndex),
      label: `${step.stepIndex + 1}. ${stepLabel(step)}`,
      description:
        HARNESS_INFO[step.resolvedProperties.harnessId]?.name ??
        step.resolvedProperties.harnessId,
    })) ?? []),
  ];

  return (
    <Modal
      isOpen
      title={`Dry Run${preview ? ` — ${preview.workflow.name}` : ""}`}
      onClose={close}
      size="full"
      bodyClassName="p-0"
      elevated={elevated}
      footer={
        <>
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 px-2 py-1.5 text-sm rounded transition-colors sm:px-3 ${commandText ? "text-description-fg hover:text-foreground" : "cursor-not-allowed text-description-fg opacity-50"}`}
            onClick={() => void handleCopy("command", commandText)}
            disabled={!commandText}
            title="Copy the exact command ctrlyoke will run — may reference generated files not yet written to disk"
            aria-label="Copy command"
          >
            <Icon
              name={
                copiedAction === "command" ? "codicon-check" : "codicon-copy"
              }
            />
            <span className="sm:hidden">Command</span>
            <span className="hidden sm:inline">Copy command</span>
          </button>
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 px-2 py-1.5 text-sm rounded transition-colors sm:px-3 ${payloadText ? "text-description-fg hover:text-foreground" : "cursor-not-allowed text-description-fg opacity-50"}`}
            onClick={() => void handleCopy("payload", payloadText)}
            disabled={!payloadText}
            title="Copy payload"
            aria-label="Copy payload"
          >
            <Icon
              name={
                copiedAction === "payload" ? "codicon-check" : "codicon-copy"
              }
            />
            <span className="sm:hidden">Payload</span>
            <span className="hidden sm:inline">Copy payload</span>
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-sm text-description-fg transition-colors hover:text-foreground sm:px-3"
            onClick={handleExport}
            disabled={!preview}
            title="Export"
            aria-label="Export"
          >
            <Icon name="cloud-download" />
            <span className="hidden sm:inline">Export</span>
          </button>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1.5 rounded bg-btn-bg px-2 py-1.5 text-sm text-btn-fg transition-colors hover:bg-btn-hover sm:px-3"
            onClick={handleRun}
          >
            <Icon name="play" />
            <span className="min-[360px]:hidden">Run</span>
            <span className="hidden min-[360px]:inline">Run workflow</span>
          </button>
        </>
      }
    >
      {status === PREVIEW_STATUSES.CHECKING || !preview ? (
        <div className="flex min-h-48 items-center justify-center p-6 text-sm text-description-fg">
          <Icon name="loading" className="mr-2 animate-spin" />
          Preparing dry run…
        </div>
      ) : (
        <div
          ref={contentRef}
          className="flex h-full min-h-[28rem] min-w-0 flex-col"
        >
          {isStale && (
            <div
              className="flex items-center gap-2 border-b border-warning-fg border-opacity-40 bg-severity-warning-bg px-4 py-2 text-xs text-warning-fg"
              role="status"
            >
              <Icon name="warning" />
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
                onChange={(value) =>
                  setSelection(
                    value === PREVIEW_RAIL_SELECTIONS.OVERVIEW
                      ? PREVIEW_RAIL_SELECTIONS.OVERVIEW
                      : Number(value)
                  )
                }
                options={selectOptions}
                triggerAriaLabel="Select dry run section"
              />
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1">
            {!workflowNarrow && scope.kind === PREVIEW_SCOPES.WORKFLOW && (
              <Rail
                preview={preview}
                selection={selection}
                onSelect={setSelection}
              />
            )}
            {selection === PREVIEW_RAIL_SELECTIONS.OVERVIEW &&
            scope.kind === PREVIEW_SCOPES.WORKFLOW ? (
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
                <OverviewPanel
                  preview={preview}
                  onNavigateToStepTab={handleOverviewTimelineNavigation}
                  portabilityReport={compatibility.portabilityReport}
                  portabilityReportChecking={compatibility.isChecking}
                />
              </div>
            ) : activeStep ? (
              <StepDetail
                step={activeStep}
                worktree={preview.worktree}
                activeTab={activeTab}
                onTabChange={(tab) =>
                  setActiveTabs((current) => ({
                    ...current,
                    [activeStep.stepIndex]: tab,
                  }))
                }
                onNavigateToTab={(tab) =>
                  setActiveTabs((current) => ({
                    ...current,
                    [activeStep.stepIndex]: tab,
                  }))
                }
                expandedChunks={expandedChunks}
                onToggleChunk={(chunkIndex) => {
                  const key = `${activeStep.stepIndex}:${chunkIndex}`;
                  setExpandedChunks((current) => ({
                    ...current,
                    [key]: !current[key],
                  }));
                }}
                selectedShell={selectedShells[activeStep.stepIndex]}
                onSelectShell={(shell) =>
                  setSelectedShells((current) => ({
                    ...current,
                    [activeStep.stepIndex]: shell,
                  }))
                }
              />
            ) : (
              <div className="flex min-w-0 flex-1 items-center justify-center p-6 text-sm text-description-fg">
                The selected step is not available in this preview.
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};
