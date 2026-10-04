import {
  isTerminalExecutionState,
  type OutputHistoryManager,
} from "../core/orchestration/OutputHistoryManager";
import * as fs from "node:fs/promises";
import type { WorkflowLineageRepository } from "../core/orchestration/WorkflowLineageRepository";
import type { RunNavigationSummary } from "../core/orchestration/OutputHistoryManager";
import { bootstrapCliWorkspace } from "./CliWorkspaceBootstrap";
import type {
  HistoryListOptions,
  HistoryRunsOptions,
  HistoryShowOptions,
  HistoryStepsOptions,
  HistorySearchOptions as HistorySearchCommandOptions,
} from "./HistoryCommandDefinitions";
import {
  resolveCliWorkflowKey,
  resolveCliRunRef,
  parseHistoryShowAttempt,
  parseHistoryShowStep,
  formatCliStepSelector,
  formatFinalPassSelector,
  formatHistoryTargetSelector,
  type CliHistoryShowAttemptSelector,
  type CliHistoryShowStepSelector,
  type CliRunSummaryProvider,
} from "./CliRunSelector";
import { CliTerminalFormatter } from "./CliTerminalFormatter";
import type {
  RunRef,
  ScriptRuntimeOutput,
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../types/CtrlYokeTypes";
import { isScriptStep } from "../types/CtrlYokeTypes";
import {
  promptFirstLinePreview,
  STEP_LISTING_PROMPT_PREVIEW_MAX_CHARS,
  truncateText,
} from "../utils/TextUtils";
import { formatFinalPassBadge } from "../utils/FinalStepLabels";
import type { RunSummary } from "../types/WorkflowTimelineTypes";
import {
  EXECUTION_PHASES,
  EXECUTION_STATES,
  CLI_EVENT_TYPES,
  CTRLYOKE_ENV_VARS,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  HISTORY_EVENT_KINDS,
  HISTORY_LIST_SORT_ORDERS,
  HISTORY_SEARCH_COUNT_STATES,
  HISTORY_SEARCH_INDEX_STATES,
  HISTORY_STEP_STATES,
  HISTORY_SHOW_STEP_SELECTORS,
  HISTORY_SHOW_ATTEMPT_SELECTORS,
  PROMPT_TERMINAL_STATUS,
  RUN_OUTPUT_RESOLVER_EVENT_KINDS,
  SCRIPT_OUTPUT_SOURCES,
  STATUS_MESSAGE_SEVERITY,
  type HistoryListSortOrder,
  type ScriptOutputSource,
} from "../types/DashboardConstants";
import type { OutputExecutionTarget } from "../types/OutputHistoryTypes";
import type {
  HistoryEventKind,
  HistorySearchQuery,
  HistorySearchResponse,
  HistorySearchResult,
} from "../types/WorkflowTimelineTypes";
import {
  type RunAttemptLifecycleEvent,
  type RunOutputResolverAttemptEvent,
  type ResolvedRunAttemptIdentity,
  type ResolvedRunAttemptValue,
  isStepAttemptKind,
  RunOutputResolver,
} from "../core/orchestration/RunOutputResolver";
import {
  pageOutputText,
  parseOutputTextPaging,
  type OutputTextPagingWording,
  type PagedOutputText,
} from "../core/orchestration/OutputTextPaging";
import {
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_ATTEMPT_TERMINAL_STATES,
  TIMELINE_EVENT_TYPES,
  type TimelineAttemptTerminalState,
} from "../types/WorkflowTimelineTypes";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { getLineageLastModifiedAt } from "../utils/WorkingFileMetadata";
import type { CliOutput } from "../types/WebviewMessageTypes";
import type { CliEvent } from "../types/CliOutputTypes";
import { secretRedactionService } from "../utils/SecretRedactionService";
import { HistorySearchService } from "../core/orchestration/HistorySearchService";
import {
  assertStepIndex,
  formatValidStepIndexRange,
} from "../core/orchestration/StepIndexValidation";
import type { HistorySearchOptions } from "../core/orchestration/HistorySearchService";
import type {
  IndexRebuildProgressCallback,
  PartialSearchResultsCallback,
} from "../core/orchestration/HistorySearchIndexService";
import {
  HistoryCandidateExtractor,
  SCRIPT_EVENT_KIND_BY_SOURCE,
  historyEventKindForCliEventType,
} from "../core/orchestration/HistoryCandidateExtractor";
import {
  historyPathMatches,
  normalizeHistoryPathFilter,
} from "../core/orchestration/HistorySearchFilters";
import type { PartialCtrlYokeSettings } from "../types/CtrlYokeSettings";
import { parseHistoryTime } from "./HistoryTime";
import {
  parseHistoryInteger,
  parseHistorySince,
  parseHistoryStateFilter,
} from "./HistoryFilterParsing";
import { formatFinalPassLabel } from "../utils/FinalStepLabels";

export interface HistoryInspectionCommandIo {
  writeOut(message: string): void;
  writeErr(message: string): void;
  writeErrProgress(message: string): void;
  isErrTty: boolean;
}

export interface HistoryInspectionLineageRepository extends Pick<
  WorkflowLineageRepository,
  | "listLineageKeys"
  | "listRunRefs"
  | "tryReadDescriptor"
  | "readWorkflowDisplayName"
> {}

export interface HistoryInspectionOutputHistoryManager extends Pick<
  OutputHistoryManager,
  "getRunNavigationSummary" | "getRunSummaries"
> {}

export interface HistoryInspectionRunOutputResolver {
  streamAttempts(
    manifestPath: string
  ): AsyncGenerator<RunOutputResolverAttemptEvent, void, undefined>;
  streamAttemptLifecycle(
    manifestPath: string
  ): AsyncGenerator<RunAttemptLifecycleEvent, void, undefined>;
}

export interface HistoryInspectionWorkspace {
  workspaceRoot: string;
  createOutputHistoryManager(): HistoryInspectionOutputHistoryManager;
  createLineageRepository(): HistoryInspectionLineageRepository;
}

export interface HistoryInspectionCommandDependencies {
  bootstrapCliWorkspace?: (
    options: Pick<
      | HistoryListOptions
      | HistoryRunsOptions
      | HistoryShowOptions
      | HistoryStepsOptions
      | HistorySearchCommandOptions,
      "cwd"
    >,
    cliOverlay?: PartialCtrlYokeSettings
  ) => Promise<HistoryInspectionWorkspace>;
  createRunOutputResolver?: () => HistoryInspectionRunOutputResolver;
  createHistorySearchService?: () => HistorySearchCommandService;
}

export interface HistorySearchCommandService {
  search(
    query: string | HistorySearchQuery,
    workspaceFolderPath: string,
    onRebuildProgress?: IndexRebuildProgressCallback,
    signal?: AbortSignal,
    onPartialResults?: PartialSearchResultsCallback,
    options?: HistorySearchOptions
  ): Promise<HistorySearchResponse>;
}

interface HistoryListRow {
  workflowKey: WorkflowKey;
  workflowName: string;
  isFavorite: boolean;
  createdAt: number | null;
  lastModifiedAt: number | null;
  runCount: number;
  latestRun: {
    runId: number;
    runRef: RunRef;
    executionState: string;
    startedAt: number;
    completedAt: number | null;
  } | null;
}

/** CLI wording for the paging contract shared with MCP `read_output`. */
const HISTORY_SHOW_PAGING_WORDING: OutputTextPagingWording = {
  surface: "history show",
  selectionRequirement: "exactly one selected attempt",
  cursorSource: "history show",
  optionNames: { cursor: "--cursor", limit: "--limit", tail: "--tail" },
};

export async function listHistoryCommand(
  options: HistoryListOptions,
  io: HistoryInspectionCommandIo,
  dependencies: HistoryInspectionCommandDependencies = {}
): Promise<void> {
  // Every filter is parsed before the lineage scan, which reads one manifest
  // per lineage, so a mistyped flag fails at once instead of after it.
  const states = parseHistoryStateFilter(options.state);
  const since = parseHistorySince(options.since);
  const limit = parseHistoryInteger(
    options.limit,
    "--limit",
    1,
    Number.MAX_SAFE_INTEGER
  );
  const sort = parseHistoryListSort(options.sort);
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options);
  const lineageRepository = workspace.createLineageRepository();
  const historyManager = workspace.createOutputHistoryManager();
  const rows = await buildHistoryListRows(
    workspace.workspaceRoot,
    options,
    lineageRepository,
    historyManager
  );
  const filteredRows = rows
    .filter(
      (row) =>
        !states ||
        (row.latestRun && states.includes(row.latestRun.executionState))
    )
    .filter(
      (row) =>
        since === undefined ||
        (row.latestRun && row.latestRun.startedAt >= since)
    )
    .sort(historyListRowComparator(sort))
    .slice(0, limit);

  if (options.json) {
    io.writeOut(
      JSON.stringify(secretRedactionService.redactValue(filteredRows))
    );
    return;
  }

  renderHistoryList(filteredRows, io);
}

function parseHistoryListSort(value: string | undefined): HistoryListSortOrder {
  return (
    parseHistorySearchValues(
      value === undefined ? undefined : [value],
      Object.values(HISTORY_LIST_SORT_ORDERS),
      "--sort"
    )?.[0] ?? HISTORY_LIST_SORT_ORDERS.LATEST
  );
}

function historyListRowComparator(
  sort: HistoryListSortOrder
): (a: HistoryListRow, b: HistoryListRow) => number {
  const byKey = (a: HistoryListRow, b: HistoryListRow): number =>
    a.workflowKey < b.workflowKey ? -1 : a.workflowKey > b.workflowKey ? 1 : 0;
  if (sort === HISTORY_LIST_SORT_ORDERS.NAME) {
    return (a, b) =>
      a.workflowName.localeCompare(b.workflowName) || byKey(a, b);
  }
  return (a, b) => {
    const aStarted = a.latestRun?.startedAt;
    const bStarted = b.latestRun?.startedAt;
    if (aStarted === undefined || bStarted === undefined) {
      // Lineages that have never run sort after every lineage that has.
      return aStarted === bStarted
        ? byKey(a, b)
        : aStarted === undefined
          ? 1
          : -1;
    }
    return bStarted - aStarted || byKey(a, b);
  };
}

export async function runsHistoryCommand(
  options: HistoryRunsOptions,
  io: HistoryInspectionCommandIo,
  dependencies: HistoryInspectionCommandDependencies = {}
): Promise<void> {
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options);
  const workflowKey = await resolveCliWorkflowKey(
    workspace.workspaceRoot,
    workspace.createLineageRepository(),
    options.workflow,
    (message) => io.writeErr(message)
  );
  const lineageRepository = workspace.createLineageRepository();

  const workflowName = await lineageRepository.readWorkflowDisplayName(
    workspace.workspaceRoot,
    workflowKey
  );
  const summaries = await workspace
    .createOutputHistoryManager()
    .getRunSummaries(workflowKey);

  if (options.json) {
    io.writeOut(JSON.stringify(secretRedactionService.redactValue(summaries)));
    return;
  }

  io.writeOut(`Workflow: ${workflowName} (${workflowKey})`);
  renderRunSummaries(summaries, io);
}

/**
 * Resolve `--workflow`/`--run` for a command that reads one run. Every such
 * command reports a missing lineage, and a lineage with only a draft, the
 * same way `history runs` does.
 */
async function resolveHistoryRun(
  workspace: HistoryInspectionWorkspace,
  io: HistoryInspectionCommandIo,
  workflowKey: string,
  runSelector: string | undefined
): Promise<{
  workflowKey: WorkflowKey;
  runRef: RunRef;
  runSummary: RunSummary;
}> {
  const resolvedWorkflowKey = await resolveCliWorkflowKey(
    workspace.workspaceRoot,
    workspace.createLineageRepository(),
    workflowKey,
    (message) => io.writeErr(message)
  );
  const summaries = await workspace
    .createOutputHistoryManager()
    .getRunSummaries(resolvedWorkflowKey);
  if (summaries.length === 0) {
    throw new Error(
      `Workflow lineage "${resolvedWorkflowKey}" has no runs yet.`
    );
  }
  const summaryProvider: CliRunSummaryProvider = {
    getRunSummaries: async () => summaries,
  };
  const runRef = await resolveCliRunRef(
    summaryProvider,
    resolvedWorkflowKey,
    runSelector,
    "--run"
  );
  const runSummary = summaries.find((summary) => summary.runRef === runRef);
  if (!runSummary) {
    throw new Error(`Run "${runRef}" was not found in history.`);
  }
  return { workflowKey: resolvedWorkflowKey, runRef, runSummary };
}

/**
 * One step attempt, independent of phase. A step's pre/end-condition and
 * worktree-setup attempts share its `runIndex`/`attemptIndex`, so they are
 * selected together with it.
 */
type HistoryAttemptIdentity = Pick<
  ResolvedRunAttemptIdentity,
  "target" | "runIndex" | "attemptIndex"
>;

interface HistoryTargetAttempts {
  target: OutputExecutionTarget;
  /** Step attempts (AI or script) started for this target. */
  attempts: number;
  /** Highest 1-based `--attempt` number recorded for this target. */
  maxAttemptNumber: number;
  latest: HistoryAttemptIdentity;
  firstStartedAt: number;
  /** Terminal state of `latest`'s own attempt, once it has one. */
  latestTerminalState?: TimelineAttemptTerminalState;
  latestTerminatedAt?: number;
}

/** Payload-free per-target attempt facts from one lifecycle scan. */
interface HistoryAttemptIndex {
  targets: Map<string, HistoryTargetAttempts>;
  /** The most recently started step attempt in the run. */
  latest?: HistoryAttemptIdentity;
  /** Attempt identity keys with any phase that never terminated. */
  running: Set<string>;
  finalPassCount: number;
}

/**
 * Scan attempt lifecycle records only. This is the cheap pre-pass that
 * `latest`/`running`/`final:latest`, `--attempt`, and paging need before any
 * output is written; it never parses or retains output payloads.
 */
async function collectHistoryAttemptIndex(
  resolver: HistoryInspectionRunOutputResolver,
  manifestPath: string
): Promise<HistoryAttemptIndex> {
  const targets = new Map<string, HistoryTargetAttempts>();
  const openPhases = new Map<string, string>();
  const stepAttemptPhases = new Set<string>();
  let latest: HistoryAttemptIdentity | undefined;
  let finalPassCount = 0;
  for await (const event of resolver.streamAttemptLifecycle(manifestPath)) {
    const identityKey = historyAttemptKey(event);
    const phaseKey = `${identityKey}:phase:${event.phase ?? EXECUTION_PHASES.PROMPT}`;
    const targetKey = historyAttemptTargetKey(event.target);
    if (event.eventType === TIMELINE_EVENT_TYPES.ATTEMPT_STARTED) {
      openPhases.set(phaseKey, identityKey);
      if (!isStepAttemptKind(event.attemptKind)) continue;
      stepAttemptPhases.add(phaseKey);
      const identity: HistoryAttemptIdentity = {
        target: event.target,
        runIndex: event.runIndex,
        attemptIndex: event.attemptIndex,
      };
      latest = identity;
      if (event.target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        finalPassCount = Math.max(finalPassCount, event.target.loopIndex + 1);
      }
      const existing = targets.get(targetKey);
      if (!existing) {
        targets.set(targetKey, {
          target: event.target,
          attempts: 1,
          maxAttemptNumber: event.attemptIndex + 1,
          latest: identity,
          firstStartedAt: event.timestampMs,
        });
        continue;
      }
      existing.attempts++;
      existing.maxAttemptNumber = Math.max(
        existing.maxAttemptNumber,
        event.attemptIndex + 1
      );
      if (isLaterHistoryAttempt(identity, existing.latest)) {
        existing.latest = identity;
        existing.latestTerminalState = undefined;
        existing.latestTerminatedAt = undefined;
      }
      continue;
    }
    openPhases.delete(phaseKey);
    const entry = targets.get(targetKey);
    if (
      entry &&
      stepAttemptPhases.has(phaseKey) &&
      historyAttemptKey(entry.latest) === identityKey
    ) {
      entry.latestTerminalState = event.terminalState;
      entry.latestTerminatedAt = event.timestampMs;
    }
  }
  return {
    targets,
    ...(latest ? { latest } : {}),
    running: new Set(openPhases.values()),
    finalPassCount,
  };
}

/** Resolved `--step`/`--attempt` selection, tested per settled attempt. */
interface HistoryShowSelection {
  target?: CliHistoryShowStepSelector;
  attempt: CliHistoryShowAttemptSelector;
  index?: HistoryAttemptIndex;
}

function matchesHistoryShowTarget(
  attempt: HistoryAttemptIdentity,
  selection: HistoryShowSelection
): boolean {
  const selector = selection.target;
  if (!selector) return true;
  const { target } = attempt;
  switch (selector.kind) {
    case FINAL_STEP_PHASES.QUEUE:
      return (
        target.kind === FINAL_STEP_PHASES.QUEUE &&
        selector.stepIndices.includes(target.stepIndex)
      );
    case FINAL_STEP_PHASES.FINAL_STEP:
      return (
        target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
        (selector.passNumber === undefined ||
          (typeof selector.passNumber === "number" &&
            target.loopIndex === selector.passNumber - 1))
      );
    case HISTORY_SHOW_STEP_SELECTORS.LATEST:
      return (
        selection.index?.latest !== undefined &&
        historyAttemptKey(attempt) === historyAttemptKey(selection.index.latest)
      );
    case HISTORY_SHOW_STEP_SELECTORS.RUNNING:
      return selection.index?.running.has(historyAttemptKey(attempt)) === true;
  }
}

function matchesHistoryShowAttempt(
  attempt: HistoryAttemptIdentity,
  selection: HistoryShowSelection
): boolean {
  switch (selection.attempt.kind) {
    case HISTORY_SHOW_ATTEMPT_SELECTORS.ALL:
      return true;
    case HISTORY_SHOW_ATTEMPT_SELECTORS.NUMBER:
      return attempt.attemptIndex + 1 === selection.attempt.number;
    case HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST: {
      const latest = selection.index?.targets.get(
        historyAttemptTargetKey(attempt.target)
      )?.latest;
      return (
        latest !== undefined &&
        historyAttemptKey(latest) === historyAttemptKey(attempt)
      );
    }
  }
}

export async function showHistoryCommand(
  options: HistoryShowOptions,
  io: HistoryInspectionCommandIo,
  dependencies: HistoryInspectionCommandDependencies = {}
): Promise<void> {
  if ((options.summary || options.events) && !options.json) {
    throw new Error("history show: --summary and --events require --json");
  }
  if (options.summary && options.events) {
    throw new Error(
      "history show: --summary and --events are mutually exclusive"
    );
  }
  const pagingArgs = {
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.limit !== undefined
      ? { limit: parseHistoryInteger(options.limit, "--limit", 1, 1) }
      : {}),
    ...(options.tail !== undefined
      ? { tail: parseHistoryInteger(options.tail, "--tail", 0, 0) }
      : {}),
  };
  // Validates the paging flags themselves; how many attempts they select is
  // checked once the selection is resolved, still before any output.
  const paging = parseOutputTextPaging(
    pagingArgs,
    1,
    HISTORY_SHOW_PAGING_WORDING
  );
  const maxEvents =
    options.maxEvents === undefined
      ? undefined
      : parseHistoryInteger(options.maxEvents, "--max-events", 1, 1);
  const parsedAttempt = parseHistoryShowAttempt(options.attempt);
  const showKinds = parseHistorySearchValues(
    options.kind,
    Object.values(HISTORY_EVENT_KINDS),
    "--kind"
  );
  const pathNeedle = normalizeHistoryPathFilter(options.path);

  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options);
  const { workflowKey, runRef, runSummary } = await resolveHistoryRun(
    workspace,
    io,
    options.workflow,
    options.run
  );
  const workingDefinition = await readRunWorkingDefinition(
    workspace.workspaceRoot,
    workflowKey,
    runRef
  );
  const stepCount =
    workingDefinition?.steps.length ??
    runSummary.workingFileStepCount ??
    runSummary.stepCount;
  let targetFilter: CliHistoryShowStepSelector | undefined;
  try {
    targetFilter = parseHistoryShowStep(options.step);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ${formatValidStepIndexRange(stepCount)}`
    );
  }
  if (targetFilter?.kind === FINAL_STEP_PHASES.QUEUE) {
    for (const index of targetFilter.stepIndices) {
      assertStepIndex(stepCount, index, "--step");
    }
    if (paging) {
      // Several steps can never be one attempt; refuse before reading.
      parseOutputTextPaging(
        pagingArgs,
        targetFilter.stepIndices.length,
        HISTORY_SHOW_PAGING_WORDING
      );
    }
  } else if (
    targetFilter?.kind === FINAL_STEP_PHASES.FINAL_STEP &&
    runSummary.hasFinalStep === false
  ) {
    throw new Error(
      `Invalid --step value "${options.step}". This run has no final step; ${formatValidStepIndexRange(stepCount)}.`
    );
  }
  const manifestPath = WorkflowPaths.manifestPath(
    workspace.workspaceRoot,
    workflowKey,
    runRef
  );
  const resolver =
    dependencies.createRunOutputResolver?.() ?? new RunOutputResolver();

  // Paging reads one attempt; without an explicit --attempt it reads the
  // selected step's latest, so a retried step pages like a single one.
  const attemptFilter: CliHistoryShowAttemptSelector =
    paging && options.attempt === undefined
      ? { kind: HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST }
      : parsedAttempt;
  const needsAttemptIndex =
    paging !== undefined ||
    attemptFilter.kind !== HISTORY_SHOW_ATTEMPT_SELECTORS.ALL ||
    targetFilter?.kind === HISTORY_SHOW_STEP_SELECTORS.RUNNING ||
    targetFilter?.kind === HISTORY_SHOW_STEP_SELECTORS.LATEST ||
    (targetFilter?.kind === FINAL_STEP_PHASES.FINAL_STEP &&
      targetFilter.passNumber !== undefined);
  const index = needsAttemptIndex
    ? await collectHistoryAttemptIndex(resolver, manifestPath)
    : undefined;

  if (targetFilter?.kind === FINAL_STEP_PHASES.FINAL_STEP && index) {
    if (
      typeof targetFilter.passNumber === "number" &&
      targetFilter.passNumber > index.finalPassCount
    ) {
      throw new Error(
        `Invalid --step value "${options.step}"; valid final pass numbers are 1 to ${index.finalPassCount}`
      );
    }
    if (
      targetFilter.passNumber === HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST &&
      index.finalPassCount > 0
    ) {
      targetFilter = {
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        passNumber: index.finalPassCount,
      };
    }
  }
  const selection: HistoryShowSelection = {
    ...(targetFilter ? { target: targetFilter } : {}),
    attempt: attemptFilter,
    ...(index ? { index } : {}),
  };
  if (index) {
    validateHistoryShowSelection(options, selection, index, pagingArgs);
  }

  CliTerminalFormatter.setColorEnabled(options.color !== false);
  if (!options.json) io.writeErr(`Run: ${runRef}`);
  const matchedTargets = new Set<string>();
  const selectedTargets = new Set<string>();
  const renderedTargets = new Set<string>();
  let renderedAttempts = 0;
  for await (const event of resolver.streamAttempts(manifestPath)) {
    if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
      const attempt = event.attempt;
      if (!matchesHistoryShowTarget(attempt, selection)) continue;
      const targetKey = historyAttemptTargetKey(attempt.target);
      matchedTargets.add(targetKey);
      if (!matchesHistoryShowAttempt(attempt, selection)) continue;
      // A page is cut from the step attempt's own text, never from the
      // condition scripts recorded beside it.
      if (paging && !isHistoryStepAttempt(attempt)) continue;
      selectedTargets.add(targetKey);
      const projection = projectHistoryAttempt(attempt, showKinds, pathNeedle);
      if (!projection) continue;
      renderedTargets.add(targetKey);
      renderedAttempts++;
      const page = paging
        ? pageOutputText(
            buildHistoryPageText(projection, showKinds, pathNeedle),
            paging
          )
        : undefined;
      if (options.json) {
        writeHistoryAttemptJson(
          projection,
          event.unterminated,
          runRef,
          page,
          options,
          io
        );
      } else {
        renderHistoryAttempt(
          projection,
          event.unterminated,
          workingDefinition,
          page,
          maxEvents,
          io
        );
      }
      continue;
    }

    if (
      !targetFilter &&
      !options.json &&
      event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED
    ) {
      const isPaused = event.executionState === EXECUTION_STATES.PAUSED;
      CliTerminalFormatter.renderStatusMessage(
        isPaused ? "Run paused" : `Run terminated: ${event.executionState}`,
        historyExecutionStateSeverity(event.executionState)
      );
    }
  }

  const notices: Array<{ selector: string; step?: number; line: string }> = [];
  if (showKinds || pathNeedle !== undefined) {
    for (const targetKey of selectedTargets) {
      if (renderedTargets.has(targetKey)) continue;
      const selector = historySelectorForTargetKey(targetKey, index);
      notices.push({
        selector,
        line: `No events in --step ${selector} matched ${describeHistoryShowFilters(options)}`,
      });
    }
  }
  if (targetFilter?.kind === FINAL_STEP_PHASES.QUEUE) {
    for (const stepIndex of targetFilter.stepIndices) {
      if (matchedTargets.has(historyAttemptTargetKey(queueTarget(stepIndex))))
        continue;
      const selector = formatCliStepSelector(stepIndex);
      const state = historyWorkingStepState(
        workingDefinition?.steps[stepIndex]?._runtime
      );
      notices.push({
        selector,
        step: stepIndex,
        line:
          state === PROMPT_TERMINAL_STATUS.SKIPPED
            ? `--step ${selector} was skipped`
            : state === HISTORY_STEP_STATES.PENDING
              ? `--step ${selector} has not started (${HISTORY_STEP_STATES.PENDING})`
              : `--step ${selector} is ${state} but has no recorded attempt`,
      });
    }
  } else if (
    targetFilter?.kind === HISTORY_SHOW_STEP_SELECTORS.RUNNING &&
    renderedAttempts === 0 &&
    matchedTargets.size === 0
  ) {
    notices.push({
      selector: HISTORY_SHOW_STEP_SELECTORS.RUNNING,
      line: "No attempt is running in this run",
    });
  }
  for (const notice of notices) {
    if (options.json) {
      io.writeOut(
        JSON.stringify({
          runRef,
          selector: notice.selector,
          ...(notice.step !== undefined
            ? {
                step: notice.step,
                status: historyWorkingStepState(
                  workingDefinition?.steps[notice.step]?._runtime
                ),
              }
            : {}),
          message: notice.line,
        })
      );
    } else {
      CliTerminalFormatter.renderStatusMessage(
        notice.line,
        STATUS_MESSAGE_SEVERITY.INFO
      );
    }
  }
}

/**
 * Reject a selection that cannot be served, before anything is written: an
 * `--attempt` number a selected step never reached, and paging that would
 * cover more than one attempt.
 */
function validateHistoryShowSelection(
  options: HistoryShowOptions,
  selection: HistoryShowSelection,
  index: HistoryAttemptIndex,
  pagingArgs: Parameters<typeof parseOutputTextPaging>[0]
): void {
  const selectedTargets = [...index.targets.values()].filter((entry) =>
    selectedTargetMatches(entry, selection, index)
  );
  if (selection.attempt.kind === HISTORY_SHOW_ATTEMPT_SELECTORS.NUMBER) {
    const requested = selection.attempt.number;
    for (const entry of selectedTargets) {
      if (requested > entry.maxAttemptNumber) {
        throw new Error(
          `Invalid --attempt value "${options.attempt}" for --step ${formatHistoryTargetSelector(entry.target)}; valid attempts are 1 to ${entry.maxAttemptNumber}`
        );
      }
    }
  }
  if (
    pagingArgs.cursor === undefined &&
    pagingArgs.limit === undefined &&
    pagingArgs.tail === undefined
  ) {
    return;
  }
  const selectedAttempts = selectedTargets.reduce(
    (count, entry) =>
      count +
      (selection.attempt.kind === HISTORY_SHOW_ATTEMPT_SELECTORS.ALL
        ? entry.attempts
        : 1),
    0
  );
  // No attempt at all is reported as the step's state, not as a paging error.
  if (selectedAttempts > 1) {
    parseOutputTextPaging(
      pagingArgs,
      selectedAttempts,
      HISTORY_SHOW_PAGING_WORDING
    );
  }
}

/** Whether any of a target's step attempts can satisfy the `--step` selector. */
function selectedTargetMatches(
  entry: HistoryTargetAttempts,
  selection: HistoryShowSelection,
  index: HistoryAttemptIndex
): boolean {
  switch (selection.target?.kind) {
    case undefined:
    case FINAL_STEP_PHASES.QUEUE:
    case FINAL_STEP_PHASES.FINAL_STEP:
      return matchesHistoryShowTarget(entry.latest, selection);
    case HISTORY_SHOW_STEP_SELECTORS.LATEST:
      return (
        index.latest !== undefined &&
        historyAttemptTargetKey(index.latest.target) ===
          historyAttemptTargetKey(entry.target)
      );
    case HISTORY_SHOW_STEP_SELECTORS.RUNNING:
      return [...index.running].some((key) =>
        key.startsWith(`${historyAttemptTargetKey(entry.target)}:`)
      );
  }
}

function describeHistoryShowFilters(options: HistoryShowOptions): string {
  return [
    ...(options.kind?.length ? [`--kind ${options.kind.join(" ")}`] : []),
    ...(options.path !== undefined ? [`--path ${options.path}`] : []),
  ].join(" and ");
}

function historySelectorForTargetKey(
  targetKey: string,
  index: HistoryAttemptIndex | undefined
): string {
  const entry = index?.targets.get(targetKey);
  if (entry) return formatHistoryTargetSelector(entry.target);
  const [kind, value] = targetKey.split(":");
  const number = Number(value);
  return formatHistoryTargetSelector(
    kind === FINAL_STEP_PHASES.QUEUE
      ? queueTarget(number)
      : { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: number }
  );
}

function queueTarget(stepIndex: number): OutputExecutionTarget {
  return { kind: FINAL_STEP_PHASES.QUEUE, stepIndex };
}

/** One settled attempt narrowed by `--kind`/`--path`. */
interface HistoryAttemptProjection {
  attempt: ResolvedRunAttemptValue;
  /** Whether the attempt's prompt is part of the selected kinds. */
  includePrompt: boolean;
  /** Whether its response (or script output) is part of the selected kinds. */
  includeResponse: boolean;
}

/**
 * Apply `--kind` and `--path`. A script attempt's prompt and output are
 * classified by the same source map history search indexes them under, and
 * structured events by the same event-type map. Excluded text is removed
 * from every field that carries it, not just blanked in one of them.
 */
function projectHistoryAttempt(
  attempt: ResolvedRunAttemptValue,
  kinds: readonly string[] | undefined,
  pathNeedle: string | undefined
): HistoryAttemptProjection | undefined {
  if (!kinds && pathNeedle === undefined) {
    return { attempt, includePrompt: true, includeResponse: true };
  }
  const kindSet = kinds ? new Set<string>(kinds) : undefined;
  const source = historyScriptSource(attempt);
  const scriptKind = source ? SCRIPT_EVENT_KIND_BY_SOURCE[source] : undefined;
  const includePrompt =
    pathNeedle === undefined &&
    (!kindSet || kindSet.has(scriptKind ?? HISTORY_EVENT_KINDS.PROMPT));
  const includeResponse =
    pathNeedle === undefined &&
    (!kindSet || kindSet.has(scriptKind ?? HISTORY_EVENT_KINDS.RESPONSE));
  const matchingEvents = (attempt.output?.structured?.events ?? []).filter(
    (event) => {
      const eventKind = historyEventKindForCliEventType(event.type);
      if (!eventKind || (kindSet && !kindSet.has(eventKind))) return false;
      if (pathNeedle === undefined) return true;
      const eventPath = (event.data as { path?: unknown }).path;
      return historyPathMatches(
        typeof eventPath === "string" ? eventPath : undefined,
        pathNeedle
      );
    }
  );
  const hasPrompt = includePrompt && historyRecordedPrompt(attempt) !== "";
  const hasResponse =
    includeResponse && historyAttemptResponseText(attempt) !== "";
  if (!hasPrompt && !hasResponse && matchingEvents.length === 0) {
    return undefined;
  }
  const { prompt, responseText, output, scriptOutput, ...identity } = attempt;
  let projectedOutput: CliOutput | undefined;
  if (output) {
    projectedOutput = {
      ...output,
      // `response` is required on CliOutput, so an excluded one is emptied;
      // the include flags keep it out of every surface that emits it.
      response: includeResponse ? output.response : "",
      ...(output.structured
        ? { structured: { ...output.structured, events: matchingEvents } }
        : {}),
    };
    if (!includePrompt) delete projectedOutput.prompt;
  }
  return {
    includePrompt,
    includeResponse,
    attempt: {
      ...identity,
      ...(includePrompt && prompt !== undefined ? { prompt } : {}),
      ...(includeResponse && responseText !== undefined
        ? { responseText }
        : {}),
      ...(projectedOutput ? { output: projectedOutput } : {}),
      ...(scriptOutput
        ? {
            scriptOutput: includeResponse
              ? scriptOutput
              : { ...scriptOutput, stdout: "", stderr: "" },
          }
        : {}),
    },
  };
}

/**
 * The text a page is cut from. Without `--kind`/`--path` it is the attempt's
 * response (a script attempt's combined stdout and stderr). With them it is
 * every selected item in order, separated by blank lines: the prompt, the
 * response, then each matching structured event other than response text,
 * which the response already contains.
 */
function buildHistoryPageText(
  projection: HistoryAttemptProjection,
  kinds: readonly string[] | undefined,
  pathNeedle: string | undefined
): string {
  const { attempt } = projection;
  if (!kinds && pathNeedle === undefined) {
    return historyAttemptResponseText(attempt);
  }
  const parts: string[] = [];
  if (projection.includePrompt) parts.push(historyRecordedPrompt(attempt));
  if (projection.includeResponse) {
    parts.push(historyAttemptResponseText(attempt));
  }
  const extractor = new HistoryCandidateExtractor();
  for (const event of attempt.output?.structured?.events ?? []) {
    if (event.type === CLI_EVENT_TYPES.TEXT) continue;
    parts.push(
      extractor
        .collectStructuredEventsCandidates([event])
        .map((candidate) => candidate.text)
        .join("\n")
    );
  }
  return parts.filter((part) => part !== "").join("\n\n");
}

function writeHistoryAttemptJson(
  projection: HistoryAttemptProjection,
  unterminated: boolean,
  runRef: RunRef,
  page: PagedOutputText | undefined,
  options: HistoryShowOptions,
  io: HistoryInspectionCommandIo
): void {
  const { attempt } = projection;
  // Each text is emitted once: the top-level `prompt` and `responseText`
  // are authoritative, so their `output.prompt`/`output.response` copies go.
  const prompt =
    !page && projection.includePrompt
      ? historyRecordedPrompt(attempt) || undefined
      : undefined;
  const responseText = page
    ? page.text
    : projection.includeResponse
      ? (attempt.responseText ?? attempt.output?.response)
      : undefined;
  const nextCursor = page?.nextCursor;
  const write = (value: unknown) =>
    io.writeOut(JSON.stringify(secretRedactionService.redactValue(value)));

  if (options.events) {
    const events: CliEvent[] = page
      ? [{ type: CLI_EVENT_TYPES.TEXT, data: { text: page.text } }]
      : attempt.output?.structured?.events?.length
        ? attempt.output.structured.events
        : responseText
          ? [{ type: CLI_EVENT_TYPES.TEXT, data: { text: responseText } }]
          : [];
    for (const outputEvent of events) {
      write({
        target: attempt.target,
        runIndex: attempt.runIndex,
        attemptIndex: attempt.attemptIndex,
        event: outputEvent,
        ...(unterminated ? { unterminated: true } : {}),
        ...(nextCursor ? { nextCursor } : {}),
      });
    }
    return;
  }
  if (options.summary) {
    write({
      target: attempt.target,
      runIndex: attempt.runIndex,
      attemptIndex: attempt.attemptIndex,
      state: unterminated
        ? HISTORY_STEP_STATES.UNTERMINATED
        : (attempt.terminalState ?? HISTORY_STEP_STATES.UNKNOWN),
      timings: {
        ...(attempt.output?.elapsed !== undefined
          ? { elapsed: attempt.output.elapsed }
          : {}),
        ...(attempt.output?.timestampMs !== undefined
          ? { timestampMs: attempt.output.timestampMs }
          : {}),
      },
      ...(attempt.output?.tokens ? { tokens: attempt.output.tokens } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(responseText !== undefined ? { responseText } : {}),
      ...(nextCursor ? { nextCursor } : {}),
    });
    return;
  }
  const {
    definition,
    output,
    scriptOutput,
    prompt: _prompt,
    responseText: _responseText,
    ...attemptFields
  } = attempt;
  write({
    ...attemptFields,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(responseText !== undefined ? { responseText } : {}),
    ...(output
      ? {
          output: withoutOutputText(output, {
            prompt: true,
            response: true,
            structured: page !== undefined,
          }),
        }
      : {}),
    ...(scriptOutput
      ? {
          scriptOutput:
            page || !projection.includeResponse
              ? withoutScriptStreams(scriptOutput)
              : scriptOutput,
        }
      : {}),
    ...(definition
      ? {
          definitionRevision: definition.definitionRevision,
          definition: { step: definition.step },
        }
      : {}),
    runRef,
    unterminated,
    ...(nextCursor ? { nextCursor } : {}),
  });
}

function withoutOutputText(
  output: CliOutput,
  omit: { prompt?: boolean; response?: boolean; structured?: boolean }
): Partial<CliOutput> {
  const copy: Partial<CliOutput> = { ...output };
  if (omit.prompt) delete copy.prompt;
  if (omit.response) delete copy.response;
  if (omit.structured) delete copy.structured;
  return copy;
}

function withoutScriptStreams(
  scriptOutput: ScriptRuntimeOutput
): Partial<ScriptRuntimeOutput> {
  const copy: Partial<ScriptRuntimeOutput> = { ...scriptOutput };
  delete copy.stdout;
  delete copy.stderr;
  return copy;
}

interface HistoryStepRow {
  selector: string;
  index: number;
  name: string | null;
  state: string;
  harness: string | null;
  model: string | null;
  elapsedSeconds: number | null;
  attempts: number;
  prompt: string;
  next?: true;
}

interface HistoryFinalPassRow {
  selector: string;
  pass: number;
  state: string;
  attempts: number;
  startedAt: number | null;
  completedAt: number | null;
  elapsedSeconds: number | null;
}

interface HistoryFinalStepRow {
  selector: typeof HISTORY_SHOW_STEP_SELECTORS.FINAL;
  name: string | null;
  state: string;
  harness: string | null;
  model: string | null;
  elapsedSeconds: number | null;
  passes: HistoryFinalPassRow[];
  nextPass: number | null;
  prompt: string;
}

export async function stepsHistoryCommand(
  options: HistoryStepsOptions,
  io: HistoryInspectionCommandIo,
  dependencies: HistoryInspectionCommandDependencies = {}
): Promise<void> {
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options);
  const { workflowKey, runRef } = await resolveHistoryRun(
    workspace,
    io,
    options.workflow,
    options.run
  );
  const definition = await readRunWorkingDefinition(
    workspace.workspaceRoot,
    workflowKey,
    runRef
  );
  if (!definition) {
    throw new Error(`Run "${runRef}" has no readable workflow working file.`);
  }

  const resolver =
    dependencies.createRunOutputResolver?.() ?? new RunOutputResolver();
  const index = await collectHistoryAttemptIndex(
    resolver,
    WorkflowPaths.manifestPath(workspace.workspaceRoot, workflowKey, runRef)
  );
  const currentIndex = definition._runtime?.currentIndex;
  const isNonTerminalRun = !isTerminalExecutionState(
    definition._runtime?.executionState
  );
  const steps: HistoryStepRow[] = definition.steps.map((step, stepIndex) => {
    const isNext =
      isNonTerminalRun && currentIndex === stepIndex;
    return {
      selector: formatCliStepSelector(stepIndex),
      index: stepIndex,
      name: step.name?.trim() || null,
      state: historyWorkingStepState(step._runtime),
      harness: step._runtime?.harness ?? null,
      model: step._runtime?.model ?? null,
      elapsedSeconds: historyElapsedSeconds(step._runtime?.elapsed),
      attempts:
        index.targets.get(historyAttemptTargetKey(queueTarget(stepIndex)))
          ?.attempts ?? 0,
      prompt: formatStepPrompt(step, options.fullPrompts === true),
      ...(isNext ? { next: true as const } : {}),
    };
  });
  const passes = historyFinalPassRows(index);
  const nextPass =
    definition.finalStep &&
    isNonTerminalRun &&
    currentIndex !== undefined &&
    currentIndex >= definition.steps.length &&
    passes[passes.length - 1]?.state !== EXECUTION_STATES.RUNNING
      ? passes.length + 1
      : null;
  const finalStepState =
    nextPass === null ? undefined : HISTORY_STEP_STATES.PENDING;
  const finalStep: HistoryFinalStepRow | null = definition.finalStep
    ? {
        selector: HISTORY_SHOW_STEP_SELECTORS.FINAL,
        name: definition.finalStep.name?.trim() || null,
        state:
          finalStepState ??
          historyWorkingStepState(definition.finalStep._runtime),
        harness: definition.finalStep._runtime?.harness ?? null,
        model: definition.finalStep._runtime?.model ?? null,
        elapsedSeconds: historyFinishedPassElapsedSeconds(passes),
        passes,
        nextPass,
        prompt: formatStepPrompt(
          definition.finalStep,
          options.fullPrompts === true
        ),
      }
    : null;

  if (options.json) {
    io.writeOut(
      JSON.stringify(
        secretRedactionService.redactValue({ runRef, steps, finalStep })
      )
    );
    return;
  }
  io.writeErr(`Run: ${runRef}`);
  const headers = [
    "#",
    "NAME",
    "STATE",
    "HARNESS",
    "MODEL",
    "ELAPSED",
    "ATTEMPTS",
    "PROMPT",
  ];
  const values = steps.map((step) => [
    step.selector,
    step.name ?? "—",
    step.next ? `${step.state} (next)` : step.state,
    step.harness ?? "—",
    step.model ?? "—",
    formatElapsed(step.elapsedSeconds),
    String(step.attempts),
    step.prompt,
  ]);
  if (finalStep) {
    values.push([
      finalStep.selector,
      finalStep.name ?? "—",
      finalStep.nextPass === null
        ? finalStep.state
        : `${finalStep.state} (${formatFinalPassBadge(finalStep.nextPass)} next)`,
      finalStep.harness ?? "—",
      finalStep.model ?? "—",
      formatElapsed(finalStep.elapsedSeconds),
      finalStep.nextPass === null
        ? `${finalStep.passes.length} pass${finalStep.passes.length === 1 ? "" : "es"}`
        : `${finalStep.passes.length} pass${finalStep.passes.length === 1 ? "" : "es"}, ${finalStep.nextPass} next`,
      finalStep.prompt,
    ]);
  }
  // The prompt column is last and unbounded with --full-prompts, so it is
  // never padded; every other column is aligned.
  const widths = headers.map((header, column) =>
    column === headers.length - 1
      ? 0
      : Math.max(header.length, ...values.map((value) => value[column].length))
  );
  io.writeOut(formatTableRow(headers, widths));
  for (const value of values) {
    io.writeOut(formatTableRow(value, widths));
  }
}

function historyFinalPassRows(
  index: HistoryAttemptIndex
): HistoryFinalPassRow[] {
  const passes: HistoryFinalPassRow[] = [];
  for (const entry of index.targets.values()) {
    if (entry.target.kind !== FINAL_STEP_PHASES.FINAL_STEP) continue;
    const pass = entry.target.loopIndex + 1;
    const running = index.running.has(historyAttemptKey(entry.latest));
    const completedAt = running ? null : (entry.latestTerminatedAt ?? null);
    passes.push({
      selector: formatFinalPassSelector(pass),
      pass,
      state: running
        ? EXECUTION_STATES.RUNNING
        : (entry.latestTerminalState ?? HISTORY_STEP_STATES.UNKNOWN),
      attempts: entry.attempts,
      startedAt: entry.firstStartedAt,
      completedAt,
      elapsedSeconds:
        completedAt === null
          ? null
          : Math.max(0, (completedAt - entry.firstStartedAt) / 1000),
    });
  }
  return passes.sort((a, b) => a.pass - b.pass);
}

function historyFinishedPassElapsedSeconds(
  passes: readonly HistoryFinalPassRow[]
): number | null {
  const finishedPasses = passes.filter((pass) => pass.completedAt !== null);
  return finishedPasses.length === 0
    ? null
    : finishedPasses.reduce(
        (total, pass) => total + (pass.elapsedSeconds ?? 0),
        0
      );
}

const HISTORY_SEARCH_DEFAULT_LIMIT = 20;
const HISTORY_SEARCH_MAX_LIMIT = 100;
const HISTORY_SEARCH_DEFAULT_SNIPPET_CHARS = 100;
const HISTORY_SEARCH_MIN_QUERY_LENGTH = 2;
export const CLI_HISTORY_SEARCH_JSON_SCHEMA_VERSION = 1 as const;

export async function searchHistoryCommand(
  query: string,
  options: HistorySearchCommandOptions,
  io: HistoryInspectionCommandIo,
  dependencies: HistoryInspectionCommandDependencies = {}
): Promise<void> {
  CliTerminalFormatter.setColorEnabled(options.color !== false);
  const snippetChars = requestSnippetChars(options);
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options, { runs: { historySearchCacheMb: 0 } });
  const workflowKeys = await Promise.all(
    (options.workflow ?? []).map((workflow) =>
      resolveCliWorkflowKey(
        workspace.workspaceRoot,
        workspace.createLineageRepository(),
        workflow,
        (message) => io.writeErr(message)
      )
    )
  );
  const request = buildHistorySearchQuery(query, options, workflowKeys);
  const service =
    dependencies.createHistorySearchService?.() ?? new HistorySearchService();
  const progress = createHistorySearchProgressReporter(io);
  let response: HistorySearchResponse;
  let outcome: HistorySearchProgressOutcome =
    HISTORY_SEARCH_PROGRESS_OUTCOMES.FAILED;
  try {
    response = await service.search(
      request,
      workspace.workspaceRoot,
      progress.onProgress,
      undefined,
      undefined,
      {
        allowRebuild: options.rebuild !== false,
        allowLegacyFallback: options.fallback !== false,
        snippetChars,
      }
    );
    // The service answers a failed index path with a disk scan instead of
    // throwing, so returning normally does not prove the rebuild completed.
    outcome =
      response.indexState === HISTORY_SEARCH_INDEX_STATES.FALLBACK
        ? HISTORY_SEARCH_PROGRESS_OUTCOMES.FALLBACK
        : HISTORY_SEARCH_PROGRESS_OUTCOMES.COMPLETED;
  } finally {
    progress.finish(outcome);
  }

  if (options.json) {
    renderHistorySearchJson(request, response, io);
    return;
  }
  renderHistorySearchText(request, response, io);
}

const HISTORY_SEARCH_PROGRESS_INTERVAL_MS = 250;

const HISTORY_SEARCH_PROGRESS_OUTCOMES = {
  COMPLETED: "completed",
  FALLBACK: "fallback",
  FAILED: "failed",
} as const;

type HistorySearchProgressOutcome =
  (typeof HISTORY_SEARCH_PROGRESS_OUTCOMES)[keyof typeof HISTORY_SEARCH_PROGRESS_OUTCOMES];

const HISTORY_SEARCH_REBUILD_FALLBACK_MESSAGE =
  "Search index rebuild failed; used a disk scan.";

function createHistorySearchProgressReporter(io: HistoryInspectionCommandIo): {
  onProgress: IndexRebuildProgressCallback;
  finish(outcome: HistorySearchProgressOutcome): void;
} {
  let startedAt: number | undefined;
  let lastRenderedAt = Number.NEGATIVE_INFINITY;
  let latestMessage: string | undefined;
  let renderedMessage: string | undefined;
  let nonTtyStarted = false;

  return {
    onProgress: (processedRuns, totalRuns) => {
      const now = Date.now();
      startedAt ??= now;
      latestMessage = `Rebuilding search index (${processedRuns}/${totalRuns} runs)…`;

      if (!io.isErrTty) {
        if (!nonTtyStarted) {
          io.writeErr(`Rebuilding search index (${totalRuns} runs)…`);
          nonTtyStarted = true;
        }
        return;
      }

      if (now - lastRenderedAt < HISTORY_SEARCH_PROGRESS_INTERVAL_MS) {
        return;
      }
      io.writeErrProgress(`\r\x1b[K${latestMessage}`);
      renderedMessage = latestMessage;
      lastRenderedAt = now;
    },
    finish: (outcome) => {
      if (startedAt === undefined || latestMessage === undefined) {
        return;
      }

      if (io.isErrTty) {
        if (latestMessage !== renderedMessage) {
          io.writeErrProgress(`\r\x1b[K${latestMessage}`);
        }
        io.writeErrProgress("\n");
      } else if (outcome === HISTORY_SEARCH_PROGRESS_OUTCOMES.COMPLETED) {
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        io.writeErr(`Search index rebuild completed in ${elapsedMs} ms.`);
      }
      if (outcome === HISTORY_SEARCH_PROGRESS_OUTCOMES.FALLBACK) {
        io.writeErr(HISTORY_SEARCH_REBUILD_FALLBACK_MESSAGE);
      }
    },
  };
}

function buildHistorySearchQuery(
  query: string,
  options: HistorySearchCommandOptions,
  resolvedWorkflowKeys: WorkflowKey[]
): HistorySearchQuery {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < HISTORY_SEARCH_MIN_QUERY_LENGTH) {
    throw new Error(
      `History search queries must contain at least ${HISTORY_SEARCH_MIN_QUERY_LENGTH} characters.`
    );
  }

  const workflowKeys = [...resolvedWorkflowKeys];
  if (options.thisWorkflow) {
    const workingFile = process.env[CTRLYOKE_ENV_VARS.WORKING_FILE];
    if (!workingFile) {
      throw new Error(
        `--this-workflow requires ${CTRLYOKE_ENV_VARS.WORKING_FILE} to be set.`
      );
    }
    const address = WorkflowPaths.parseWorkingFileAddressFromPath(workingFile);
    if (!address) {
      throw new Error(
        `${CTRLYOKE_ENV_VARS.WORKING_FILE} does not identify a ctrlyoke workflow file: ${workingFile}`
      );
    }
    if (!workflowKeys.includes(address.workflowKey)) {
      workflowKeys.push(address.workflowKey);
    }
  }

  const eventKinds = parseHistorySearchValues(
    options.kind,
    Object.values(HISTORY_EVENT_KINDS),
    "--kind"
  );
  const harnesses = parseHistorySearchValues(
    options.harness,
    Object.values(HARNESS_IDS),
    "--harness"
  );
  const executionStates = parseHistoryStateFilter(options.state);
  const now = Date.now();
  const since = parseHistorySince(options.since);
  const until = options.until
    ? parseHistoryTime(options.until, now, "end")
    : undefined;

  return {
    query: normalizedQuery,
    limit: parseHistorySearchLimit(options.limit),
    offset: parseHistorySearchInteger(options.offset, "--offset", 0, 0),
    deep: options.deep === true,
    regex: options.regex === true,
    exhaustive: options.exactCount === true,
    filters: {
      ...(eventKinds ? { eventKinds: eventKinds as HistoryEventKind[] } : {}),
      ...(workflowKeys.length
        ? { workflowKeys: workflowKeys as WorkflowKey[] }
        : {}),
      ...(harnesses ? { harnesses } : {}),
      ...(executionStates ? { executionStates } : {}),
      ...(options.path !== undefined ? { pathContains: options.path } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    },
  };
}

function parseHistorySearchValues<T extends string>(
  values: string[] | undefined,
  allowed: readonly T[],
  optionName: string
): T[] | undefined {
  if (!values) {
    return undefined;
  }
  const allowedSet = new Set<string>(allowed);
  const invalid = values.find((value) => !allowedSet.has(value));
  if (invalid !== undefined) {
    throw new Error(
      `Invalid ${optionName} value "${invalid}". Valid values: ${allowed.join(", ")}`
    );
  }
  return values.filter((value): value is T => allowedSet.has(value));
}

function parseHistorySearchLimit(value: string | undefined): number {
  const parsed = parseHistorySearchInteger(
    value,
    "--limit",
    1,
    HISTORY_SEARCH_DEFAULT_LIMIT
  );
  return Math.min(parsed, HISTORY_SEARCH_MAX_LIMIT);
}

/**
 * `whenMissing` is an explicit parameter rather than a lookup keyed on
 * `optionName`, which is a display string: coupling a flag's default to the
 * spelling of its own help text makes renaming the flag silently change what
 * omitting it means.
 */
function parseHistorySearchInteger(
  value: string | undefined,
  optionName: string,
  minimum: number,
  whenMissing: number
): number {
  return parseHistoryInteger(value, optionName, minimum, whenMissing);
}

function requestSnippetChars(options: HistorySearchCommandOptions): number {
  return parseHistorySearchInteger(
    options.snippet,
    "--snippet",
    0,
    HISTORY_SEARCH_DEFAULT_SNIPPET_CHARS
  );
}

function renderHistorySearchJson(
  request: HistorySearchQuery,
  response: HistorySearchResponse,
  io: HistoryInspectionCommandIo
): void {
  io.writeOut(
    JSON.stringify(
      secretRedactionService.redactValue({
        schemaVersion: CLI_HISTORY_SEARCH_JSON_SCHEMA_VERSION,
        query: response.query,
        offset: response.offset,
        limit: request.limit,
        deep: request.deep === true,
        regex: request.regex === true,
        totalCount: response.totalCount,
        countState: response.countState,
        hasMore: response.hasMore,
        indexState: response.indexState,
        results: response.results,
      })
    )
  );
}

function renderHistorySearchText(
  request: HistorySearchQuery,
  response: HistorySearchResponse,
  io: HistoryInspectionCommandIo
): void {
  const total =
    response.countState === HISTORY_SEARCH_COUNT_STATES.EXACT
      ? String(response.totalCount)
      : `${response.totalCount}+`;
  const mode = request.deep === true ? "deep" : "shallow";
  io.writeOut(
    `${response.results.length} of ${total} results · index ${response.indexState} · ${mode}`
  );

  response.results.forEach((result, index) => {
    io.writeOut(formatHistorySearchResult(result, index));
  });

  io.writeOut(
    "Each result is one matching event or field, not one occurrence."
  );
  if (response.countState === HISTORY_SEARCH_COUNT_STATES.EXACT) {
    io.writeOut("This total is exact.");
  } else {
    io.writeOut(
      "This total is a lower bound because the scan stopped after the requested page; use --exact-count for a real total."
    );
  }
  if (request.deep !== true) {
    io.writeOut(
      "This was a shallow search: indexed text is capped at 2000 characters, so use --deep for terms later in long output."
    );
  } else {
    io.writeOut(
      "This was a deep search over matching runs beyond the indexed text cap."
    );
  }
  io.writeOut(
    request.regex === true
      ? "This was a case-insensitive regex search; it may be slower than substring search because the prefilter can only use an extracted literal."
      : "This was a case-insensitive substring search."
  );
  io.writeOut(
    "For an exhaustive read of a known run, use history show with its selector."
  );
}

function formatHistorySearchResult(
  result: HistorySearchResult,
  index: number
): string {
  const step = formatHistoryTargetSelector(result.target);
  const lines = [
    `${index + 1}. ${result.workflowName} · run ${result.runId} · ${result.matchContext} · ${result.eventKind}/${result.matchField} · ${formatDate(result.startedAt)}`,
    `   --workflow ${result.workflowKey} --run ${result.runRef} --step ${step}`,
  ];
  if (result.filePath) {
    lines.push(`   ${result.filePath}`);
  }
  lines.push(`   ${result.matchSnippet.replace(/\s+/g, " ").trim()}`);
  return lines.join("\n");
}

function historyAttemptTargetKey(target: OutputExecutionTarget): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? `${FINAL_STEP_PHASES.QUEUE}:${target.stepIndex}`
    : `${FINAL_STEP_PHASES.FINAL_STEP}:${target.loopIndex}`;
}

function historyAttemptKey(attempt: HistoryAttemptIdentity): string {
  return `${historyAttemptTargetKey(attempt.target)}:run:${attempt.runIndex}:attempt:${attempt.attemptIndex}`;
}

function isLaterHistoryAttempt(
  candidate: HistoryAttemptIdentity,
  current: HistoryAttemptIdentity
): boolean {
  return (
    candidate.runIndex > current.runIndex ||
    (candidate.runIndex === current.runIndex &&
      candidate.attemptIndex > current.attemptIndex)
  );
}

function renderHistoryAttempt(
  projection: HistoryAttemptProjection,
  unterminated: boolean,
  workingDefinition: RunWorkingDefinition | undefined,
  page: PagedOutputText | undefined,
  maxEvents: number | undefined,
  io: HistoryInspectionCommandIo
): void {
  const { attempt } = projection;
  const target = createHistoryOutputTarget(attempt);
  if (attempt.target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
    CliTerminalFormatter.renderFinalStepLabel(attempt.target.loopIndex);
  }
  CliTerminalFormatter.renderPromptHeader({
    stepIndex: target.stepIndex,
    totalSteps: workingDefinition?.steps.length ?? target.stepIndex + 1,
    stepName: historyStepName(attempt, workingDefinition),
    // A page is bounded by its own size, so it carries no prompt preview.
    promptText:
      !page && projection.includePrompt ? historyAttemptPrompt(attempt) : "",
    attemptIndex: attempt.attemptIndex,
    runIndex: attempt.runIndex,
    stepSelector: formatHistoryTargetSelector(attempt.target),
    includeStepPosition: attempt.target.kind === FINAL_STEP_PHASES.QUEUE,
  });

  let omittedEvents = 0;
  let totalEvents = 0;
  const output = attempt.output;
  if (page) {
    CliTerminalFormatter.renderStreamingChunk(page.text, target);
  } else if (isHistoryScriptAttempt(attempt)) {
    if (projection.includeResponse) {
      CliTerminalFormatter.renderScriptOutput(
        historyScriptOutput(attempt),
        target
      );
    }
  } else if (output?.structured?.events?.length) {
    const events = output.structured.events;
    totalEvents = events.length;
    omittedEvents =
      maxEvents === undefined ? 0 : Math.max(0, events.length - maxEvents);
    CliTerminalFormatter.renderEvents(
      omittedEvents > 0 ? events.slice(0, maxEvents) : events,
      target
    );
  } else if (projection.includeResponse && output?.response) {
    CliTerminalFormatter.renderStreamingChunk(output.response, target);
  }

  if (unterminated) {
    CliTerminalFormatter.renderStatusMessage(
      "Attempt did not terminate before the recorded history ended",
      STATUS_MESSAGE_SEVERITY.WARNING
    );
  } else if (attempt.terminalState) {
    CliTerminalFormatter.renderStatusMessage(
      `Attempt ${attempt.terminalState}${attempt.terminalReason ? `: ${attempt.terminalReason}` : ""}`,
      attemptTerminalStateSeverity(attempt.terminalState)
    );
  } else {
    CliTerminalFormatter.flushStreamingBuffer(target);
  }
  if (page?.nextCursor) {
    io.writeOut(`… more output (use --cursor ${page.nextCursor})`);
  }
  if (omittedEvents > 0) {
    // --cursor pages characters, not events, so the way to see the rest of
    // the events is a larger event budget.
    io.writeOut(
      `… ${omittedEvents} more events (use --max-events ${totalEvents} to show all)`
    );
  }
}

function createHistoryOutputTarget(attempt: ResolvedRunAttemptValue): {
  stepIndex: number;
  stepName: string;
  key: string;
} {
  return {
    stepIndex:
      attempt.target.kind === FINAL_STEP_PHASES.QUEUE
        ? attempt.target.stepIndex
        : attempt.target.loopIndex,
    stepName: historyStepName(attempt),
    key:
      attempt.target.kind === FINAL_STEP_PHASES.QUEUE
        ? `queue:${attempt.target.stepIndex}`
        : `final:${attempt.target.loopIndex}`,
  };
}

function historyStepName(
  attempt: ResolvedRunAttemptValue,
  workingDefinition?: RunWorkingDefinition
): string {
  const step = attempt.definition?.step;
  if (step?.name?.trim()) return step.name.trim();
  if (attempt.target.kind === FINAL_STEP_PHASES.QUEUE) {
    const workingName =
      workingDefinition?.steps[attempt.target.stepIndex]?.name;
    if (workingName?.trim()) return workingName.trim();
  }
  if (step && isScriptStep(step)) {
    return step.script.split(/\s+/)[0] ?? "script";
  }
  return attempt.target.kind === FINAL_STEP_PHASES.QUEUE
    ? `Step ${attempt.target.stepIndex + 1}`
    : formatFinalPassLabel(attempt.target.loopIndex + 1);
}

/** The prompt shown in a rendered header, falling back to the step's definition. */
function historyAttemptPrompt(attempt: ResolvedRunAttemptValue): string {
  const recorded = historyRecordedPrompt(attempt);
  if (recorded) return recorded;
  const step = attempt.definition?.step;
  if (!step) return "";
  return isScriptStep(step) ? step.script : step.prompt;
}

/** The prompt actually recorded for the attempt. */
function historyRecordedPrompt(attempt: ResolvedRunAttemptValue): string {
  return attempt.prompt ?? attempt.output?.prompt ?? "";
}

/** The attempt's response: a script attempt's stdout and stderr, else its response text. */
function historyAttemptResponseText(attempt: ResolvedRunAttemptValue): string {
  const scriptOutput = attempt.scriptOutput;
  if (scriptOutput) {
    return [scriptOutput.stdout, scriptOutput.stderr]
      .filter(Boolean)
      .join("\n");
  }
  return attempt.responseText ?? attempt.output?.response ?? "";
}

/** Which script produced an attempt, or undefined for an AI attempt. */
function historyScriptSource(
  attempt: ResolvedRunAttemptValue
): ScriptOutputSource | undefined {
  if (attempt.output?.source) return attempt.output.source;
  switch (attempt.kind) {
    case TIMELINE_ATTEMPT_KINDS.CONDITION:
      return attempt.phase === EXECUTION_PHASES.PRE_CONDITION
        ? SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
        : SCRIPT_OUTPUT_SOURCES.END_CONDITION;
    case TIMELINE_ATTEMPT_KINDS.SETUP:
      return SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP;
    case TIMELINE_ATTEMPT_KINDS.SCRIPT:
      return SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP;
    default:
      return attempt.scriptOutput
        ? SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP
        : undefined;
  }
}

function isHistoryScriptAttempt(attempt: ResolvedRunAttemptValue): boolean {
  return historyScriptSource(attempt) !== undefined;
}

/** Whether a settled attempt is the step's own execution, not a condition or setup script. */
function isHistoryStepAttempt(attempt: ResolvedRunAttemptValue): boolean {
  return attempt.kind === undefined || isStepAttemptKind(attempt.kind);
}

function historyScriptOutput(attempt: ResolvedRunAttemptValue): CliOutput {
  const output = attempt.output;
  const scriptOutput = attempt.scriptOutput;
  return {
    ...(output ?? {}),
    response: historyAttemptResponseText(attempt),
    elapsed: output?.elapsed ?? 0,
    isStreaming: false,
    source: historyScriptSource(attempt) ?? SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP,
    ...(scriptOutput
      ? {
          cliCommand: scriptOutput.command,
          exitCode: scriptOutput.exitCode,
        }
      : {}),
  };
}

function attemptTerminalStateSeverity(
  state: TimelineAttemptTerminalState
): string {
  return state === TIMELINE_ATTEMPT_TERMINAL_STATES.FAILED
    ? STATUS_MESSAGE_SEVERITY.ERROR
    : state === TIMELINE_ATTEMPT_TERMINAL_STATES.CANCELLED ||
        state === TIMELINE_ATTEMPT_TERMINAL_STATES.STOPPED
      ? STATUS_MESSAGE_SEVERITY.WARNING
      : STATUS_MESSAGE_SEVERITY.INFO;
}

function historyExecutionStateSeverity(state: string): string {
  return state === EXECUTION_STATES.ERROR
    ? STATUS_MESSAGE_SEVERITY.ERROR
    : state === EXECUTION_STATES.STOPPED ||
        state === EXECUTION_STATES.CANCELLING
      ? STATUS_MESSAGE_SEVERITY.WARNING
      : STATUS_MESSAGE_SEVERITY.INFO;
}

async function buildHistoryListRows(
  workspaceRoot: string,
  options: HistoryListOptions,
  lineageRepository: HistoryInspectionLineageRepository,
  historyManager: HistoryInspectionOutputHistoryManager
): Promise<HistoryListRow[]> {
  const keys = await lineageRepository.listLineageKeys(workspaceRoot);
  const rows = await Promise.all(
    keys.map(async (workflowKey): Promise<HistoryListRow | undefined> => {
      const descriptor = await lineageRepository.tryReadDescriptor(
        workspaceRoot,
        workflowKey
      );
      if (descriptor?.isSystemGenerated && !options.all) {
        return undefined;
      }

      const [workflowName, navigation] = await Promise.all([
        lineageRepository.readWorkflowDisplayName(workspaceRoot, workflowKey),
        historyManager.getRunNavigationSummary(workflowKey),
      ]);
      const lastModifiedAt = descriptor
        ? await getLineageLastModifiedAt(
            workspaceRoot,
            workflowKey,
            descriptor.lastModifiedAt
          )
        : null;
      return createHistoryListRow(
        workflowKey,
        descriptor,
        workflowName,
        navigation,
        lastModifiedAt
      );
    })
  );
  return rows.filter((row): row is HistoryListRow => row !== undefined);
}

function createHistoryListRow(
  workflowKey: WorkflowKey,
  descriptor: WorkflowLineageDescriptor | undefined,
  workflowName: string,
  navigation: RunNavigationSummary,
  lastModifiedAt: number | null
): HistoryListRow {
  const latestRun =
    navigation.primaryRunId !== undefined &&
    navigation.primaryRunRef !== undefined &&
    navigation.startedAt !== undefined &&
    navigation.executionState !== undefined
      ? {
          runId: navigation.primaryRunId,
          runRef: navigation.primaryRunRef,
          executionState: navigation.executionState,
          startedAt: navigation.startedAt,
          completedAt: navigation.completedAt ?? null,
        }
      : null;
  return {
    workflowKey,
    workflowName,
    isFavorite: descriptor?.isFavorite ?? false,
    createdAt: descriptor?.createdAt ?? null,
    lastModifiedAt,
    runCount: navigation.runCount,
    latestRun,
  };
}

function renderHistoryList(
  rows: readonly HistoryListRow[],
  io: HistoryInspectionCommandIo
): void {
  const headers = ["KEY", "NAME", "RUNS", "LATEST", "STATE"];
  const values = rows.map((row) => [
    row.workflowKey,
    truncateText(row.workflowName, 47),
    String(row.runCount),
    formatDate(row.latestRun?.startedAt),
    row.latestRun?.executionState ?? "—",
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((value) => value[index].length))
  );
  io.writeOut(formatTableRow(headers, widths));
  for (const value of values) {
    io.writeOut(formatTableRow(value, widths));
  }
}

function renderRunSummaries(
  summaries: readonly RunSummary[],
  io: HistoryInspectionCommandIo
): void {
  const headers = [
    "RUN",
    "REF",
    "STARTED",
    "STATE",
    "STEPS",
    "HARNESS",
    "TOKENS",
  ];
  const values = summaries.map((summary) => [
    String(summary.runId),
    summary.runRef,
    formatDate(summary.startedAt),
    summary.executionState,
    String(summary.workingFileStepCount ?? summary.stepCount),
    summary.hasMixedHarnesses ? "mixed" : (summary.primaryHarness ?? "—"),
    formatTokens(summary.tokenTotals?.total),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((value) => value[index].length))
  );
  io.writeOut(formatTableRow(headers, widths));
  for (const value of values) {
    io.writeOut(formatTableRow(value, widths));
  }
}

function formatTableRow(
  values: readonly string[],
  widths: readonly number[]
): string {
  return values
    .map((value, index) => value.padEnd(widths[index]))
    .join("  ")
    .trimEnd();
}

function formatDate(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined) {
    return "—";
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toISOString().slice(0, 16).replace("T", " ");
}

function formatTokens(tokens: number | undefined): string {
  return tokens === undefined ? "—" : tokens.toLocaleString("en-US");
}

interface RunWorkingDefinition {
  _runtime?: {
    currentIndex?: number;
    executionState?: string;
  };
  steps: Array<{
    name?: string;
    prompt?: string;
    script?: string;
    _runtime?: {
      harness?: string;
      model?: string;
      startedAt?: number;
      completedAt?: number;
      elapsed?: number;
      terminalStatus?: string;
    };
  }>;
  finalStep?: RunWorkingDefinition["steps"][number];
}

async function readRunWorkingDefinition(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef
): Promise<RunWorkingDefinition | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(
        WorkflowPaths.runFilePath(workspaceRoot, workflowKey, runRef),
        "utf8"
      )
    );
    if (!raw || typeof raw !== "object") return undefined;
    const candidate = raw as Partial<RunWorkingDefinition>;
    return Array.isArray(candidate.steps)
      ? (candidate as RunWorkingDefinition)
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function formatStepPrompt(
  step: NonNullable<RunWorkingDefinition["finalStep"]>,
  full: boolean
): string {
  const prompt = step.prompt ?? step.script ?? "";
  if (full) return prompt;
  return promptFirstLinePreview(
    prompt,
    STEP_LISTING_PROMPT_PREVIEW_MAX_CHARS
  );
}

/** A working file's `_runtime.elapsed` (seconds), or null when absent or invalid. */
function historyElapsedSeconds(elapsed: number | undefined): number | null {
  return elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0
    ? null
    : elapsed;
}

function formatElapsed(elapsedSeconds: number | null): string {
  if (elapsedSeconds === null) return "—";
  const seconds = Math.round(elapsedSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
}

function historyWorkingStepState(
  runtime: RunWorkingDefinition["steps"][number]["_runtime"]
): string {
  return (
    runtime?.terminalStatus ??
    // A final step's runtime can carry completedAt without startedAt.
    (runtime?.completedAt !== undefined
      ? EXECUTION_STATES.COMPLETED
      : runtime?.startedAt !== undefined
        ? EXECUTION_STATES.RUNNING
        : HISTORY_STEP_STATES.PENDING)
  );
}
