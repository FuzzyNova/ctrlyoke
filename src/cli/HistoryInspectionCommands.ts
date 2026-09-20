import type { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import type { WorkflowLineageRepository } from "../core/orchestration/WorkflowLineageRepository";
import type { RunNavigationSummary } from "../core/orchestration/OutputHistoryManager";
import { bootstrapCliWorkspace } from "./CliWorkspaceBootstrap";
import type {
  HistoryListOptions,
  HistoryRunsOptions,
  HistoryShowOptions,
} from "./HistoryCommandDefinitions";
import { resolveCliRunRef } from "./CliRunSelector";
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
  FINAL_STEP_PHASES,
  RUN_OUTPUT_RESOLVER_EVENT_KINDS,
  STATUS_MESSAGE_SEVERITY,
} from "../types/DashboardConstants";
import type { OutputExecutionTarget } from "../types/OutputHistoryTypes";
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
import type { CliOutput } from "../types/WebviewMessageTypes";
import { SCRIPT_OUTPUT_SOURCES } from "../types/DashboardConstants";
import { secretRedactionService } from "../utils/SecretRedactionService";

export interface HistoryInspectionCommandIo {
  writeOut(message: string): void;
  writeErr(message: string): void;
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
      HistoryListOptions | HistoryRunsOptions | HistoryShowOptions,
      "cwd"
    >
  ) => Promise<HistoryInspectionWorkspace>;
  createRunOutputResolver?: () => HistoryInspectionRunOutputResolver;
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
    throw new Error(`Workflow lineage "${options.workflow}" was not found.`);
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
  }
  CliTerminalFormatter.flushStreamingBuffer(target);
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
      return createHistoryListRow(
        workflowKey,
        descriptor,
        workflowName,
        navigation
      );
    })
  );
  return rows.filter((row): row is HistoryListRow => row !== undefined);
}

function createHistoryListRow(
  workflowKey: WorkflowKey,
  descriptor: WorkflowLineageDescriptor | undefined,
  workflowName: string,
  navigation: RunNavigationSummary
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
    lastModifiedAt: descriptor?.lastModifiedAt ?? null,
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
