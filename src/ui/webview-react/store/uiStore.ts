import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { webviewRawStorage } from "@utils/webviewStateStorage";
import { selectToastLevel } from "@store/settingsStore";
import type {
  WorkflowSummary,
  HarnessId,
  ExecutionState,
  WorkflowFileFormat,
  SettingWriteScope,
} from "../types/messages";
import { EXECUTION_STATES, type FooterPicker } from "../types/messages";
import { isExecutionFinished } from "../utils/status";
import type {
  OutputTab,
  TemplateVariableType,
  TemplateVariableDefaultSource,
} from "@root/types/DashboardConstants";
import {
  SETTING_SCOPES,
  TEMPLATE_VARIABLE_DEFAULT_SOURCES,
} from "@root/types/DashboardConstants";
import type { OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import type {
  HistorySearchCountState,
  HistorySearchIndexState,
  HistorySearchFilters,
  HistorySearchResult,
  RunSummary,
} from "@root/types/WorkflowTimelineTypes";
import type { HistoryEventKind } from "@root/types/WorkflowTimelineTypes";
import type {
  WorkflowViewAddress,
  WorkflowRunAddress,
  WorkflowRunNavigationSummary,
  WorkflowKey,
  WorkflowTokenTotals,
  WorktreeRunProjection,
  WorkspaceWorktreeOwnership,
} from "@root/types/CtrlYokeTypes";
import type { CreateWorkflowVariantRequest } from "@root/types/WebviewMessageTypes";
import type { SaveWorkflowBundlePreview } from "../types/messages";
import type { WorkspaceEntrySort } from "@root/types/HostedWorkspaceViewerTypes";
import { DEFAULT_WORKSPACE_ENTRY_SORT } from "@root/types/HostedWorkspaceViewerTypes";
import { areWorkflowAddressesEqual } from "@utils/viewAddress";
import { isWorkflowRunning } from "@utils/status";
import {
  DEFAULT_DESKTOP_SIZES,
  DEFAULT_MOBILE_SIZES,
  TOAST_QUEUE_LIMIT,
} from "../constants";
import {
  USER_FEEDBACK_SEVERITY,
  meetsToastLevel,
  type UserFeedbackSeverity,
  HISTORY_EVENT_KINDS,
  HISTORY_SEARCH_COUNT_STATES,
  OUTPUT_SCROLL_TARGET_KINDS,
  WORKFLOW_VIEW_ADDRESS_KIND,
  type DashboardHostCapability,
} from "@root/types/DashboardConstants";
import {
  ALL_WORKFLOW_HARNESSES,
  ALL_WORKFLOW_STATES,
  DEFAULT_DATE_RANGE_FILTER,
  getDateEndMs,
  getDateStartMs,
  type DateRangeFilter,
} from "@utils/dateRangeFilter";

let runViewRequestSequence = 0;
let toastSequence = 0;

/**
 * The addressed-view fields `setDisplayedRunView` writes, snapshotted before an
 * optimistic run-view request so it can be undone. Mirrors that action's write
 * set exactly — a field added there must be added here, or a failed navigation
 * leaves it stranded on the workflow that never loaded.
 */
export interface RunViewLoadRollback {
  displayedViewAddress: WorkflowViewAddress | null;
  displayedRunDirectory: string | null;
  runSummaries: RunSummary[];
  executionRunRef: string | null;
  displayedDefinitionRevision: number | null;
  displayedDescriptorRevision: number | null;
  pendingRewind: {
    fromStepIndex: number;
    baseDefinitionRevision: number;
  } | null;
  isViewingHistory: boolean;
  viewedLineageIsSystemGenerated: boolean;
}

export interface ToastItem {
  id: string;
  message: string;
  detail?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  severity: UserFeedbackSeverity;
  createdAt: number;
  dedupeKey?: string;
}

export interface HarnessDetectionRetryResult {
  requestId: string;
  success: boolean;
  error?: string;
}

export type ToastInput = Omit<ToastItem, "id" | "createdAt"> &
  Partial<Pick<ToastItem, "id" | "createdAt">>;

export interface ToastOptions {
  detail?: string;
  action?: ToastItem["action"];
  dedupeKey?: string;
}

/**
 * Rebuild the observed-running ledger (see {@link UiState.observedRunningWorkflowIds})
 * from the authoritative live workflow list.
 *
 * Admission requires an observation of RUNNING/PAUSING; a PAUSED observation
 * neither admits nor evicts, which is the whole point — a pause is still the
 * run you started, but a run merely *loaded* while already paused on disk was
 * never executed here and must not be treated as such. Ids absent from
 * `workflows` are pruned, keeping the ledger a strict subset of the live list
 * so a retired instance can never resurrect its admission.
 *
 * Returns `previous` unchanged when nothing moved, so subscribers selecting
 * the ledger don't re-render on every summary update.
 */
function reconcileObservedRunning(
  previous: Set<string>,
  workflows: WorkflowSummary[]
): Set<string> {
  const next = new Set<string>();
  for (const workflow of workflows) {
    if (isExecutionFinished(workflow.executionState)) {
      continue;
    }
    if (
      isWorkflowRunning(workflow.executionState) ||
      previous.has(workflow.id)
    ) {
      next.add(workflow.id);
    }
  }
  if (
    next.size === previous.size &&
    [...next].every((id) => previous.has(id))
  ) {
    return previous;
  }
  return next;
}

/**
 * Descriptor revisions are monotonic per lineage, so when a message targets the
 * address already displayed, a lower incoming value is always a stale read that
 * raced a descriptor transaction (e.g. an identity built between a rewind's
 * run-file write and its descriptor commit). Keep the newer knowledge; a
 * different address adopts the incoming value verbatim. Definition revisions
 * must NOT get this treatment — a discarded continuation legitimately restores
 * an older definition head.
 */
function mergeDescriptorRevision(
  state: {
    displayedViewAddress: WorkflowViewAddress | null;
    displayedDescriptorRevision: number | null;
  },
  address: WorkflowViewAddress,
  incoming: number | null
): number | null {
  if (
    incoming !== null &&
    state.displayedDescriptorRevision !== null &&
    areWorkflowAddressesEqual(address, state.displayedViewAddress)
  ) {
    return Math.max(incoming, state.displayedDescriptorRevision);
  }
  return incoming;
}

/**
 * Run summaries are lineage-owned even while FILE_SELECTED/SESSION_RESTORED
 * temporarily clear the displayed address. Use the summaries' own stable
 * workflowKey to prevent a later identity for another lineage from adopting
 * that stale run-navigation state.
 */
function areRunSummariesForLineage(
  summaries: RunSummary[],
  address: WorkflowViewAddress
): boolean {
  return summaries.every(
    (summary) => summary.workflowKey === address.workflowKey
  );
}

/**
 * A single template variable — name plus optional UI metadata.
 * Mirrors TemplateVariable in TemplateManager.ts.
 */
export interface TemplateVariable {
  name: string;
  type?: TemplateVariableType;
  /** For a model variable: the harness variable whose models it offers. */
  harness?: string;
  fileFilter?: string[];
  options?: string[];
  autoFillFilename?: boolean;
  description?: string;
  default?: string;
  authoredDefault?: string;
  defaultSource?: TemplateVariableDefaultSource;
  multiline?: boolean;
  /** When true, workflow creation requires a non-blank value for this variable */
  required?: boolean;
}

/**
 * Template information for new workflow modal
 */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  variables?: TemplateVariable[];
  isBuiltIn: boolean;
  /** Where a custom template was discovered; undefined for built-ins. */
  source?: "user" | "workspace";
}

/**
 * Data for the Save Workflow dialog
 */
export interface SaveWorkflowDialogData {
  requestId: string;
  address: WorkflowViewAddress;
  title: string;
  subtitle?: string;
  defaultPath: string;
  defaultFormat: WorkflowFileFormat;
}

export interface DuplicateWorkflowDialogData {
  source: WorkflowViewAddress;
  workflowName: string;
  invoker: HTMLElement | null;
}

export type DuplicateWorkflowRequest = Omit<
  CreateWorkflowVariantRequest,
  "type"
>;

/** Transient, request-addressed save-path preflight state. */
export interface SavePathCheck {
  requestId: string;
  path: string;
  address: WorkflowViewAddress;
  exists: boolean;
  bundlePreview?: SaveWorkflowBundlePreview;
  planChanged?: boolean;
  error?: string;
  checking: boolean;
}

/**
 * A request to open the web-native FileBrowserModal. Only used in standalone
 * (hosted browser) mode — see MODAL_FILE_BROWSER_PLAN.md. `onSelect` is a
 * plain in-memory callback: the web path never round-trips through the
 * extension host, unlike `templateFileSelection` below.
 */
export interface FileBrowserRequest {
  mode: "file" | "directory";
  /** Globs; file mode only. Folders always stay navigable regardless of filter. */
  fileFilter?: string[];
  /** Workspace-relative; defaults to "" (workspace root). */
  initialPath?: string;
  title?: string;
  onSelect: (path: string) => void;
}

/**
 * Recent workflow entry
 */
export interface RecentWorkflow {
  address: WorkflowViewAddress;
  /** Directory containing the definition and timeline for the primary address. */
  runDirectory?: string;
  workflowName: string;
  executionState: string;
  lastModifiedAt?: number;
  startedAt?: number;
  isFavorite?: boolean;
  totalSteps?: number;
  harness?: HarnessId;
  /** The primary address is a run prepared but never executed. */
  unstarted?: boolean;
  runNav?: WorkflowRunNavigationSummary;
  tokenTotals?: WorkflowTokenTotals;
  /** Primary run's pause-aware run time, once its clock has stopped. */
  activeExecutionMs?: number;
  worktree?: Pick<WorktreeRunProjection, "branchName" | "worktreePath">;
}

/** Panel size snapshot for the desktop layout (steps/settings/editor in px; output as %). */
export interface DesktopPanelSizes {
  steps: number;
  output: number;
  editor: number;
  settings: number;
}

/** Panel size snapshot for the mobile layout (editor in px; output as %). */
export interface MobilePanelSizes {
  output: number;
  editor: number;
}

export type OutputScrollTarget =
  | {
      kind: typeof OUTPUT_SCROLL_TARGET_KINDS.ROW;
      rowKey: string;
      viewportOffsetPx: number;
    }
  | {
      kind: typeof OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY;
      rowKey: string;
      viewportOffsetPx: number;
    }
  | { kind: typeof OUTPUT_SCROLL_TARGET_KINDS.BOTTOM };

export interface HiddenOutputTargetsEntry {
  /** getTargetKey() strings. */
  keys: readonly string[];
  /** When each key was hidden; drives the "hidden but active" indicator. */
  hiddenAtMs: Readonly<Record<string, number>>;
}

/**
 * Replace a view address's hidden-target set with `nextKeys`, keeping the
 * original hide timestamp of any key that stays hidden and stamping newly
 * hidden keys with now. Writing drops every other address's entry.
 */
function withHiddenOutputKeys(
  state: Pick<UiState, "hiddenOutputTargets" | "outputStepFilterVersion">,
  workflowKey: string,
  nextKeys: readonly string[]
): Pick<UiState, "hiddenOutputTargets" | "outputStepFilterVersion"> {
  const current = state.hiddenOutputTargets[workflowKey];
  const now = Date.now();
  const hiddenAtMs: Record<string, number> = {};
  for (const key of nextKeys) {
    hiddenAtMs[key] = current?.hiddenAtMs[key] ?? now;
  }

  return {
    hiddenOutputTargets:
      nextKeys.length > 0
        ? { [workflowKey]: { keys: nextKeys, hiddenAtMs } }
        : {},
    outputStepFilterVersion: state.outputStepFilterVersion + 1,
  };
}

/**
 * Ask the workflow properties panel to show one workflow variable's row (the
 * prompt editor's Ctrl+click on `{{name}}` and its "add to vars" quick fix).
 * `nonce` makes a repeat request for the same name observable.
 */
export interface WorkflowVariableRevealRequest {
  name: string;
  nonce: number;
}

export interface PendingOutputFindRequest {
  query: string;
  preferredTarget?: OutputExecutionTarget;
}

export const ALL_HISTORY_EVENT_KINDS = Object.values(
  HISTORY_EVENT_KINDS
) as HistoryEventKind[];

export interface HistorySearchFilterState {
  eventKinds: HistoryEventKind[];
  harnesses: string[];
  executionStates: string[];
  pathContains: string;
  dateRange: DateRangeFilter;
  workflowOnly: boolean;
}

export const DEFAULT_HISTORY_SEARCH_FILTERS = {
  eventKinds: ALL_HISTORY_EVENT_KINDS,
  harnesses: ALL_WORKFLOW_HARNESSES,
  executionStates: ALL_WORKFLOW_STATES,
  pathContains: "",
  dateRange: { ...DEFAULT_DATE_RANGE_FILTER },
  workflowOnly: false,
} satisfies HistorySearchFilterState;

export function createDefaultHistorySearchFilters(): HistorySearchFilterState {
  return {
    eventKinds: [...DEFAULT_HISTORY_SEARCH_FILTERS.eventKinds],
    harnesses: [...DEFAULT_HISTORY_SEARCH_FILTERS.harnesses],
    executionStates: [...DEFAULT_HISTORY_SEARCH_FILTERS.executionStates],
    pathContains: DEFAULT_HISTORY_SEARCH_FILTERS.pathContains,
    dateRange: { ...DEFAULT_HISTORY_SEARCH_FILTERS.dateRange },
    workflowOnly: DEFAULT_HISTORY_SEARCH_FILTERS.workflowOnly,
  };
}

export function getHistorySearchActiveFilterCount(
  filters: HistorySearchFilterState
): number {
  return [
    filters.eventKinds.length !== ALL_HISTORY_EVENT_KINDS.length,
    filters.harnesses.length !== ALL_WORKFLOW_HARNESSES.length,
    filters.executionStates.length !== ALL_WORKFLOW_STATES.length,
    filters.pathContains.trim().length > 0,
    filters.dateRange.preset !== DEFAULT_DATE_RANGE_FILTER.preset ||
      filters.dateRange.from.length > 0 ||
      filters.dateRange.to.length > 0,
    filters.workflowOnly,
  ].filter(Boolean).length;
}

export function toHistorySearchFilters(
  filters: HistorySearchFilterState,
  workflowKey?: WorkflowKey
): HistorySearchFilters {
  const since = getDateStartMs(filters.dateRange.from);
  const until = getDateEndMs(filters.dateRange.to);

  return {
    // A full selection is not a narrowing, so it is omitted from the payload
    // entirely. This matters most for `harnesses`: the backend excludes
    // unattributed documents whenever a harness filter is present, and status
    // messages and script/pre-condition/end-condition output legitimately have
    // no harness. Sending the complete list would silently hide every one of
    // those rows with no filter actually turned on.
    ...(filters.eventKinds.length < ALL_HISTORY_EVENT_KINDS.length
      ? { eventKinds: filters.eventKinds }
      : {}),
    ...(filters.harnesses.length < ALL_WORKFLOW_HARNESSES.length
      ? { harnesses: filters.harnesses }
      : {}),
    ...(filters.executionStates.length < ALL_WORKFLOW_STATES.length
      ? { executionStates: filters.executionStates }
      : {}),
    ...(filters.pathContains.trim()
      ? { pathContains: filters.pathContains.trim() }
      : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(filters.workflowOnly && workflowKey
      ? { workflowKeys: [workflowKey] }
      : {}),
  };
}

export function areOutputScrollTargetsEqual(
  left: OutputScrollTarget | undefined,
  right: OutputScrollTarget | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === OUTPUT_SCROLL_TARGET_KINDS.BOTTOM) {
    return true;
  }
  if (right.kind === OUTPUT_SCROLL_TARGET_KINDS.BOTTOM) {
    return false;
  }

  return (
    left.rowKey === right.rowKey &&
    Math.abs(left.viewportOffsetPx - right.viewportOffsetPx) < 0.5
  );
}

/**
 * UI state - Layout, visibility, and modal states
 */
interface UiState {
  /** Optional host-native actions advertised by the INIT message. */
  hostCapabilities: DashboardHostCapability[];
  // Dropdown hide feature — persisted to vscode state
  hiddenDropdownOptions: Record<string, string[]>; // namespace → hidden value[]
  // Section collapse states
  stepsCollapsed: boolean;
  finalStepFooterExpanded: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;

  // Diff display — when true all DiffView instances render collapsed (summary only),
  // keeping the DOM lean for runs with many large file edits.
  diffsCollapsed: boolean;
  // Monotonic counter bumped on every "expand all" / "collapse all" action.
  // DiffView includes this in its useEffect deps so the effect fires even when
  // diffsCollapsed doesn't change (e.g. user manually collapsed one diff while
  // diffsCollapsed was already false, then presses "Expand all" again).
  diffResetVersion: number;

  // Separate persisted preference for the undo/redo dialog's expand/collapse state.
  // Kept independent from diffsCollapsed so users can configure each independently.
  undoDialogDiffsCollapsed: boolean;

  // Persisted panel sizes — restored to useRef on mount, written back on resize
  lastDesktopSizes: DesktopPanelSizes;
  lastMobileSizes: MobilePanelSizes;

  // Drawer state
  propertiesDrawerOpen: boolean;

  // Settings panel collapse
  settingsCollapsed: boolean;

  // Output panel state
  outputScrollTargets: Record<string, OutputScrollTarget>; // transient per-workflow output scroll memory
  hiddenOutputTargets: Record<string, HiddenOutputTargetsEntry>;
  outputStepFilterVersion: number;
  pendingFindRequest: PendingOutputFindRequest | null;

  // History search drawer state (transient, not persisted)
  isHistorySearchOpen: boolean;
  /**
   * Sparse listing indexed by absolute result position: a hole is a row the
   * client has not fetched yet, which the virtualized list renders as a
   * placeholder. Pages arrive by offset rather than in sequence, so a scroll
   * that lands near the end of a large result set loads only that window.
   */
  historySearchResults: (HistorySearchResult | undefined)[];
  historySearchQuery: string;
  /** Request scope whose asynchronous history-search pages may update this listing. */
  historySearchListingId: string | null;
  historySearchDeep: boolean;
  historySearchRegex: boolean;
  historySearchError: string | null;
  /**
   * Set only while the first page of a query is outstanding. There is no
   * counterpart for later pages: those replace individual placeholder rows,
   * which carry their own pending affordance.
   */
  historySearchLoading: boolean;
  historySearchTotalCount: number;
  /**
   * Whether `historySearchTotalCount` is the true match count or a lower
   * bound that can still grow as more pages are requested (early-terminated
   * scan — see `HistorySearchResponse.countState`). `"exact"` by default so a
   * fresh/empty listing never falsely appears open-ended.
   */
  historySearchCountState: HistorySearchCountState;
  historySearchIndexState: HistorySearchIndexState;
  /** Set only while a search is blocked on a full search-index rebuild; null otherwise. */
  historySearchRebuildProgress: {
    processedRuns: number;
    totalRuns: number;
  } | null;
  historySearchFilters: HistorySearchFilterState;
  pendingHistorySearchNavigation: {
    address: Extract<WorkflowViewAddress, { kind: "run" }>;
    findQuery: string;
    target: OutputExecutionTarget;
  } | null;

  // Run history display state
  isViewingHistory: boolean; // true when showing a historical run (not live)
  /** The displayed lineage's runs, newest first. Stable identities only — run
   * navigation addresses runs by `runRef`, never by position in this array. */
  runSummaries: RunSummary[];
  /**
   * Mirrors `WorkflowLineageDescriptor.isSystemGenerated` for the lineage
   * currently displayed (e.g. commit message generation) — set on every
   * `RUN_VIEW_LOADED` snapshot, so it always reflects the lineage that
   * snapshot actually applied. Drives read-only lockdown of workflow-mutating
   * controls: every property that matters for such a lineage is overridden
   * by its owning feature on the next run anyway (see `CommitSection.tsx`),
   * so editing it in the dashboard has no durable effect.
   */
  viewedLineageIsSystemGenerated: boolean;
  displayedViewAddress: WorkflowViewAddress | null;
  /** Directory containing the definition and timeline for displayedViewAddress. */
  displayedRunDirectory: string | null;
  /**
   * The address whose *content* is actually loaded into `workflowStore` right
   * now — set only when a RUN_VIEW_LOADED snapshot is applied, never by an
   * optimistic navigation or an identity-only publish (WORKFLOW_VIEW_IDENTITY).
   * `displayedViewAddress` is the navigation target and can outrun this by one
   * in-flight request; RUN_VIEW_LOADED's stale-snapshot guard must compare
   * against this field, not `displayedViewAddress`, or a snapshot for a target
   * that was announced but never actually applied gets rejected as regressive
   * against the *previous* workflow's still-resident content. Not persisted —
   * a fresh reload has applied nothing yet regardless of what address was last
   * displayed.
   */
  appliedViewAddress: WorkflowViewAddress | null;
  /**
   * The definition revision of the content `appliedViewAddress` names, moved
   * only by messages that actually replace that content (a RUN_VIEW_LOADED
   * snapshot, a STEPS_EXTENDED queue push).
   *
   * Deliberately separate from `displayedDefinitionRevision`, which is the
   * optimistic-concurrency token the client echoes on its next mutation or run
   * action and therefore has to advance the moment a write lands — including
   * from a bare WORKFLOW_VIEW_IDENTITY published ahead of the snapshot that
   * write triggered. RUN_VIEW_LOADED's stale/replay comparisons are about
   * content and must use this field: judging an incoming snapshot against a
   * revision the client only holds as a promise would drop the very snapshot
   * that fulfils it. Not persisted, for the same reason as
   * `appliedViewAddress`.
   */
  appliedDefinitionRevision: number | null;
  /** Latest client-initiated run-view request; not persisted across reloads. */
  pendingRunViewRequestId: string | null;
  /**
   * The address `pendingRunViewRequestId` asked for. Recorded for *every*
   * pending request, unlike `pendingRunViewSwitch` (cross-lineage only), so the
   * run-view watchdog can reissue a lost request in either case. Not read as a
   * navigation target — that is `displayedViewAddress`, which other messages
   * may legitimately move while this request is still outstanding.
   */
  pendingRunViewAddress: WorkflowViewAddress | null;
  /**
   * Set while the latest run-view request crosses lineages — i.e. a workflow
   * switch whose snapshot has not arrived yet. Drives the instant header
   * rename and the panel loading overlay. Cleared with the request.
   */
  pendingRunViewSwitch: {
    requestId: string;
    workflowName: string | null;
    address: WorkflowViewAddress;
  } | null;
  /**
   * True once the run-view watchdog has had to reissue the pending request, so
   * the switch overlay can say so rather than looking indistinguishable from a
   * first attempt. Cleared with the request.
   */
  runViewLoadRetrying: boolean;
  /**
   * Everything `requestRunViewLoad` overwrote optimistically, captured so a
   * request that is never answered can be undone instead of abandoned.
   *
   * Abandoning it leaves the client *addressed* to the workflow it failed to
   * load while `workflowStore` still holds the previous one — the header names
   * one workflow and the panels show another, and every addressed control
   * (Run/Resume/Stop, the run selector) targets a lineage whose content was
   * never applied. A failed navigation must land back on a coherent view, not
   * on a half-applied one, so the give-up path restores this verbatim.
   */
  runViewLoadRollback: RunViewLoadRollback | null;
  executionRunRef: string | null;
  /** Optimistic revisions paired with the current addressed definition snapshot. */
  displayedDefinitionRevision: number | null;
  displayedDescriptorRevision: number | null;
  /** Durable rewind marker from the addressed run snapshot. */
  pendingRewind: {
    fromStepIndex: number;
    baseDefinitionRevision: number;
  } | null;
  /**
   * Set when the lineage currently displayed is deleted (from history) while
   * being viewed in this session — the backing files are gone, but the cached
   * view stays on screen until the user navigates away. Not persisted: a
   * reload has no in-memory view to protect. Whether the banner/lockdown is
   * *currently* active is derived by comparing this against
   * `displayedViewAddress` (see `useIsViewingDeletedWorkflow`), not read
   * directly, so navigating away — by any means, not just the banner's Close
   * action — silently retires it.
   */
  viewingDeletedWorkflow: {
    workflowKey: WorkflowKey;
    workflowName: string;
  } | null;

  // Save workflow dialog state
  saveWorkflowDialogOpen: boolean;
  saveWorkflowDialogData: SaveWorkflowDialogData | null;
  savePathCheck: SavePathCheck | null;

  // Duplicate workflow dialog state
  duplicateWorkflowDialogOpen: boolean;
  duplicateWorkflowDialogData: DuplicateWorkflowDialogData | null;
  duplicateWorkflowRequest: DuplicateWorkflowRequest | null;
  duplicateWorkflowError: string | null;

  // Web-native file/directory picker modal (standalone/hosted mode only) —
  // one canonical transient request shared by every caller, plus its persisted
  // last successful directory.
  fileBrowserState: FileBrowserRequest | null;
  /** Last successfully selected directory in the web-native file browser. */
  fileBrowserLastDirectory: string | null;
  /** Shared persisted sort preference for hosted workspace entry listings. */
  workspaceEntrySort: WorkspaceEntrySort;
  /** Last folder selected via the native OS picker for Save As location; cleared after SaveWorkflowDialog consumes it */
  saveLocationSelection: { path: string } | null;

  // New workflow modal state
  newWorkflowModalOpen: boolean;
  createWorkflowPending: boolean;
  openCreateTemplateForm: boolean;
  templates: TemplateInfo[];
  templateCatalog: TemplateInfo[];
  currentTemplate: TemplateInfo | null;
  defaultTemplateId: string;
  defaultTemplateConfirmedId: string | null;
  defaultTemplateSource: TemplateVariableDefaultSource;
  /** Scope used by the last successful template-default save. */
  lastSavedTemplateScope: SettingWriteScope;
  templateVariableDefaultsSaved: {
    templateId: string;
    variableNames: string[];
    scope: SettingWriteScope;
  } | null;
  /** Last file selected via OS file picker for a template variable; cleared after TemplateModal consumes it */
  templateFileSelection: { variable: string; path: string } | null;
  /** Result of the last CREATE_CUSTOM_TEMPLATE request; cleared after TemplateModal consumes it */
  customTemplateCreated: {
    templates: TemplateInfo[];
    templateId?: string;
    error?: string;
  } | null;

  // Recent workflows dropdown
  recentWorkflows: RecentWorkflow[];
  /**
   * False until the host has answered GET_RECENT_WORKFLOWS once, so the
   * dropdown can tell "still loading" apart from "no history". Building the
   * list scans every lineage, which takes seconds on a large history.
   */
  recentWorkflowsLoaded: boolean;
  /** `seq` of the last full list applied; older lists and rows are dropped. */
  recentWorkflowsListSeq: number;
  /**
   * `seq` of each row pushed since that list, by workflow key. A full list
   * that began scanning before a row was pushed must not overwrite that row.
   */
  recentWorkflowRowSeqs: Record<string, number>;
  recentWorkflowsDropdownOpen: boolean;

  // Multi-workflow support
  loadedWorkflows: WorkflowSummary[];
  /**
   * Instance ids observed RUNNING/PAUSING during this dashboard session — the
   * admission ledger for the workflow dropdown's pinned "Running" region.
   *
   * The region can't be a pure function of execution state. `loadedWorkflows`
   * mirrors the orchestrator's instance registry, which holds *every* loaded
   * instance — so merely opening a lineage whose latest run was left paused on
   * disk would otherwise pin it as if it were executing here. Membership is
   * therefore earned by running: a workflow enters on RUNNING/PAUSING and is
   * retained across the subsequent PAUSED (the run is still the one you
   * started, and its Resume/Stop still have exactly one referent), until it
   * reaches a terminal state or the instance goes away.
   *
   * Deliberately not persisted: a stale ledger restored after a window reload
   * would re-pin paused runs this session never executed. Reloading the webview
   * mid-pause therefore demotes the row to an ordinary lineage row, still
   * badged PAUSED — the safe direction to fail.
   */
  observedRunningWorkflowIds: Set<string>;
  activeWorkflowId: string | null;
  activeWorkflowWorkingFilePath: string | null;
  workspaceWorktreeOwnership: WorkspaceWorktreeOwnership | null;

  // Loading states
  isLoading: boolean;
  loadingMessage: string | null;

  // Whether the output pane's run summary banner (run id, date, status,
  // token/cost totals) stays fixed at the top while scrolling, or scrolls
  // away as the first row of content. Persisted so it survives reloads.
  runBannerPinned: boolean;

  // Terminal tab state (per workflow, defaults to 'output')
  activeOutputTabs: Record<string, OutputTab>;
  /** Lineages whose output tab should be selected as soon as their instance loads. */
  pendingOutputTabs: { workflowKey: WorkflowKey; tab: OutputTab }[];
  // Workflows with at least one running terminal session
  terminalActiveWorkflows: Set<string>;

  // Terminal session rail layout — persisted
  terminalRailCollapsed: boolean;
  terminalRailSizePx: number;

  // Notification toast queue (transient, not persisted)
  toastQueue: ToastItem[];
  // Result for the component-local harness detection retry control.
  harnessDetectionRetryResult: HarnessDetectionRetryResult | null;

  // Content preview modal (git diff / prior-context XML / mcp config JSON) — transient, not persisted
  contentPreviewModal: {
    title: string;
    content: string;
    language: "diff" | "xml" | "json";
    ref: string;
  } | null;

  /**
   * Discard-continuation/start-new-run-instead hit unsaved edits to the
   * rewound suffix and needs the user to confirm losing them. Rendered as an
   * in-app modal — never a native OS dialog — so hosted browser clients see
   * it too. Transient, not persisted.
   */
  suffixEditConfirmation: {
    action: "discardContinuation" | "startNewRunInstead";
    address: Extract<WorkflowViewAddress, { kind: "run" }>;
    expectedDefinitionRevision: number;
    expectedDescriptorRevision: number;
  } | null;

  // Footer quick picker state (transient, not persisted)
  footerOpenPicker: FooterPicker | null;

  // Mobile drawer/overlay state — persisted so user preference survives restarts
  mobileStepsOpen: boolean;
  mobileStepsMode: "sidebar" | "fullwidth";
  mobileWorkflowPropsOpen: boolean;

  // Transient, not persisted: consumed by WorkflowPropertiesPanel.
  workflowVariableRevealRequest: WorkflowVariableRevealRequest | null;

  // Global settings drawer state
  globalSettingsOpen: boolean;
  globalSettingsActiveTab: string;

  // Startup overlay — true once STARTUP_COMPLETE is received (or StartupOverlay's
  // safety timeout fires). WORKFLOW_LOADED deliberately does not set this.
  // NOT persisted: every panel open should show the overlay until startup settles.
  startupReady: boolean;
  devRestarting: boolean;
  /** True when ctrlyoke has not yet been initialized in this workspace and the user must approve before startup proceeds. */
  workspaceInitRequired: boolean;
  /** True after workspace init when the user should choose a panel layout preference (first install only). */
  showLayoutPreference: boolean;

  // This client's identity assigned by the extension host on connect.
  // Used to derive isController for terminal sessions.
  myClientId: string;

  // Dev-only "UX Snapshot" capture button visibility. Local UI preference,
  // persisted alongside the other panel/layout prefs (not a synced workflow
  // setting). Only takes effect in dev builds (see DeveloperSection).
  uxSnapshotButtonVisible: boolean;
  // Transient capture progress for the UX snapshot button's icon feedback:
  // idle → capturing (spinner) → saved (green check) / error, then back to idle.
  uxSnapshotStatus: "idle" | "capturing" | "saved" | "error";
}

/**
 * UI actions
 */
interface UiActions {
  setHostCapabilities: (capabilities: DashboardHostCapability[]) => void;
  // Section toggles
  togglePromptsCollapse: () => void;
  toggleFinalStepFooterExpanded: () => void;
  setFinalStepFooterExpanded: (expanded: boolean) => void;
  toggleOutputCollapse: () => void;
  toggleEditorCollapse: () => void;
  setPromptsCollapsed: (collapsed: boolean) => void;
  setOutputCollapsed: (collapsed: boolean) => void;
  setEditorCollapsed: (collapsed: boolean) => void;
  toggleDiffsCollapsed: () => void;
  setDiffsCollapsed: (collapsed: boolean) => void;
  expandAllDiffs: () => void;
  collapseAllDiffs: () => void;
  setUndoDialogDiffsCollapsed: (collapsed: boolean) => void;

  // Panel sizes (persisted, written from App.tsx resize handlers)
  setLastDesktopSizes: (sizes: Partial<DesktopPanelSizes>) => void;
  setLastMobileSizes: (sizes: Partial<MobilePanelSizes>) => void;

  // Drawer toggles
  togglePropertiesDrawer: () => void;
  openPropertiesDrawer: () => void;
  closePropertiesDrawer: () => void;

  // Settings panel
  toggleSettingsCollapse: () => void;
  setSettingsCollapsed: (collapsed: boolean) => void;

  // Output panel
  setOutputScrollTarget: (
    workflowId: string,
    target: OutputScrollTarget
  ) => void;
  toggleHiddenOutputTarget: (workflowKey: string, targetKey: string) => void;
  /** Hide or show every key in `targetKeys` together (e.g. all final-step passes). */
  setOutputTargetsHidden: (
    workflowKey: string,
    targetKeys: readonly string[],
    hidden: boolean
  ) => void;
  /**
   * Hide every present target except `soloTargetKeys`; soloing the same set
   * again clears the filter.
   */
  soloOutputTargets: (
    workflowKey: string,
    soloTargetKeys: readonly string[],
    allPresentTargetKeys: readonly string[]
  ) => void;
  clearHiddenOutputTargets: (workflowKey: string) => void;
  pruneHiddenOutputTargets: (
    workflowKey: string,
    presentTargetKeys: ReadonlySet<string>
  ) => void;
  setPendingFindRequest: (request: PendingOutputFindRequest | null) => void;
  openHistorySearch: () => void;
  closeHistorySearch: () => void;
  toggleHistorySearch: () => void;
  setHistorySearchQuery: (query: string) => void;
  setHistorySearchListingId: (listingId: string | null) => void;
  setHistorySearchDeep: (deep: boolean) => void;
  setHistorySearchRegex: (regex: boolean) => void;
  setHistorySearchError: (error: string | null) => void;
  setHistorySearchFilters: (filters: HistorySearchFilterState) => void;
  resetHistorySearchFilters: () => void;
  /**
   * Replaces the listing when `options.offset` is absent, or merges one page
   * into it at that absolute offset when present.
   */
  setHistorySearchResults: (
    results: HistorySearchResult[],
    loading: boolean,
    options?: {
      offset?: number;
      totalCount?: number;
      countState?: HistorySearchCountState;
      indexState?: HistorySearchIndexState;
    }
  ) => void;
  setHistorySearchRebuildProgress: (
    progress: { processedRuns: number; totalRuns: number } | null
  ) => void;
  setPendingHistorySearchNavigation: (
    nav: {
      address: Extract<WorkflowViewAddress, { kind: "run" }>;
      findQuery: string;
      target: OutputExecutionTarget;
    } | null
  ) => void;

  // Save workflow dialog
  openSaveWorkflowDialog: (data: SaveWorkflowDialogData) => void;
  closeSaveWorkflowDialog: () => void;
  beginSavePathCheck: (
    requestId: string,
    path: string,
    address: WorkflowViewAddress
  ) => void;
  resolveSavePathCheck: (result: Omit<SavePathCheck, "checking">) => void;
  clearSavePathCheck: () => void;

  // Duplicate workflow dialog
  openDuplicateWorkflowDialog: (
    data: Omit<DuplicateWorkflowDialogData, "invoker">,
    invoker?: HTMLElement | null
  ) => void;
  closeDuplicateWorkflowDialog: () => void;
  beginDuplicateWorkflowRequest: (request: DuplicateWorkflowRequest) => void;
  retireDuplicateWorkflowRequest: (error: string) => void;
  setDuplicateWorkflowError: (error: string | null) => void;

  // File browser modal (standalone/hosted mode)
  openFileBrowser: (request: FileBrowserRequest) => void;
  closeFileBrowser: () => void;
  setFileBrowserLastDirectory: (path: string) => void;
  setWorkspaceEntrySort: (sort: WorkspaceEntrySort) => void;
  setSaveLocationSelection: (selection: { path: string } | null) => void;

  // New workflow modal
  openNewWorkflowModal: (data: {
    templates: TemplateInfo[];
    defaultTemplateId?: string;
    defaultTemplateSource?: TemplateVariableDefaultSource;
    openCreateTemplateForm?: boolean;
  }) => void;
  closeNewWorkflowModal: () => void;
  setCreateWorkflowPending: (pending: boolean) => void;
  setCurrentTemplate: (template: TemplateInfo | null) => void;
  setDefaultTemplateId: (id: string) => void;
  setDefaultTemplateConfirmedId: (id: string | null) => void;
  setDefaultTemplateSource: (source: TemplateVariableDefaultSource) => void;
  setLastSavedTemplateScope: (scope: SettingWriteScope) => void;
  setTemplateVariableDefaultsSaved: (
    saved: {
      templateId: string;
      variableNames: string[];
      scope: SettingWriteScope;
    } | null
  ) => void;
  setTemplates: (templates: TemplateInfo[]) => void;
  setTemplateCatalog: (templates: TemplateInfo[]) => void;
  setTemplateFileSelection: (
    selection: { variable: string; path: string } | null
  ) => void;
  setCustomTemplateCreated: (
    result: {
      templates: TemplateInfo[];
      templateId?: string;
      error?: string;
    } | null
  ) => void;

  // Recent workflows
  /**
   * Replaces the list. With the host's `seq`, rows pushed after that list
   * began scanning survive it, and a list older than the last one is dropped.
   * Without one (local optimistic edits) it replaces outright.
   */
  setRecentWorkflows: (workflows: RecentWorkflow[], seq?: number) => void;
  /** Applies one pushed row (`RECENT_WORKFLOW_UPDATED`) unless something newer already landed. */
  upsertRecentWorkflow: (workflow: RecentWorkflow, seq: number) => void;
  /**
   * Patches the recent-workflow entry sharing this summary's lineage
   * (execution state, step count, token totals, worktree) in place. Recent
   * entries only otherwise refresh via a full `RECENT_WORKFLOWS` re-fetch, so
   * without this a lineage's dropdown row keeps showing whatever state it had
   * when the list was last requested — stale until the dropdown is reopened.
   */
  updateRecentWorkflowFromSummary: (summary: WorkflowSummary) => void;
  toggleRecentWorkflowsDropdown: () => void;
  closeRecentWorkflowsDropdown: () => void;

  // Multi-workflow support
  setLoadedWorkflows: (workflows: WorkflowSummary[]) => void;
  addLoadedWorkflow: (workflow: WorkflowSummary) => void;
  removeLoadedWorkflow: (workflowId: string) => void;
  updateLoadedWorkflow: (workflow: WorkflowSummary) => void;
  setActiveWorkflowId: (id: string | null) => void;
  setActiveWorkflowWorkingFilePath: (path: string | null) => void;
  setWorkspaceWorktreeOwnership: (
    ownership: WorkspaceWorktreeOwnership | null
  ) => void;
  setViewingDeletedWorkflow: (
    value: { workflowKey: WorkflowKey; workflowName: string } | null
  ) => void;

  // Run summary banner pin state
  toggleRunBannerPinned: () => void;

  // Loading state
  setLoading: (loading: boolean, message?: string) => void;

  // Toast notifications
  enqueueToast: (toast: ToastInput) => void;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
  showToast: (
    message: string,
    severity?: UserFeedbackSeverity,
    options?: ToastOptions
  ) => void;
  hideToast: () => void;
  setHarnessDetectionRetryResult: (
    result: HarnessDetectionRetryResult | null
  ) => void;

  // Content preview modal
  setContentPreviewModal: (
    modal: {
      title: string;
      content: string;
      language: "diff" | "xml" | "json";
      ref: string;
    } | null
  ) => void;

  // Suffix-edit discard confirmation modal
  setSuffixEditConfirmation: (
    confirmation: {
      action: "discardContinuation" | "startNewRunInstead";
      address: Extract<WorkflowViewAddress, { kind: "run" }>;
      expectedDefinitionRevision: number;
      expectedDescriptorRevision: number;
    } | null
  ) => void;

  // Terminal tab switching
  setActiveOutputTab: (workflowId: string, tab: OutputTab) => void;
  forceOutputTabForWorkflow: (workflowKey: WorkflowKey, tab: OutputTab) => void;
  setTerminalSessionActive: (workflowId: string, active: boolean) => void;

  // Terminal session rail layout
  setTerminalRailCollapsed: (collapsed: boolean) => void;
  setTerminalRailSizePx: (px: number) => void;

  // Run history view
  setHistoryView: () => void;
  clearHistoryView: () => void;
  setDisplayedRunView: (
    address: WorkflowViewAddress,
    summaries: RunSummary[],
    executionRunRef?: string,
    revisions?: { definitionRevision: number; descriptorRevision: number },
    pendingRewind?: { fromStepIndex: number; baseDefinitionRevision: number },
    runDirectory?: string,
    isSystemGenerated?: boolean
  ) => void;
  setDisplayedViewIdentity: (
    address: WorkflowViewAddress,
    definitionRevision: number,
    descriptorRevision: number,
    runDirectory?: string,
    isSystemGenerated?: boolean
  ) => void;
  adoptDescriptorRevision: (
    address: WorkflowViewAddress,
    descriptorRevision: number
  ) => void;
  markExecutionRunFinished: (executionState: ExecutionState) => void;
  markExecutionRunStarted: () => void;
  updateRunSummaryWorktree: (
    runRef: WorkflowRunAddress["runRef"],
    worktree: WorktreeRunProjection
  ) => void;
  /** Marks `address` and its revision as the content applied to `workflowStore`. */
  markViewAddressApplied: (
    address: WorkflowViewAddress,
    definitionRevision: number
  ) => void;
  /** Advances the applied revision for content pushed without a full snapshot. */
  markAppliedDefinitionRevision: (definitionRevision: number) => void;
  requestRunViewLoad: (
    address: WorkflowViewAddress,
    summaries: RunSummary[],
    executionRunRef?: string,
    /** Display name for the switch overlay when the caller knows it. */
    targetWorkflowName?: string
  ) => string;
  clearPendingRunViewLoad: () => void;
  /** Records that the watchdog has reissued the outstanding run-view request. */
  markRunViewLoadRetrying: () => void;
  /**
   * Retires the pending request *and* undoes its optimistic view move, so a
   * navigation that could not be completed ends on the workflow the client is
   * actually showing rather than on a header/content mismatch.
   */
  rollbackRunViewLoad: () => void;

  // Dropdown hide feature
  hideDropdownOption: (namespace: string, value: string) => void;
  unhideDropdownOption: (namespace: string, value: string) => void;
  clearHiddenDropdownOptions: (namespace: string) => void;

  // Footer quick picker
  setFooterOpenPicker: (picker: FooterPicker | null) => void;

  // Mobile drawer actions
  toggleMobileSteps: () => void;
  setMobileStepsMode: (mode: "sidebar" | "fullwidth") => void;
  toggleMobileWorkflowProps: () => void;
  closeMobileSteps: () => void;
  closeMobileWorkflowProps: () => void;
  /**
   * Open the workflow properties panel (the mobile overlay when `mobile`,
   * otherwise the desktop sidebar) and focus `name`'s Variables row.
   */
  revealWorkflowVariable: (name: string, options: { mobile: boolean }) => void;
  clearWorkflowVariableRevealRequest: () => void;

  // Global settings drawer actions
  toggleGlobalSettings: () => void;
  closeGlobalSettings: () => void;
  setGlobalSettingsTab: (tab: string) => void;

  /**
   * Closes the Global Settings and History Search drawers together —
   * switching workflows is treated as a "click outside" for both fullscreen-ish
   * drawers, which otherwise stay open across an unrelated lineage switch.
   */
  closeFullscreenDrawers: () => void;

  // Startup overlay
  setStartupReady: (ready: boolean) => void;
  setDevRestarting: (restarting: boolean) => void;
  setWorkspaceInitRequired: (required: boolean) => void;
  setShowLayoutPreference: (show: boolean) => void;

  // Client identity
  setMyClientId: (clientId: string) => void;

  // Dev-only UX snapshot button
  setUxSnapshotButtonVisible: (visible: boolean) => void;
  setUxSnapshotStatus: (
    status: "idle" | "capturing" | "saved" | "error"
  ) => void;

  // Reset UI to defaults
  resetUi: () => void;
  // Reset persisted layout state to initial defaults (for dev testing)
  resetLayoutState: () => void;
}

const initialState: UiState = {
  hostCapabilities: [],
  hiddenDropdownOptions: {},
  saveWorkflowDialogOpen: false,
  saveWorkflowDialogData: null,
  savePathCheck: null,
  duplicateWorkflowDialogOpen: false,
  duplicateWorkflowDialogData: null,
  duplicateWorkflowRequest: null,
  duplicateWorkflowError: null,
  fileBrowserState: null,
  fileBrowserLastDirectory: null,
  workspaceEntrySort: DEFAULT_WORKSPACE_ENTRY_SORT,
  saveLocationSelection: null,
  stepsCollapsed: false,
  finalStepFooterExpanded: false,
  outputCollapsed: false,
  editorCollapsed: false,
  diffsCollapsed: true, // collapsed by default to keep the DOM lean
  diffResetVersion: 0,
  undoDialogDiffsCollapsed: true, // dialog defaults collapsed independently
  lastDesktopSizes: { ...DEFAULT_DESKTOP_SIZES },
  lastMobileSizes: { ...DEFAULT_MOBILE_SIZES },
  propertiesDrawerOpen: false,
  settingsCollapsed: false,
  outputScrollTargets: {},
  hiddenOutputTargets: {},
  outputStepFilterVersion: 0,
  pendingFindRequest: null,
  isHistorySearchOpen: false,
  historySearchResults: [],
  historySearchQuery: "",
  historySearchListingId: null,
  historySearchDeep: false,
  historySearchRegex: false,
  historySearchError: null,
  historySearchLoading: false,
  historySearchTotalCount: 0,
  historySearchCountState: HISTORY_SEARCH_COUNT_STATES.EXACT,
  historySearchIndexState: "ready",
  historySearchRebuildProgress: null,
  historySearchFilters: createDefaultHistorySearchFilters(),
  pendingHistorySearchNavigation: null,
  newWorkflowModalOpen: false,
  createWorkflowPending: false,
  openCreateTemplateForm: false,
  templates: [],
  templateCatalog: [],
  currentTemplate: null,
  defaultTemplateId: "blank",
  defaultTemplateConfirmedId: null,
  defaultTemplateSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE,
  lastSavedTemplateScope: SETTING_SCOPES.WORKSPACE,
  templateVariableDefaultsSaved: null,
  templateFileSelection: null,
  customTemplateCreated: null,
  recentWorkflows: [],
  recentWorkflowsLoaded: false,
  recentWorkflowsListSeq: 0,
  recentWorkflowRowSeqs: {},
  recentWorkflowsDropdownOpen: false,
  loadedWorkflows: [],
  observedRunningWorkflowIds: new Set<string>(),
  activeWorkflowId: null,
  activeWorkflowWorkingFilePath: null,
  workspaceWorktreeOwnership: null,
  isLoading: false,
  loadingMessage: null,
  runBannerPinned: true,
  toastQueue: [],
  harnessDetectionRetryResult: null,
  contentPreviewModal: null,
  suffixEditConfirmation: null,
  activeOutputTabs: {},
  pendingOutputTabs: [],
  terminalActiveWorkflows: new Set<string>(),
  terminalRailCollapsed: true,
  terminalRailSizePx: 140,
  isViewingHistory: false,
  runSummaries: [],
  viewedLineageIsSystemGenerated: false,
  displayedViewAddress: null,
  displayedRunDirectory: null,
  appliedViewAddress: null,
  appliedDefinitionRevision: null,
  pendingRunViewRequestId: null,
  pendingRunViewAddress: null,
  pendingRunViewSwitch: null,
  runViewLoadRetrying: false,
  runViewLoadRollback: null,
  executionRunRef: null,
  displayedDefinitionRevision: null,
  displayedDescriptorRevision: null,
  pendingRewind: null,
  viewingDeletedWorkflow: null,
  footerOpenPicker: null,
  mobileStepsOpen: false,
  mobileStepsMode: "fullwidth",
  mobileWorkflowPropsOpen: false,
  workflowVariableRevealRequest: null,
  globalSettingsOpen: false,
  globalSettingsActiveTab: "general",
  startupReady: false,
  devRestarting: false,
  workspaceInitRequired: false,
  showLayoutPreference: false,
  myClientId: "",
  uxSnapshotButtonVisible: false,
  uxSnapshotStatus: "idle",
};

// Fields to persist via vscode.getState()/setState()
const persistedFields = [
  "stepsCollapsed",
  "outputCollapsed",
  "editorCollapsed",
  "settingsCollapsed",
  "defaultTemplateId",
  "lastSavedTemplateScope",
  "hiddenDropdownOptions",
  "lastDesktopSizes",
  "lastMobileSizes",
  "diffsCollapsed",
  "undoDialogDiffsCollapsed",
  "runBannerPinned",
  "terminalRailCollapsed",
  "terminalRailSizePx",
  "globalSettingsActiveTab",
  "displayedViewAddress",
  "mobileStepsOpen",
  "mobileStepsMode",
  "uxSnapshotButtonVisible",
  "fileBrowserLastDirectory",
  "workspaceEntrySort",
] as const;

export const useUiStore = create<UiState & UiActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      setHostCapabilities: (hostCapabilities) => set({ hostCapabilities }),

      // ============================================================================
      // SECTION TOGGLES
      // ============================================================================

      togglePromptsCollapse: () =>
        set((state) => ({ stepsCollapsed: !state.stepsCollapsed })),

      toggleFinalStepFooterExpanded: () =>
        set((state) => ({
          finalStepFooterExpanded: !state.finalStepFooterExpanded,
        })),

      setFinalStepFooterExpanded: (expanded) =>
        set({ finalStepFooterExpanded: expanded }),

      toggleOutputCollapse: () =>
        set((state) => ({ outputCollapsed: !state.outputCollapsed })),

      toggleEditorCollapse: () =>
        set((state) => ({ editorCollapsed: !state.editorCollapsed })),

      setPromptsCollapsed: (collapsed) => set({ stepsCollapsed: collapsed }),

      setOutputCollapsed: (collapsed) => set({ outputCollapsed: collapsed }),

      setEditorCollapsed: (collapsed) => set({ editorCollapsed: collapsed }),

      toggleDiffsCollapsed: () =>
        set((state) => ({ diffsCollapsed: !state.diffsCollapsed })),

      setDiffsCollapsed: (collapsed) => set({ diffsCollapsed: collapsed }),

      expandAllDiffs: () =>
        set((state) => ({
          diffsCollapsed: false,
          diffResetVersion: state.diffResetVersion + 1,
        })),

      collapseAllDiffs: () =>
        set((state) => ({
          diffsCollapsed: true,
          diffResetVersion: state.diffResetVersion + 1,
        })),

      setUndoDialogDiffsCollapsed: (collapsed) =>
        set({ undoDialogDiffsCollapsed: collapsed }),

      // ============================================================================
      // PANEL SIZES
      // ============================================================================

      setLastDesktopSizes: (sizes) =>
        set((state) => {
          const next = { ...state.lastDesktopSizes, ...sizes };
          if (
            next.steps === state.lastDesktopSizes.steps &&
            next.output === state.lastDesktopSizes.output &&
            next.editor === state.lastDesktopSizes.editor &&
            next.settings === state.lastDesktopSizes.settings
          ) {
            return state;
          }
          return { lastDesktopSizes: next };
        }),

      setLastMobileSizes: (sizes) =>
        set((state) => {
          const next = { ...state.lastMobileSizes, ...sizes };
          if (
            next.output === state.lastMobileSizes.output &&
            next.editor === state.lastMobileSizes.editor
          ) {
            return state;
          }
          return { lastMobileSizes: next };
        }),

      // ============================================================================
      // DRAWER TOGGLES
      // ============================================================================

      togglePropertiesDrawer: () =>
        set((state) => ({ propertiesDrawerOpen: !state.propertiesDrawerOpen })),

      openPropertiesDrawer: () => set({ propertiesDrawerOpen: true }),

      closePropertiesDrawer: () => set({ propertiesDrawerOpen: false }),

      // ============================================================================
      // SETTINGS PANEL
      // ============================================================================

      toggleSettingsCollapse: () =>
        set((state) => ({ settingsCollapsed: !state.settingsCollapsed })),

      setSettingsCollapsed: (collapsed) =>
        set({ settingsCollapsed: collapsed }),

      // ============================================================================
      // OUTPUT PANEL
      // ============================================================================

      setOutputScrollTarget: (workflowId, target) =>
        set((state) => {
          const previous = state.outputScrollTargets[workflowId];
          if (areOutputScrollTargetsEqual(previous, target)) {
            return state;
          }

          return {
            outputScrollTargets: {
              ...state.outputScrollTargets,
              [workflowId]: target,
            },
          };
        }),

      toggleHiddenOutputTarget: (workflowKey, targetKey) =>
        set((state) => {
          const currentKeys =
            state.hiddenOutputTargets[workflowKey]?.keys ?? [];
          const nextKeys = currentKeys.includes(targetKey)
            ? currentKeys.filter((key) => key !== targetKey)
            : [...currentKeys, targetKey];
          return withHiddenOutputKeys(state, workflowKey, nextKeys);
        }),

      setOutputTargetsHidden: (workflowKey, targetKeys, hidden) =>
        set((state) => {
          const currentKeys =
            state.hiddenOutputTargets[workflowKey]?.keys ?? [];
          const nextKeys = hidden
            ? [...new Set([...currentKeys, ...targetKeys])]
            : currentKeys.filter((key) => !targetKeys.includes(key));
          return withHiddenOutputKeys(state, workflowKey, nextKeys);
        }),

      soloOutputTargets: (workflowKey, soloTargetKeys, allPresentTargetKeys) =>
        set((state) => {
          const currentKeys =
            state.hiddenOutputTargets[workflowKey]?.keys ?? [];
          const nextKeys = [...new Set(allPresentTargetKeys)].filter(
            (key) => !soloTargetKeys.includes(key)
          );
          const isAlreadySoloed =
            currentKeys.length === nextKeys.length &&
            nextKeys.every((key) => currentKeys.includes(key));

          return withHiddenOutputKeys(
            state,
            workflowKey,
            isAlreadySoloed ? [] : nextKeys
          );
        }),

      clearHiddenOutputTargets: (_workflowKey) =>
        set((state) => ({
          hiddenOutputTargets: {},
          outputStepFilterVersion: state.outputStepFilterVersion + 1,
        })),

      pruneHiddenOutputTargets: (workflowKey, presentTargetKeys) =>
        set((state) => {
          const current = state.hiddenOutputTargets[workflowKey];

          // A hidden set belongs to exactly one viewed address. Writes already
          // drop other addresses, but rendering a different address must drop
          // them too, or navigating away and back silently restores a filter
          // the user has no reason to expect.
          const hasForeignEntries = Object.keys(state.hiddenOutputTargets).some(
            (key) => key !== workflowKey
          );

          // With nothing rendered there is no way to judge staleness, and a
          // replay that momentarily empties the output would otherwise wipe a
          // filter set on a still-running step.
          const nextKeys =
            current && presentTargetKeys.size > 0
              ? current.keys.filter((key) => presentTargetKeys.has(key))
              : (current?.keys ?? []);
          const keysChanged = nextKeys.length !== (current?.keys.length ?? 0);
          if (!hasForeignEntries && !keysChanged) return state;

          const hiddenAtMs: Record<string, number> = {};
          for (const key of nextKeys) {
            const timestamp = current?.hiddenAtMs[key];
            if (timestamp !== undefined) hiddenAtMs[key] = timestamp;
          }

          return {
            hiddenOutputTargets:
              nextKeys.length > 0
                ? { [workflowKey]: { keys: nextKeys, hiddenAtMs } }
                : {},
            outputStepFilterVersion: state.outputStepFilterVersion + 1,
          };
        }),

      setPendingFindRequest: (request) => set({ pendingFindRequest: request }),

      openHistorySearch: () =>
        set({ isHistorySearchOpen: true, globalSettingsOpen: false }),

      closeHistorySearch: () =>
        set({
          isHistorySearchOpen: false,
          historySearchLoading: false,
          historySearchRebuildProgress: null,
        }),

      toggleHistorySearch: () =>
        set((state) =>
          state.isHistorySearchOpen
            ? {
                isHistorySearchOpen: false,
                historySearchLoading: false,
                historySearchRebuildProgress: null,
              }
            : { isHistorySearchOpen: true, globalSettingsOpen: false }
        ),

      setHistorySearchQuery: (query) =>
        set({
          historySearchQuery: query,
          historySearchListingId: null,
          historySearchError: null,
          historySearchTotalCount: 0,
          historySearchCountState: HISTORY_SEARCH_COUNT_STATES.EXACT,
        }),

      setHistorySearchListingId: (listingId) =>
        set({ historySearchListingId: listingId }),

      setHistorySearchDeep: (deep) =>
        set({ historySearchDeep: deep, historySearchListingId: null }),

      setHistorySearchRegex: (regex) =>
        set({
          historySearchRegex: regex,
          historySearchError: null,
          historySearchListingId: null,
        }),

      setHistorySearchError: (error) =>
        set({
          historySearchError: error,
          historySearchResults: [],
          historySearchLoading: false,
          historySearchTotalCount: 0,
          historySearchCountState: HISTORY_SEARCH_COUNT_STATES.EXACT,
          historySearchIndexState: "ready",
          historySearchRebuildProgress: null,
        }),

      setHistorySearchFilters: (filters) =>
        set({
          historySearchFilters: filters,
          historySearchListingId: null,
          historySearchResults: [],
          historySearchLoading: false,
          historySearchTotalCount: 0,
          historySearchCountState: HISTORY_SEARCH_COUNT_STATES.EXACT,
        }),

      resetHistorySearchFilters: () =>
        set({
          historySearchFilters: createDefaultHistorySearchFilters(),
          historySearchListingId: null,
          historySearchDeep: false,
          historySearchRegex: false,
          historySearchError: null,
          historySearchResults: [],
          historySearchLoading: false,
          historySearchTotalCount: 0,
          historySearchCountState: HISTORY_SEARCH_COUNT_STATES.EXACT,
        }),

      setHistorySearchResults: (results, loading, options) =>
        set((state) => {
          const offset = options?.offset;
          let nextResults: (HistorySearchResult | undefined)[];
          if (offset === undefined) {
            nextResults = [...results];
          } else {
            nextResults = [...state.historySearchResults];
            results.forEach((result, index) => {
              nextResults[offset + index] = result;
            });
          }
          return {
            historySearchResults: nextResults,
            historySearchError: null,
            historySearchLoading: loading,
            historySearchTotalCount:
              options?.totalCount ??
              (offset === undefined
                ? results.length
                : state.historySearchTotalCount),
            historySearchCountState:
              options?.countState ??
              (offset === undefined
                ? HISTORY_SEARCH_COUNT_STATES.EXACT
                : state.historySearchCountState),
            historySearchIndexState:
              options?.indexState ?? state.historySearchIndexState,
            // Progress is only known once a SEARCH_INDEX_REBUILD_PROGRESS push
            // arrives for the in-flight request; clear stale progress from a
            // prior query whenever a request starts or a response lands.
            historySearchRebuildProgress: null,
          };
        }),

      setHistorySearchRebuildProgress: (progress) =>
        set({ historySearchRebuildProgress: progress }),

      setPendingHistorySearchNavigation: (nav) =>
        set({ pendingHistorySearchNavigation: nav }),

      // ============================================================================
      // SAVE WORKFLOW DIALOG
      // ============================================================================

      openSaveWorkflowDialog: (data) =>
        set({
          saveWorkflowDialogOpen: true,
          saveWorkflowDialogData: data,
          savePathCheck: null,
        }),

      closeSaveWorkflowDialog: () =>
        set({
          saveWorkflowDialogOpen: false,
          saveWorkflowDialogData: null,
          savePathCheck: null,
        }),

      openDuplicateWorkflowDialog: (data, invoker = null) =>
        set({
          duplicateWorkflowDialogOpen: true,
          duplicateWorkflowDialogData: { ...data, invoker },
          duplicateWorkflowRequest: null,
          duplicateWorkflowError: null,
        }),

      closeDuplicateWorkflowDialog: () => {
        const invoker = get().duplicateWorkflowDialogData?.invoker;
        set({
          duplicateWorkflowDialogOpen: false,
          duplicateWorkflowDialogData: null,
          duplicateWorkflowRequest: null,
          duplicateWorkflowError: null,
        });
        if (invoker && typeof document !== "undefined") {
          invoker.focus();
        }
      },

      beginDuplicateWorkflowRequest: (request) =>
        set({
          duplicateWorkflowRequest: request,
          duplicateWorkflowError: null,
        }),

      retireDuplicateWorkflowRequest: (error) =>
        set({ duplicateWorkflowRequest: null, duplicateWorkflowError: error }),

      setDuplicateWorkflowError: (error) =>
        set({ duplicateWorkflowError: error }),

      beginSavePathCheck: (requestId, path, address) =>
        set({
          savePathCheck: {
            requestId,
            path,
            address,
            exists: false,
            checking: true,
          },
        }),

      resolveSavePathCheck: (result) =>
        set((state) => {
          const pending = state.savePathCheck;
          if (
            !state.saveWorkflowDialogOpen ||
            !pending ||
            pending.requestId !== result.requestId ||
            pending.path !== result.path ||
            !areWorkflowAddressesEqual(pending.address, result.address)
          ) {
            return state;
          }
          return { savePathCheck: { ...result, checking: false } };
        }),

      clearSavePathCheck: () => set({ savePathCheck: null }),

      // ============================================================================
      // FILE BROWSER MODAL
      // ============================================================================

      openFileBrowser: (request) => set({ fileBrowserState: request }),

      closeFileBrowser: () => set({ fileBrowserState: null }),

      setFileBrowserLastDirectory: (path) =>
        set({ fileBrowserLastDirectory: path }),

      setWorkspaceEntrySort: (sort) =>
        set((state) =>
          state.workspaceEntrySort.key === sort.key &&
          state.workspaceEntrySort.direction === sort.direction
            ? state
            : { workspaceEntrySort: { ...sort } }
        ),

      setSaveLocationSelection: (selection) =>
        set({ saveLocationSelection: selection }),

      // ============================================================================
      // NEW WORKFLOW MODAL
      // ============================================================================

      openNewWorkflowModal: ({
        templates,
        defaultTemplateId,
        defaultTemplateSource,
        openCreateTemplateForm,
      }) =>
        set({
          newWorkflowModalOpen: true,
          createWorkflowPending: false,
          openCreateTemplateForm: openCreateTemplateForm ?? false,
          templates,
          defaultTemplateId: defaultTemplateId ?? "blank",
          defaultTemplateConfirmedId: defaultTemplateId ?? "blank",
          defaultTemplateSource:
            defaultTemplateSource ?? TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE,
          currentTemplate:
            templates.find((t) => t.id === (defaultTemplateId ?? "blank")) ??
            null,
        }),

      closeNewWorkflowModal: () =>
        set({
          newWorkflowModalOpen: false,
          createWorkflowPending: false,
          openCreateTemplateForm: false,
          currentTemplate: null,
        }),

      setCreateWorkflowPending: (pending) =>
        set({ createWorkflowPending: pending }),

      setCurrentTemplate: (template) => set({ currentTemplate: template }),

      setDefaultTemplateId: (id) => set({ defaultTemplateId: id }),
      setDefaultTemplateConfirmedId: (id) =>
        set({ defaultTemplateConfirmedId: id }),
      setDefaultTemplateSource: (source) =>
        set({ defaultTemplateSource: source }),
      setLastSavedTemplateScope: (scope) =>
        set({ lastSavedTemplateScope: scope }),
      setTemplateVariableDefaultsSaved: (saved) =>
        set({ templateVariableDefaultsSaved: saved }),

      setTemplates: (templates) => set({ templates }),
      setTemplateCatalog: (templateCatalog) => set({ templateCatalog }),

      setTemplateFileSelection: (selection) =>
        set({ templateFileSelection: selection }),

      setCustomTemplateCreated: (result) =>
        set({ customTemplateCreated: result }),

      // ============================================================================
      // RECENT WORKFLOWS
      // ============================================================================

      setRecentWorkflows: (workflows, seq) =>
        set((state) => {
          if (seq === undefined) {
            return { recentWorkflows: workflows, recentWorkflowsLoaded: true };
          }
          if (seq < state.recentWorkflowsListSeq) {
            return state;
          }
          const newerRows = state.recentWorkflows.filter(
            (workflow) =>
              (state.recentWorkflowRowSeqs[workflow.address.workflowKey] ?? 0) >
              seq
          );
          const newerKeys = new Set(
            newerRows.map((workflow) => workflow.address.workflowKey)
          );
          return {
            recentWorkflows: [
              ...workflows.filter(
                (workflow) => !newerKeys.has(workflow.address.workflowKey)
              ),
              ...newerRows,
            ],
            recentWorkflowsLoaded: true,
            recentWorkflowsListSeq: seq,
            recentWorkflowRowSeqs: Object.fromEntries(
              Object.entries(state.recentWorkflowRowSeqs).filter(
                ([, rowSeq]) => rowSeq > seq
              )
            ),
          };
        }),

      upsertRecentWorkflow: (workflow, seq) =>
        set((state) => {
          const workflowKey = workflow.address.workflowKey;
          if (
            seq <= state.recentWorkflowsListSeq ||
            seq <= (state.recentWorkflowRowSeqs[workflowKey] ?? 0)
          ) {
            return state;
          }
          const index = state.recentWorkflows.findIndex(
            (existing) => existing.address.workflowKey === workflowKey
          );
          return {
            recentWorkflows:
              index === -1
                ? [...state.recentWorkflows, workflow]
                : state.recentWorkflows.map((existing, i) =>
                    i === index ? workflow : existing
                  ),
            recentWorkflowRowSeqs: {
              ...state.recentWorkflowRowSeqs,
              [workflowKey]: seq,
            },
          };
        }),

      updateRecentWorkflowFromSummary: (summary) =>
        set((state) => {
          if (!summary.workflowKey) return state;
          let changed = false;
          const recentWorkflows = state.recentWorkflows.map((workflow) => {
            if (workflow.address.workflowKey !== summary.workflowKey) {
              return workflow;
            }
            changed = true;
            return {
              ...workflow,
              executionState: summary.executionState,
              totalSteps: summary.totalSteps,
              tokenTotals: summary.tokenTotals ?? workflow.tokenTotals,
              // Ticking while live, but a live lineage is listed under
              // Running; once it settles this is the frozen run time.
              activeExecutionMs:
                summary.executionTimeMs ?? workflow.activeExecutionMs,
              worktree: summary.worktree ?? workflow.worktree,
              lastModifiedAt: Math.max(
                workflow.lastModifiedAt ?? 0,
                summary.completedAt ?? summary.startedAt ?? 0
              ),
            };
          });
          return changed ? { recentWorkflows } : state;
        }),

      toggleRecentWorkflowsDropdown: () =>
        set((state) => ({
          recentWorkflowsDropdownOpen: !state.recentWorkflowsDropdownOpen,
        })),

      closeRecentWorkflowsDropdown: () =>
        set({ recentWorkflowsDropdownOpen: false }),

      // ============================================================================
      // MULTI-WORKFLOW SUPPORT
      // ============================================================================

      // Every mutation of `loadedWorkflows` reconciles the observed-running
      // ledger from the resulting list, so the two can never drift apart.
      setLoadedWorkflows: (workflows) =>
        set((state) => {
          const pendingByKey = new Map<WorkflowKey, OutputTab>(
            state.pendingOutputTabs.map(
              ({ workflowKey, tab }) => [workflowKey, tab] as const
            )
          );
          const activeOutputTabs = { ...state.activeOutputTabs };
          for (const workflow of workflows) {
            if (!workflow.workflowKey) continue;
            const tab = pendingByKey.get(workflow.workflowKey);
            if (tab) activeOutputTabs[workflow.id] = tab;
            pendingByKey.delete(workflow.workflowKey);
          }
          return {
            loadedWorkflows: workflows,
            observedRunningWorkflowIds: reconcileObservedRunning(
              state.observedRunningWorkflowIds,
              workflows
            ),
            activeOutputTabs,
            pendingOutputTabs: [...pendingByKey].map(([workflowKey, tab]) => ({
              workflowKey,
              tab,
            })),
          };
        }),

      addLoadedWorkflow: (workflow) =>
        set((state) => {
          const loadedWorkflows = [
            ...state.loadedWorkflows.filter((w) => w.id !== workflow.id),
            workflow,
          ];
          const pending = state.pendingOutputTabs.find(
            (item) => item.workflowKey === workflow.workflowKey
          );
          return {
            loadedWorkflows,
            observedRunningWorkflowIds: reconcileObservedRunning(
              state.observedRunningWorkflowIds,
              loadedWorkflows
            ),
            activeOutputTabs: pending
              ? { ...state.activeOutputTabs, [workflow.id]: pending.tab }
              : state.activeOutputTabs,
            pendingOutputTabs: pending
              ? state.pendingOutputTabs.filter(
                  (item) => item.workflowKey !== workflow.workflowKey
                )
              : state.pendingOutputTabs,
          };
        }),

      removeLoadedWorkflow: (workflowId) =>
        set((state) => {
          const loadedWorkflows = state.loadedWorkflows.filter(
            (w) => w.id !== workflowId
          );
          return {
            loadedWorkflows,
            observedRunningWorkflowIds: reconcileObservedRunning(
              state.observedRunningWorkflowIds,
              loadedWorkflows
            ),
          };
        }),

      updateLoadedWorkflow: (workflow) =>
        set((state) => {
          const loadedWorkflows = state.loadedWorkflows.map((w) =>
            w.id === workflow.id ? workflow : w
          );
          return {
            loadedWorkflows,
            observedRunningWorkflowIds: reconcileObservedRunning(
              state.observedRunningWorkflowIds,
              loadedWorkflows
            ),
          };
        }),

      setActiveWorkflowId: (id) => set({ activeWorkflowId: id }),

      setActiveWorkflowWorkingFilePath: (path) =>
        set({ activeWorkflowWorkingFilePath: path }),

      setWorkspaceWorktreeOwnership: (ownership) =>
        set({ workspaceWorktreeOwnership: ownership }),

      setViewingDeletedWorkflow: (value) =>
        set({ viewingDeletedWorkflow: value }),

      toggleRunBannerPinned: () =>
        set((state) => ({ runBannerPinned: !state.runBannerPinned })),

      // ============================================================================
      // LOADING STATE
      // ============================================================================

      setLoading: (loading, message) =>
        set({
          isLoading: loading,
          loadingMessage: loading ? (message ?? null) : null,
        }),

      // ============================================================================
      // TOAST NOTIFICATIONS
      // ============================================================================

      enqueueToast: (toast) =>
        set((state) => {
          if (!meetsToastLevel(toast.severity, selectToastLevel()))
            return state;

          if (
            toast.dedupeKey &&
            state.toastQueue.some(
              (queuedToast) => queuedToast.dedupeKey === toast.dedupeKey
            )
          ) {
            return state;
          }

          const item: ToastItem = {
            ...toast,
            id: toast.id ?? `toast-${++toastSequence}`,
            createdAt: toast.createdAt ?? Date.now(),
          };
          return {
            toastQueue: [...state.toastQueue, item].slice(-TOAST_QUEUE_LIMIT),
          };
        }),

      dismissToast: (id) =>
        set((state) => ({
          toastQueue: state.toastQueue.filter((toast) => toast.id !== id),
        })),

      clearToasts: () => set({ toastQueue: [] }),

      showToast: (message, severity = USER_FEEDBACK_SEVERITY.INFO, options) =>
        set((state) => {
          if (!meetsToastLevel(severity, selectToastLevel())) return state;

          if (
            options?.dedupeKey &&
            state.toastQueue.some(
              (toast) => toast.dedupeKey === options.dedupeKey
            )
          ) {
            return state;
          }
          const item: ToastItem = {
            id: `toast-${++toastSequence}`,
            message,
            severity,
            createdAt: Date.now(),
            ...options,
          };
          return {
            toastQueue: [...state.toastQueue, item].slice(-TOAST_QUEUE_LIMIT),
          };
        }),

      // Kept for existing callers while the queue API is adopted incrementally.
      hideToast: () => set({ toastQueue: [] }),
      setHarnessDetectionRetryResult: (result) =>
        set({ harnessDetectionRetryResult: result }),

      setContentPreviewModal: (modal) => set({ contentPreviewModal: modal }),

      setSuffixEditConfirmation: (confirmation) =>
        set({ suffixEditConfirmation: confirmation }),

      // ============================================================================
      // TERMINAL TAB STATE
      // ============================================================================

      setActiveOutputTab: (workflowId: string, tab: OutputTab) =>
        set((state) => ({
          activeOutputTabs: { ...state.activeOutputTabs, [workflowId]: tab },
        })),

      forceOutputTabForWorkflow: (workflowKey, tab) =>
        set((state) => {
          const targetIds = state.loadedWorkflows
            .filter((workflow) => workflow.workflowKey === workflowKey)
            .map((workflow) => workflow.id);
          if (targetIds.length > 0) {
            const activeOutputTabs = { ...state.activeOutputTabs };
            for (const id of targetIds) activeOutputTabs[id] = tab;
            return { activeOutputTabs };
          }
          return {
            pendingOutputTabs: [
              ...state.pendingOutputTabs.filter(
                (pending) => pending.workflowKey !== workflowKey
              ),
              { workflowKey, tab },
            ],
          };
        }),

      setTerminalSessionActive: (workflowId: string, active: boolean) =>
        set((state) => {
          const next = new Set(state.terminalActiveWorkflows);
          if (active) {
            next.add(workflowId);
          } else {
            next.delete(workflowId);
          }
          return { terminalActiveWorkflows: next };
        }),

      // ============================================================================
      // TERMINAL SESSION RAIL LAYOUT
      // ============================================================================

      setTerminalRailCollapsed: (collapsed) =>
        set({ terminalRailCollapsed: collapsed }),

      setTerminalRailSizePx: (px) => set({ terminalRailSizePx: px }),

      // ============================================================================
      // RUN HISTORY VIEW
      // ============================================================================

      setHistoryView: () => set({ isViewingHistory: true }),

      clearHistoryView: () => set({ isViewingHistory: false }),

      // Adding a field here means adding it to `RunViewLoadRollback` too —
      // that type is the snapshot `requestRunViewLoad` takes so an unanswered
      // request can be undone, and a field missing from it stays stranded on
      // the workflow that never loaded.
      setDisplayedRunView: (
        address,
        summaries,
        executionRunRef,
        revisions,
        pendingRewind,
        runDirectory,
        isSystemGenerated
      ) =>
        set((state) => ({
          displayedViewAddress: address,
          displayedRunDirectory: runDirectory ?? null,
          executionRunRef: executionRunRef ?? null,
          displayedDefinitionRevision: revisions?.definitionRevision ?? null,
          displayedDescriptorRevision: mergeDescriptorRevision(
            state,
            address,
            revisions?.descriptorRevision ?? null
          ),
          pendingRewind: pendingRewind ?? null,
          runSummaries: summaries,
          isViewingHistory: address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          viewedLineageIsSystemGenerated: isSystemGenerated ?? false,
        })),

      // Address + revisions, plus one cross-lineage coherence guard. Ordinary
      // same-lineage edits retain their run summaries and history framing.
      // After FILE_SELECTED/SESSION_RESTORED clears the old address, however,
      // the next identity may belong to a different lineage; summaries carry
      // their own workflowKey, so discard them instead of attaching phantom
      // runs (and the old execution/rewind state) to the new address.
      setDisplayedViewIdentity: (
        address,
        definitionRevision,
        descriptorRevision,
        runDirectory,
        isSystemGenerated
      ) =>
        set((state) => {
          const summariesBelongToAddress = areRunSummariesForLineage(
            state.runSummaries,
            address
          );
          return {
            displayedViewAddress: address,
            displayedRunDirectory: runDirectory ?? null,
            displayedDefinitionRevision: definitionRevision,
            displayedDescriptorRevision: mergeDescriptorRevision(
              state,
              address,
              descriptorRevision
            ),
            // A SESSION_RESTORED replay (sent right after this identity's
            // RUN_VIEW_LOADED when binding a client to a live/retired
            // instance — see WorkflowOrchestrator.replayWorkflowStateTo)
            // resets viewedLineageIsSystemGenerated to false via
            // applyWorkflowChange() before this identity re-publish runs.
            // Restore it here so a running system-generated lineage doesn't
            // silently lose its read-only lockdown.
            viewedLineageIsSystemGenerated: isSystemGenerated ?? false,
            ...(summariesBelongToAddress
              ? {}
              : {
                  runSummaries: [],
                  executionRunRef: null,
                  pendingRewind: null,
                }),
          };
        }),

      // Descriptor knowledge only, and only for the address the client is
      // already displaying. This is how a snapshot whose *definition* portion
      // is stale (and therefore ignored) still contributes its newer lineage
      // revision instead of leaving run-lifecycle actions armed with a
      // superseded one.
      adoptDescriptorRevision: (address, descriptorRevision) =>
        set((state) =>
          areWorkflowAddressesEqual(address, state.displayedViewAddress)
            ? {
                displayedDescriptorRevision: mergeDescriptorRevision(
                  state,
                  address,
                  descriptorRevision
                ),
              }
            : state
        ),

      // The live execution reached a terminal state. Nothing else refreshes the
      // addressed snapshot at that moment, so without this the client keeps an
      // `executionRunRef` whose summary still reads "running" and the header
      // stays stuck on the active Pause/Stop controls instead of offering
      // Re-run. Folding the terminal state into that run's own summary keeps the
      // run panel honest until the next RUN_VIEW_LOADED replaces it.
      markExecutionRunFinished: (executionState) =>
        set((state) =>
          state.executionRunRef === null
            ? state
            : {
                executionRunRef: null,
                runSummaries: state.runSummaries.map((summary) =>
                  summary.runRef === state.executionRunRef
                    ? { ...summary, executionState }
                    : summary
                ),
              }
        ),

      // The mirror of markExecutionRunFinished: execution began on the run the
      // client is already displaying (a continuation or append on an
      // already-viewed run, not a fresh draft promotion). The backend's own
      // run-view refresh for this transition (`syncExecutingRunViews`) only
      // targets clients still addressed at the lineage's *draft* — a client
      // already addressed at the run being continued is not among its
      // targets, so `executionRunRef` and this run's cached summary would
      // otherwise keep reading their pre-continuation values (often
      // "completed"/"idle") until the run finishes and an unrelated refresh
      // happens to correct them. Setting both optimistically here is what
      // makes RunSummaryBanner and the run panel show "Running" immediately
      // instead of lagging for the run's entire duration.
      markExecutionRunStarted: () =>
        set((state) => {
          if (
            state.displayedViewAddress?.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN
          )
            return state;
          const runRef = state.displayedViewAddress.runRef;
          if (
            state.executionRunRef !== null &&
            state.executionRunRef !== runRef
          )
            return state;
          if (state.executionRunRef === runRef) return state;
          return {
            executionRunRef: runRef,
            runSummaries: state.runSummaries.map((summary) =>
              summary.runRef === runRef
                ? { ...summary, executionState: EXECUTION_STATES.RUNNING }
                : summary
            ),
          };
        }),

      updateRunSummaryWorktree: (runRef, worktree) =>
        set((state) => ({
          runSummaries: state.runSummaries.map((summary) =>
            summary.runRef === runRef ? { ...summary, worktree } : summary
          ),
        })),

      markViewAddressApplied: (address, definitionRevision) =>
        set({
          appliedViewAddress: address,
          appliedDefinitionRevision: definitionRevision,
        }),

      markAppliedDefinitionRevision: (definitionRevision) =>
        set((state) => ({
          appliedDefinitionRevision:
            state.appliedDefinitionRevision === null
              ? definitionRevision
              : Math.max(state.appliedDefinitionRevision, definitionRevision),
        })),

      requestRunViewLoad: (
        address,
        summaries,
        executionRunRef,
        targetWorkflowName
      ) => {
        runViewRequestSequence += 1;
        const requestId = `run-view-${Date.now()}-${runViewRequestSequence}`;
        // Optimistic carry-over is only meaningful inside one lineage. Carrying
        // the previous workflow's summaries and executionRunRef across a
        // workflow switch built a header address out of the new workflowKey and
        // the old run — so Stop targeted a run that lineage does not own and
        // silently did nothing.
        const previous = get();
        const sameLineage =
          previous.displayedViewAddress?.workflowKey === address.workflowKey;
        // Captured before the optimistic move, so a request that is never
        // answered can be undone rather than left half-applied.
        const rollback: RunViewLoadRollback = {
          displayedViewAddress: previous.displayedViewAddress,
          displayedRunDirectory: previous.displayedRunDirectory,
          runSummaries: previous.runSummaries,
          executionRunRef: previous.executionRunRef,
          displayedDefinitionRevision: previous.displayedDefinitionRevision,
          displayedDescriptorRevision: previous.displayedDescriptorRevision,
          pendingRewind: previous.pendingRewind,
          isViewingHistory: previous.isViewingHistory,
          viewedLineageIsSystemGenerated:
            previous.viewedLineageIsSystemGenerated,
        };
        get().setDisplayedRunView(
          address,
          sameLineage ? summaries : [],
          sameLineage ? executionRunRef : undefined
        );
        set({
          pendingRunViewRequestId: requestId,
          pendingRunViewAddress: address,
          runViewLoadRetrying: false,
          runViewLoadRollback: rollback,
          // A cross-lineage request is a workflow switch: until its snapshot
          // arrives the panels still render the previous workflow, so record
          // the target for instant header feedback and the switch overlay.
          // Same-lineage loads (run panel) keep the panels they refine.
          pendingRunViewSwitch: sameLineage
            ? null
            : { requestId, workflowName: targetWorkflowName ?? null, address },
        });
        return requestId;
      },

      clearPendingRunViewLoad: () =>
        set({
          pendingRunViewRequestId: null,
          pendingRunViewAddress: null,
          pendingRunViewSwitch: null,
          runViewLoadRetrying: false,
          runViewLoadRollback: null,
        }),

      markRunViewLoadRetrying: () => set({ runViewLoadRetrying: true }),

      rollbackRunViewLoad: () =>
        set((state) => {
          const rollback = state.runViewLoadRollback;
          const retired = {
            pendingRunViewRequestId: null,
            pendingRunViewAddress: null,
            pendingRunViewSwitch: null,
            runViewLoadRetrying: false,
            runViewLoadRollback: null,
          };
          if (!rollback) return retired;
          return {
            ...rollback,
            ...retired,
            // Restored verbatim, including the descriptor revision: while a
            // request is pending, WORKFLOW_VIEW_IDENTITY only accepts the
            // address being switched *to*, so the previous address's revisions
            // cannot have advanced behind this snapshot's back.
            //
            // The restored address's content is resident but not necessarily
            // whole — navigateToWorkflowAddress clears history outputs up front
            // when the target is the executing run of the displayed lineage.
            // Dropping the applied marker keeps a click on the workflow we just
            // returned to a real reload instead of the inert no-op the
            // displayed/applied short-circuit would otherwise make it.
            appliedViewAddress: null,
            appliedDefinitionRevision: null,
          };
        }),

      // ============================================================================
      // DROPDOWN HIDE FEATURE
      // ============================================================================

      hideDropdownOption: (namespace, value) =>
        set((state) => ({
          hiddenDropdownOptions: {
            ...state.hiddenDropdownOptions,
            [namespace]: [
              ...(state.hiddenDropdownOptions[namespace] ?? []).filter(
                (v) => v !== value
              ),
              value,
            ],
          },
        })),

      unhideDropdownOption: (namespace, value) =>
        set((state) => ({
          hiddenDropdownOptions: {
            ...state.hiddenDropdownOptions,
            [namespace]: (state.hiddenDropdownOptions[namespace] ?? []).filter(
              (v) => v !== value
            ),
          },
        })),

      clearHiddenDropdownOptions: (namespace) =>
        set((state) => ({
          hiddenDropdownOptions: {
            ...state.hiddenDropdownOptions,
            [namespace]: [],
          },
        })),

      // ============================================================================
      // FOOTER QUICK PICKER
      // ============================================================================

      setFooterOpenPicker: (picker) => set({ footerOpenPicker: picker }),

      // ============================================================================
      // MOBILE DRAWER
      // ============================================================================

      toggleMobileSteps: () =>
        set((state) => ({ mobileStepsOpen: !state.mobileStepsOpen })),

      setMobileStepsMode: (mode) => set({ mobileStepsMode: mode }),

      toggleMobileWorkflowProps: () =>
        set((state) => ({
          mobileWorkflowPropsOpen: !state.mobileWorkflowPropsOpen,
        })),

      closeMobileSteps: () => set({ mobileStepsOpen: false }),

      closeMobileWorkflowProps: () => set({ mobileWorkflowPropsOpen: false }),

      revealWorkflowVariable: (name, { mobile }) =>
        set((state) => ({
          workflowVariableRevealRequest: {
            name,
            nonce: (state.workflowVariableRevealRequest?.nonce ?? 0) + 1,
          },
          ...(mobile
            ? { mobileWorkflowPropsOpen: true }
            : { settingsCollapsed: false }),
        })),

      clearWorkflowVariableRevealRequest: () =>
        set({ workflowVariableRevealRequest: null }),

      // ============================================================================
      // GLOBAL SETTINGS DRAWER
      // ============================================================================

      toggleGlobalSettings: () =>
        set((state) => ({
          globalSettingsOpen: !state.globalSettingsOpen,
          isHistorySearchOpen: false,
          historySearchLoading: false,
        })),

      closeGlobalSettings: () => set({ globalSettingsOpen: false }),

      setGlobalSettingsTab: (tab) => set({ globalSettingsActiveTab: tab }),

      closeFullscreenDrawers: () =>
        set({
          globalSettingsOpen: false,
          isHistorySearchOpen: false,
          historySearchLoading: false,
          historySearchRebuildProgress: null,
        }),

      // ============================================================================
      // STARTUP OVERLAY
      // ============================================================================

      setStartupReady: (ready) =>
        set({
          startupReady: ready,
          ...(ready
            ? {
                devRestarting: false,
                workspaceInitRequired: false,
                showLayoutPreference: false,
              }
            : {}),
        }),
      setDevRestarting: (restarting) =>
        set({ devRestarting: restarting, startupReady: !restarting }),

      setWorkspaceInitRequired: (required) =>
        set({ workspaceInitRequired: required }),

      setShowLayoutPreference: (show) => set({ showLayoutPreference: show }),

      setMyClientId: (clientId) => set({ myClientId: clientId }),

      setUxSnapshotButtonVisible: (visible) =>
        set({ uxSnapshotButtonVisible: visible }),

      setUxSnapshotStatus: (status) => set({ uxSnapshotStatus: status }),

      // ============================================================================
      // RESET
      // ============================================================================

      resetUi: () =>
        set({
          // Reset non-persisted state
          saveWorkflowDialogOpen: false,
          saveWorkflowDialogData: null,
          savePathCheck: null,
          duplicateWorkflowDialogOpen: false,
          duplicateWorkflowDialogData: null,
          duplicateWorkflowRequest: null,
          duplicateWorkflowError: null,
          fileBrowserState: null,
          propertiesDrawerOpen: false,
          newWorkflowModalOpen: false,
          createWorkflowPending: false,
          openCreateTemplateForm: false,
          viewingDeletedWorkflow: null,
          viewedLineageIsSystemGenerated: false,
          templates: [],
          templateCatalog: [],
          currentTemplate: null,
          isHistorySearchOpen: false,
          historySearchResults: [],
          historySearchQuery: "",
          historySearchDeep: false,
          historySearchRegex: false,
          historySearchError: null,
          historySearchLoading: false,
          historySearchTotalCount: 0,
          historySearchCountState: HISTORY_SEARCH_COUNT_STATES.EXACT,
          historySearchIndexState: "ready",
          historySearchRebuildProgress: null,
          historySearchFilters: createDefaultHistorySearchFilters(),
          pendingHistorySearchNavigation: null,
          pendingFindRequest: null,
          workflowVariableRevealRequest: null,
          recentWorkflows: [],
          recentWorkflowsLoaded: false,
          recentWorkflowsListSeq: 0,
          recentWorkflowRowSeqs: {},
          recentWorkflowsDropdownOpen: false,
          workspaceWorktreeOwnership: null,
          isLoading: false,
          loadingMessage: null,
          outputScrollTargets: {},
          hiddenOutputTargets: {},
          outputStepFilterVersion: initialState.outputStepFilterVersion,
          toastQueue: [],
          footerOpenPicker: null,
          suffixEditConfirmation: null,
          contentPreviewModal: null,
          harnessDetectionRetryResult: null,
        }),

      resetLayoutState: () => {
        // Remove the persisted key from vscode state so the next reload starts fresh.
        // Calling set() immediately after re-persists the defaults, so the current
        // session also reflects the initial values.
        void useUiStore.persist.clearStorage();
        set({
          stepsCollapsed: initialState.stepsCollapsed,
          outputCollapsed: initialState.outputCollapsed,
          editorCollapsed: initialState.editorCollapsed,
          settingsCollapsed: initialState.settingsCollapsed,
          lastDesktopSizes: { ...initialState.lastDesktopSizes },
          lastMobileSizes: { ...initialState.lastMobileSizes },
          mobileStepsOpen: initialState.mobileStepsOpen,
          mobileStepsMode: initialState.mobileStepsMode,
          terminalRailCollapsed: initialState.terminalRailCollapsed,
          terminalRailSizePx: initialState.terminalRailSizePx,
          diffsCollapsed: initialState.diffsCollapsed,
          undoDialogDiffsCollapsed: initialState.undoDialogDiffsCollapsed,
          runBannerPinned: initialState.runBannerPinned,
          workspaceEntrySort: { ...initialState.workspaceEntrySort },
        });
      },
    }),
    {
      name: "ctrlyoke-ui-state",
      // Rehydrated explicitly from main.tsx before App mounts so retained
      // panel reconnects do not call vscode.getState() during module import.
      skipHydration: true,
      storage: createJSONStorage(() => webviewRawStorage),
      // Only persist specific fields (layout preferences)
      partialize: (state) =>
        Object.fromEntries(
          persistedFields.map((key) => [key, state[key]])
        ) as Pick<UiState, (typeof persistedFields)[number]>,
    }
  )
);
