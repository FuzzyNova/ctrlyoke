import type { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
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
  createWorkflowLineageNotFoundError,
  resolveCliRunRef,
  matchesHistoryShowStep,
  parseHistoryShowAttempt,
  parseHistoryShowStep,
  formatCliStepSelector,
  type CliHistoryShowStepSelector,
} from "./CliRunSelector";
import { CliTerminalFormatter } from "./CliTerminalFormatter";
import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../types/CtrlYokeTypes";
import { isScriptStep } from "../types/CtrlYokeTypes";
import type { RunSummary } from "../types/WorkflowTimelineTypes";
import {
  EXECUTION_STATES,
  CLI_EVENT_TYPES,
  CTRLYOKE_ENV_VARS,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  HISTORY_EVENT_KINDS,
  HISTORY_SEARCH_COUNT_STATES,
  HISTORY_STEP_STATES,
  HISTORY_SHOW_STEP_SELECTORS,
  HISTORY_SHOW_ATTEMPT_SELECTORS,
  PROMPT_TERMINAL_STATUS,
  RUN_OUTPUT_RESOLVER_EVENT_KINDS,
  STATUS_MESSAGE_SEVERITY,
} from "../types/DashboardConstants";
import type { OutputExecutionTarget } from "../types/OutputHistoryTypes";
import type {
  HistoryEventKind,
  HistorySearchQuery,
  HistorySearchResponse,
  HistorySearchResult,
} from "../types/WorkflowTimelineTypes";
import {
  type RunOutputResolverAttemptEvent,
  type ResolvedRunAttemptValue,
  RunOutputResolver,
} from "../core/orchestration/RunOutputResolver";
import {
  pageOutputText,
  parseOutputTextPaging,
} from "../core/orchestration/OutputTextPaging";
import type { RunAttemptLifecycleEvent } from "../core/orchestration/RunOutputResolver";
import {
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_ATTEMPT_TERMINAL_STATES,
  TIMELINE_EVENT_TYPES,
  type TimelineAttemptTerminalState,
} from "../types/WorkflowTimelineTypes";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { getLineageLastModifiedAt } from "../utils/WorkingFileMetadata";
import type { CliOutput } from "../types/WebviewMessageTypes";
import { SCRIPT_OUTPUT_SOURCES } from "../types/DashboardConstants";
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
import type { PartialCtrlYokeSettings } from "../types/CtrlYokeSettings";
import { parseHistoryTime } from "./HistoryTime";
import {
  parseHistoryInteger,
  parseHistorySince,
  parseHistoryStateFilter,
} from "./HistoryFilterParsing";

export interface HistoryInspectionCommandIo {
  writeOut(message: string): void;
  writeErr(message: string): void;
  writeErrProgress(message: string): void;
  isErrTty: boolean;
}

export interface HistoryInspectionLineageRepository extends Pick<
  WorkflowLineageRepository,
  "listLineageKeys" | "tryReadDescriptor" | "readWorkflowDisplayName"
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

export async function listHistoryCommand(
  options: HistoryListOptions,
  io: HistoryInspectionCommandIo,
  dependencies: HistoryInspectionCommandDependencies = {}
): Promise<void> {
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
  const states = parseHistoryStateFilter(options.state);
  const since = parseHistorySince(options.since);
  const limit = parseHistoryInteger(
    options.limit,
    "--limit",
    1,
    Number.MAX_SAFE_INTEGER
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
    .slice(0, limit);

  if (options.json) {
    io.writeOut(
      JSON.stringify(secretRedactionService.redactValue(filteredRows))
    );
    return;
  }

  renderHistoryList(filteredRows, io);
}

export async function runsHistoryCommand(
  options: HistoryRunsOptions,
  io: HistoryInspectionCommandIo,
  dependencies: HistoryInspectionCommandDependencies = {}
): Promise<void> {
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options);
  const workflowKey = options.workflow as WorkflowKey;
  const lineageRepository = workspace.createLineageRepository();
  const lineageKeys = await lineageRepository.listLineageKeys(
    workspace.workspaceRoot
  );
  if (!lineageKeys.includes(workflowKey)) {
    throw createWorkflowLineageNotFoundError(workflowKey);
  }

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

  io.writeOut(`Workflow: ${workflowName} (${options.workflow})`);
  renderRunSummaries(summaries, io);
}

export async function showHistoryCommand(
  options: HistoryShowOptions,
  io: HistoryInspectionCommandIo,
  dependencies: HistoryInspectionCommandDependencies = {}
): Promise<void> {
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options);
  const workflowKey = options.workflow as WorkflowKey;
  const historyManager = workspace.createOutputHistoryManager();
  const runRef = await resolveCliRunRef(
    historyManager,
    workflowKey,
    options.run,
    "--run"
  );
  const runSummary = (await historyManager.getRunSummaries(workflowKey)).find(
    (summary) => summary.runRef === runRef
  );
  if (!runSummary) {
    throw new Error(`Run "${runRef}" was not found in history.`);
  }
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
  const attemptFilter = parseHistoryShowAttempt(options.attempt);
  const showKinds = parseHistorySearchValues(
    options.kind,
    Object.values(HISTORY_EVENT_KINDS),
    "--kind"
  );
  const pagingArgs = {
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.limit !== undefined
      ? { limit: parseHistoryInteger(options.limit, "--limit", 1, 1) }
      : {}),
    ...(options.tail !== undefined
      ? { tail: parseHistoryInteger(options.tail, "--tail", 0, 0) }
      : {}),
  };
  const maxEvents =
    options.maxEvents === undefined
      ? undefined
      : parseHistoryInteger(options.maxEvents, "--max-events", 1, 1);
  if (targetFilter) {
    if (targetFilter.kind === FINAL_STEP_PHASES.QUEUE) {
      for (const index of targetFilter.stepIndices) {
        assertStepIndex(stepCount, index, "--step");
      }
    } else if (
      targetFilter.kind === FINAL_STEP_PHASES.FINAL_STEP &&
      runSummary.hasFinalStep === false
    ) {
      throw new Error(
        `Invalid --step value "${options.step}". This run has no final step; ${formatValidStepIndexRange(stepCount)}.`
      );
    }
  }
  const manifestPath = WorkflowPaths.manifestPath(
    workspace.workspaceRoot,
    workflowKey,
    runRef
  );
  const resolver =
    dependencies.createRunOutputResolver?.() ?? new RunOutputResolver();

  const latestAttemptByTarget = new Map<string, ResolvedRunAttemptValue>();
  const runningAttemptKeys = new Set<string>();
  let latestAttemptKey: string | undefined;
  let finalPassCount = 0;
  const needsAttemptIndex =
    attemptFilter.kind === HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST ||
    targetFilter?.kind === HISTORY_SHOW_STEP_SELECTORS.RUNNING ||
    targetFilter?.kind === HISTORY_SHOW_STEP_SELECTORS.LATEST ||
    (targetFilter?.kind === FINAL_STEP_PHASES.FINAL_STEP &&
      targetFilter.passNumber !== undefined);
  if (needsAttemptIndex) {
    for await (const event of resolver.streamAttempts(manifestPath)) {
      if (event.kind !== RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED)
        continue;
      const attempt = event.attempt;
      const key = historyAttemptKey(attempt);
      latestAttemptKey = key;
      if (attempt.target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        finalPassCount = Math.max(finalPassCount, attempt.target.loopIndex + 1);
      }
      const targetKey = historyAttemptTargetKey(attempt.target);
      const latestForTarget = latestAttemptByTarget.get(targetKey);
      if (!latestForTarget || isLaterHistoryAttempt(attempt, latestForTarget)) {
        latestAttemptByTarget.set(targetKey, attempt);
      }
      if (event.unterminated) runningAttemptKeys.add(key);
    }
  }

  if (
    targetFilter?.kind === FINAL_STEP_PHASES.FINAL_STEP &&
    typeof targetFilter.passNumber === "number" &&
    targetFilter.passNumber > finalPassCount
  ) {
    throw new Error(
      `Invalid --step value "${options.step}"; valid final pass numbers are 1 to ${finalPassCount}`
    );
  }
  if (
    targetFilter?.kind === FINAL_STEP_PHASES.FINAL_STEP &&
    targetFilter.passNumber === HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST
  ) {
    // The latest final pass is resolved from the streamed attempt lifecycle below.
    targetFilter = {
      kind: FINAL_STEP_PHASES.FINAL_STEP,
      passNumber: finalPassCount || "latest",
    };
  }

  CliTerminalFormatter.setColorEnabled(options.color !== false);
  if (!options.json) io.writeErr(`Run: ${runRef}`);
  let renderedAttempts = 0;
  let paging: ReturnType<typeof parseOutputTextPaging>;
  let hasPaging =
    options.cursor !== undefined ||
    options.limit !== undefined ||
    options.tail !== undefined;
  let nextCursor: string | undefined;
  for await (const event of resolver.streamAttempts(manifestPath)) {
    if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
      const attempt = event.attempt;
      const key = historyAttemptKey(attempt);
      const latestForTarget = latestAttemptByTarget.get(
        historyAttemptTargetKey(attempt.target)
      );
      const isRunning = runningAttemptKeys.has(key);
      if (
        !matchesHistoryShowStep(attempt.target, targetFilter, {
          latest:
            targetFilter?.kind === HISTORY_SHOW_STEP_SELECTORS.LATEST
              ? key === latestAttemptKey
              : latestForTarget !== undefined &&
                key === historyAttemptKey(latestForTarget),
          running: isRunning,
        })
      ) {
        continue;
      }
      if (
        attemptFilter.kind === HISTORY_SHOW_ATTEMPT_SELECTORS.NUMBER &&
        attempt.attemptIndex + 1 !== attemptFilter.number
      ) {
        continue;
      }
      if (
        attemptFilter.kind === HISTORY_SHOW_ATTEMPT_SELECTORS.LATEST &&
        (!latestForTarget || key !== historyAttemptKey(latestForTarget))
      ) {
        continue;
      }
      const projected = projectHistoryAttempt(attempt, showKinds, options.path);
      if (!projected) continue;
      renderedAttempts++;
      if (hasPaging) {
        paging = parseOutputTextPaging(
          pagingArgs,
          renderedAttempts,
          "history show",
          "exactly one selected attempt"
        );
        if (renderedAttempts > 1)
          throw new Error(
            "history show: cursor, limit, and tail require exactly one selected attempt"
          );
      }
      let outputAttempt = projected;
      if (paging && typeof projected.output?.response === "string") {
        const page = pageOutputText(projected.output.response, paging);
        outputAttempt = {
          ...projected,
          output: { ...projected.output, response: page.text },
        };
        nextCursor = page.nextCursor;
      }
      if (options.json) {
        io.writeOut(
          JSON.stringify(
            secretRedactionService.redactValue({
              ...outputAttempt,
              runRef,
              unterminated: event.unterminated,
              ...(nextCursor ? { nextCursor } : {}),
            })
          )
        );
      } else {
        const allEvents = outputAttempt.output?.structured?.events;
        const omitted =
          maxEvents !== undefined && allEvents
            ? Math.max(0, allEvents.length - maxEvents)
            : 0;
        const boundedAttempt =
          omitted > 0
            ? {
                ...outputAttempt,
                output: {
                  ...outputAttempt.output!,
                  structured: {
                    ...outputAttempt.output!.structured!,
                    events: allEvents!.slice(0, maxEvents),
                  },
                },
              }
            : outputAttempt;
        renderHistoryAttempt(
          boundedAttempt,
          event.unterminated,
          workingDefinition
        );
        if (nextCursor)
          io.writeOut(`… more output (use --cursor ${nextCursor})`);
        if (omitted > 0) {
          const cursor =
            nextCursor ?? String((projected.output?.response ?? "").length);
          io.writeOut(`… ${omitted} more events (use --cursor ${cursor})`);
        }
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

  if (hasPaging && renderedAttempts !== 1) {
    parseOutputTextPaging(
      pagingArgs,
      renderedAttempts,
      "history show",
      "exactly one selected attempt"
    );
  }

  if (
    renderedAttempts === 0 &&
    targetFilter?.kind === FINAL_STEP_PHASES.QUEUE
  ) {
    const index = targetFilter.stepIndices[0];
    const runtime = workingDefinition?.steps[index]?._runtime;
    const state = historyWorkingStepState(runtime);
    const line =
      state === PROMPT_TERMINAL_STATUS.SKIPPED
        ? `Step ${index + 1} was skipped`
        : state === HISTORY_STEP_STATES.PENDING
          ? `Step ${index + 1} has not started (${HISTORY_STEP_STATES.PENDING})`
          : `Step ${index + 1} is ${state}`;
    if (!options.json) {
      CliTerminalFormatter.renderStatusMessage(
        line,
        STATUS_MESSAGE_SEVERITY.INFO
      );
    } else {
      io.writeOut(
        JSON.stringify({ runRef, step: index, status: state, message: line })
      );
    }
  }
}

function projectHistoryAttempt(
  attempt: ResolvedRunAttemptValue,
  kinds: readonly string[] | undefined,
  pathFilter: string | undefined
): ResolvedRunAttemptValue | undefined {
  if (!kinds && pathFilter === undefined) return attempt;
  const kindSet = kinds ? new Set(kinds) : undefined;
  const pathNeedle = pathFilter?.replace(/\\/g, "/").toLocaleLowerCase();
  const sourceKind = attempt.output?.source
    ? attempt.output.source === SCRIPT_OUTPUT_SOURCES.END_CONDITION
      ? HISTORY_EVENT_KINDS.END_CONDITION
      : attempt.output.source === SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP
        ? HISTORY_EVENT_KINDS.PRE_CONDITION
        : HISTORY_EVENT_KINDS.SCRIPT
    : undefined;
  const promptAllowed =
    pathNeedle === undefined &&
    (!kindSet || kindSet.has(sourceKind ?? HISTORY_EVENT_KINDS.PROMPT));
  const responseAllowed =
    pathNeedle === undefined &&
    (!kindSet || kindSet.has(sourceKind ?? HISTORY_EVENT_KINDS.RESPONSE));
  const events = attempt.output?.structured?.events ?? [];
  const matchingEvents = events.filter((event) => {
    const eventKind = historyCliEventKind(event.type);
    if (!eventKind || (kindSet && !kindSet.has(eventKind))) return false;
    if (pathNeedle === undefined) return true;
    const data = event.data as { path?: unknown };
    return (
      typeof data.path === "string" &&
      data.path.replace(/\\/g, "/").toLocaleLowerCase().includes(pathNeedle)
    );
  });
  const hasPromptOrResponse =
    (promptAllowed &&
      (attempt.prompt !== undefined ||
        attempt.output?.response !== undefined)) ||
    (responseAllowed && attempt.output?.response !== undefined);
  if (pathNeedle !== undefined && matchingEvents.length === 0) return undefined;
  if (
    !hasPromptOrResponse &&
    matchingEvents.length === 0 &&
    attempt.output?.structured?.events?.length
  )
    return undefined;
  return {
    ...attempt,
    ...(promptAllowed ? {} : { prompt: "" }),
    output: attempt.output
      ? {
          ...attempt.output,
          ...(!responseAllowed ? { response: "" } : {}),
          ...(attempt.output.structured
            ? {
                structured: {
                  ...attempt.output.structured,
                  events: matchingEvents,
                },
              }
            : {}),
        }
      : undefined,
  };
}

function historyCliEventKind(type: string): string | undefined {
  switch (type) {
    case CLI_EVENT_TYPES.TEXT:
      return HISTORY_EVENT_KINDS.RESPONSE;
    case CLI_EVENT_TYPES.THINKING:
      return HISTORY_EVENT_KINDS.THINKING;
    case CLI_EVENT_TYPES.BASH_COMMAND:
      return HISTORY_EVENT_KINDS.BASH;
    case CLI_EVENT_TYPES.FILE_READ:
      return HISTORY_EVENT_KINDS.FILE_READ;
    case CLI_EVENT_TYPES.FILE_WRITE:
      return HISTORY_EVENT_KINDS.FILE_WRITE;
    case CLI_EVENT_TYPES.FILE_EDIT:
      return HISTORY_EVENT_KINDS.FILE_EDIT;
    case CLI_EVENT_TYPES.FILE_DELETE:
      return HISTORY_EVENT_KINDS.FILE_DELETE;
    case CLI_EVENT_TYPES.MCP_TOOL_CALL:
      return HISTORY_EVENT_KINDS.MCP_TOOL;
    case CLI_EVENT_TYPES.TOOL_CALL:
    case CLI_EVENT_TYPES.TOOL_RESULT:
      return HISTORY_EVENT_KINDS.TOOL;
    case CLI_EVENT_TYPES.WEB_SEARCH:
      return HISTORY_EVENT_KINDS.WEB_SEARCH;
    case CLI_EVENT_TYPES.COMPACTION:
      return HISTORY_EVENT_KINDS.COMPACTION;
    default:
      return undefined;
  }
}

export async function stepsHistoryCommand(
  options: HistoryStepsOptions,
  io: HistoryInspectionCommandIo,
  dependencies: HistoryInspectionCommandDependencies = {}
): Promise<void> {
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options);
  const workflowKey = options.workflow as WorkflowKey;
  const historyManager = workspace.createOutputHistoryManager();
  const runRef = await resolveCliRunRef(
    historyManager,
    workflowKey,
    options.run,
    "--run"
  );
  const runSummary = (await historyManager.getRunSummaries(workflowKey)).find(
    (summary) => summary.runRef === runRef
  );
  if (!runSummary) throw new Error(`Run "${runRef}" was not found in history.`);
  const definition = await readRunWorkingDefinition(
    workspace.workspaceRoot,
    workflowKey,
    runRef
  );
  if (!definition) {
    throw new Error(`Run "${runRef}" has no readable workflow working file.`);
  }

  const steps = definition.steps.map((step, index) => ({
    selector: formatCliStepSelector(index),
    index,
    name: step.name?.trim() || `Step ${index + 1}`,
    state: historyWorkingStepState(step._runtime),
    harness: step._runtime?.harness ?? "—",
    model: step._runtime?.model ?? "—",
    elapsed: formatElapsed(step._runtime?.elapsed),
    attempts: 0,
    prompt: formatStepPrompt(step, options.fullPrompts === true),
  }));
  const finalPassIndices = new Set<number>();
  const resolver =
    dependencies.createRunOutputResolver?.() ?? new RunOutputResolver();
  for await (const event of resolver.streamAttemptLifecycle(
    WorkflowPaths.manifestPath(workspace.workspaceRoot, workflowKey, runRef)
  )) {
    const index =
      event.target.kind === FINAL_STEP_PHASES.QUEUE
        ? event.target.stepIndex
        : undefined;
    if (event.eventType === TIMELINE_EVENT_TYPES.ATTEMPT_STARTED) {
      if (index !== undefined && steps[index]) steps[index].attempts++;
      if (
        index === undefined &&
        definition.finalStep &&
        event.target.kind === FINAL_STEP_PHASES.FINAL_STEP
      ) {
        finalPassIndices.add(event.target.loopIndex);
      }
    }
  }
  const finalStep = definition.finalStep
    ? {
        selector: "final",
        name: definition.finalStep.name?.trim() || "Final Step",
        state: historyWorkingStepState(definition.finalStep._runtime),
        harness: definition.finalStep._runtime?.harness ?? "—",
        model: definition.finalStep._runtime?.model ?? "—",
        elapsed: formatElapsed(definition.finalStep._runtime?.elapsed),
        passes: finalPassIndices.size,
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
  io.writeOut("#  NAME  STATE  HARNESS  MODEL  ELAPSED  ATTEMPTS  PROMPT");
  for (const step of steps) {
    io.writeOut(
      `${step.index}  ${step.name}  ${step.state}  ${step.harness}  ${step.model}  ${step.elapsed}  ${step.attempts}  ${step.prompt}`
    );
  }
  if (finalStep) {
    io.writeOut(
      `F  ${finalStep.name}  ${finalStep.state}  ${finalStep.harness}  ${finalStep.model}  ${finalStep.elapsed}  ${finalStep.passes} passes  ${finalStep.prompt}`
    );
  }
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
  const request = buildHistorySearchQuery(query, options);
  const snippetChars = requestSnippetChars(options);
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options, { runs: { historySearchCacheMb: 0 } });
  const service =
    dependencies.createHistorySearchService?.() ?? new HistorySearchService();
  const progress = createHistorySearchProgressReporter(io);
  let response: HistorySearchResponse;
  let completed = false;
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
    completed = true;
  } finally {
    progress.finish(completed);
  }

  if (options.json) {
    renderHistorySearchJson(request, response, io);
    return;
  }
  renderHistorySearchText(request, response, io);
}

const HISTORY_SEARCH_PROGRESS_INTERVAL_MS = 250;

function createHistorySearchProgressReporter(io: HistoryInspectionCommandIo): {
  onProgress: IndexRebuildProgressCallback;
  finish(completed: boolean): void;
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
    finish: (completed) => {
      if (startedAt === undefined || latestMessage === undefined) {
        return;
      }

      if (io.isErrTty) {
        if (latestMessage !== renderedMessage) {
          io.writeErrProgress(`\r\x1b[K${latestMessage}`);
        }
        io.writeErrProgress("\n");
        return;
      }

      if (completed) {
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        io.writeErr(`Search index rebuild completed in ${elapsedMs} ms.`);
      }
    },
  };
}

function buildHistorySearchQuery(
  query: string,
  options: HistorySearchCommandOptions
): HistorySearchQuery {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < HISTORY_SEARCH_MIN_QUERY_LENGTH) {
    throw new Error(
      `History search queries must contain at least ${HISTORY_SEARCH_MIN_QUERY_LENGTH} characters.`
    );
  }

  const workflowKeys = [...(options.workflow ?? [])];
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
  const step =
    result.target.kind === FINAL_STEP_PHASES.FINAL_STEP
      ? "final"
      : String(result.target.stepIndex);
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

function historyAttemptKey(attempt: ResolvedRunAttemptValue): string {
  return `${historyAttemptTargetKey(attempt.target)}:run:${attempt.runIndex}:attempt:${attempt.attemptIndex}`;
}

function isLaterHistoryAttempt(
  candidate: ResolvedRunAttemptValue,
  current: ResolvedRunAttemptValue
): boolean {
  return (
    candidate.runIndex > current.runIndex ||
    (candidate.runIndex === current.runIndex &&
      candidate.attemptIndex > current.attemptIndex)
  );
}

function renderHistoryAttempt(
  attempt: ResolvedRunAttemptValue,
  unterminated: boolean,
  workingDefinition?: RunWorkingDefinition
): void {
  const target = createHistoryOutputTarget(attempt);
  if (attempt.target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
    CliTerminalFormatter.renderFinalStepLabel(attempt.target.loopIndex);
  }
  CliTerminalFormatter.renderPromptHeader({
    stepIndex: target.stepIndex,
    totalSteps: workingDefinition?.steps.length ?? target.stepIndex + 1,
    stepName: historyStepName(attempt, workingDefinition),
    promptText: historyAttemptPrompt(attempt),
    attemptIndex: attempt.attemptIndex,
    runIndex: attempt.runIndex,
  });

  const output = attempt.output;
  if (isHistoryScriptAttempt(attempt)) {
    CliTerminalFormatter.renderScriptOutput(
      historyScriptOutput(attempt),
      target
    );
  } else if (output?.structured?.events?.length) {
    CliTerminalFormatter.renderEvents(output.structured.events, target);
  } else if (output?.response) {
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
    : `Final Step Loop ${attempt.target.loopIndex + 1}`;
}

function historyAttemptPrompt(attempt: ResolvedRunAttemptValue): string {
  if (attempt.prompt !== undefined) return attempt.prompt;
  const step = attempt.definition?.step;
  if (!step) return "";
  return isScriptStep(step) ? step.script : step.prompt;
}

function isHistoryScriptAttempt(attempt: ResolvedRunAttemptValue): boolean {
  return (
    attempt.scriptOutput !== undefined ||
    attempt.output?.source !== undefined ||
    attempt.kind === TIMELINE_ATTEMPT_KINDS.SCRIPT ||
    attempt.kind === TIMELINE_ATTEMPT_KINDS.CONDITION ||
    attempt.kind === TIMELINE_ATTEMPT_KINDS.SETUP
  );
}

function historyScriptOutput(attempt: ResolvedRunAttemptValue): CliOutput {
  const output = attempt.output;
  const scriptOutput = attempt.scriptOutput;
  const source =
    output?.source ??
    (attempt.kind === TIMELINE_ATTEMPT_KINDS.CONDITION
      ? SCRIPT_OUTPUT_SOURCES.END_CONDITION
      : attempt.kind === TIMELINE_ATTEMPT_KINDS.SETUP
        ? SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP
        : SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP);
  const response = scriptOutput
    ? [scriptOutput.stdout, scriptOutput.stderr].filter(Boolean).join("\n")
    : (output?.response ?? "");
  return {
    ...(output ?? {}),
    response,
    elapsed: output?.elapsed ?? 0,
    isStreaming: false,
    source,
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
    row.workflowName,
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
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

function formatElapsed(elapsed: number | undefined): string {
  if (elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0)
    return "—";
  const seconds = Math.round(elapsed);
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
    (runtime?.startedAt !== undefined
      ? runtime.completedAt !== undefined
        ? EXECUTION_STATES.COMPLETED
        : EXECUTION_STATES.RUNNING
      : HISTORY_STEP_STATES.PENDING)
  );
}
