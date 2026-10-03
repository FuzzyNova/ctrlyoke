import type { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import type { WorkflowLineageRepository } from "../core/orchestration/WorkflowLineageRepository";
import type { RunNavigationSummary } from "../core/orchestration/OutputHistoryManager";
import { bootstrapCliWorkspace } from "./CliWorkspaceBootstrap";
import type {
  HistoryListOptions,
  HistoryRunsOptions,
  HistoryShowOptions,
  HistorySearchOptions as HistorySearchCommandOptions,
} from "./HistoryCommandDefinitions";
import {
  createWorkflowLineageNotFoundError,
  resolveCliRunRef,
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
  CTRLYOKE_ENV_VARS,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  HISTORY_EVENT_KINDS,
  HISTORY_SEARCH_COUNT_STATES,
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
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_ATTEMPT_TERMINAL_STATES,
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

  if (options.json) {
    io.writeOut(JSON.stringify(secretRedactionService.redactValue(rows)));
    return;
  }

  renderHistoryList(rows, io);
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
  const targetFilter = parseHistoryShowStep(options.step);
  if (targetFilter) {
    const runSummary = (await historyManager.getRunSummaries(workflowKey)).find(
      (summary) => summary.runRef === runRef
    );
    if (!runSummary) {
      throw new Error(`Run "${runRef}" was not found in history.`);
    }
    const workingFileStepCount =
      runSummary.workingFileStepCount ?? runSummary.stepCount;
    if (targetFilter.kind === FINAL_STEP_PHASES.QUEUE) {
      assertStepIndex(workingFileStepCount, targetFilter.stepIndex, "--step");
    } else if (runSummary.hasFinalStep === false) {
      throw new Error(
        `Invalid --step value "final". This run has no final step; ${formatValidStepIndexRange(workingFileStepCount)}.`
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

  CliTerminalFormatter.setColorEnabled(options.color !== false);
  for await (const event of resolver.streamAttempts(manifestPath)) {
    if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.ATTEMPT_SETTLED) {
      if (!matchesHistoryShowStep(event.attempt.target, targetFilter)) {
        continue;
      }
      if (options.json) {
        io.writeOut(
          JSON.stringify(
            secretRedactionService.redactValue({
              ...event.attempt,
              unterminated: event.unterminated,
            })
          )
        );
      } else {
        renderHistoryAttempt(event.attempt, event.unterminated);
      }
      continue;
    }

    if (
      !options.json &&
      event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.RUN_TERMINATED
    ) {
      CliTerminalFormatter.renderStatusMessage(
        `Run terminated: ${event.executionState}`,
        historyExecutionStateSeverity(event.executionState)
      );
    }
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
  const executionStates = parseHistorySearchValues(
    options.state,
    Object.values(EXECUTION_STATES),
    "--state"
  );
  const now = Date.now();
  const since = options.since
    ? parseHistoryTime(options.since, now)
    : undefined;
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
  if (value === undefined) {
    return whenMissing;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid ${optionName} value "${value}"; expected an integer.`
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(
      `Invalid ${optionName} value "${value}"; expected an integer of at least ${minimum}.`
    );
  }
  return parsed;
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

type HistoryShowStepFilter =
  | { kind: typeof FINAL_STEP_PHASES.QUEUE; stepIndex: number }
  | { kind: typeof FINAL_STEP_PHASES.FINAL_STEP };

function parseHistoryShowStep(
  step: string | undefined
): HistoryShowStepFilter | undefined {
  if (step === undefined) {
    return undefined;
  }
  if (step === "final") {
    return { kind: FINAL_STEP_PHASES.FINAL_STEP };
  }
  if (!/^\d+$/.test(step)) {
    throw new Error(
      `Invalid --step value "${step}"; use a zero-based index or final`
    );
  }
  const stepIndex = Number(step);
  if (!Number.isSafeInteger(stepIndex)) {
    throw new Error(
      `Invalid --step value "${step}"; use a zero-based index or final`
    );
  }
  return { kind: FINAL_STEP_PHASES.QUEUE, stepIndex };
}

function matchesHistoryShowStep(
  target: OutputExecutionTarget,
  filter: HistoryShowStepFilter | undefined
): boolean {
  if (!filter) return true;
  if (filter.kind === FINAL_STEP_PHASES.FINAL_STEP) {
    return target.kind === FINAL_STEP_PHASES.FINAL_STEP;
  }
  return (
    target.kind === FINAL_STEP_PHASES.QUEUE &&
    target.stepIndex === filter.stepIndex
  );
}

function renderHistoryAttempt(
  attempt: ResolvedRunAttemptValue,
  unterminated: boolean
): void {
  const target = createHistoryOutputTarget(attempt);
  if (attempt.target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
    CliTerminalFormatter.renderFinalStepLabel(attempt.target.loopIndex);
  }
  CliTerminalFormatter.renderPromptHeader({
    stepIndex: target.stepIndex,
    totalSteps:
      attempt.definition?.definition.steps.length ?? target.stepIndex + 1,
    stepName: historyStepName(attempt),
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

function historyStepName(attempt: ResolvedRunAttemptValue): string {
  const step = attempt.definition?.step;
  if (step?.name?.trim()) return step.name.trim();
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
    String(summary.stepCount),
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
