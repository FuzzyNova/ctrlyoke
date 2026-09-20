import type { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import type { WorkflowLineageRepository } from "../core/orchestration/WorkflowLineageRepository";
import type { RunNavigationSummary } from "../core/orchestration/OutputHistoryManager";
import { bootstrapCliWorkspace } from "./CliWorkspaceBootstrap";
import type {
  HistoryListOptions,
  HistoryRunsOptions,
} from "./HistoryCommandDefinitions";
import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../types/CtrlYokeTypes";
import type { RunSummary } from "../types/WorkflowTimelineTypes";
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

export interface HistoryInspectionWorkspace {
  workspaceRoot: string;
  createOutputHistoryManager(): HistoryInspectionOutputHistoryManager;
  createLineageRepository(): HistoryInspectionLineageRepository;
}

export interface HistoryInspectionCommandDependencies {
  bootstrapCliWorkspace?: (
    options: Pick<HistoryListOptions | HistoryRunsOptions, "cwd">
  ) => Promise<HistoryInspectionWorkspace>;
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
