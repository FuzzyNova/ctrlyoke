import type { StatusOptions } from "./StatusCommandDefinitions";
import { bootstrapCliWorkspace } from "./CliWorkspaceBootstrap";
import type { CliWorkspaceBootstrap } from "./CliWorkspaceBootstrap";
import { GlobalWorkflowStatusService } from "../core/orchestration/GlobalWorkflowStatusService";
import type {
  RunRef,
  WorkflowKey,
  WorkflowRunnerLock,
} from "../types/CtrlYokeTypes";
import {
  isActiveLock,
  readWorkflowLockInspection,
} from "../utils/WorkflowLockInspector";
import type { WorkflowLockInspection } from "../utils/WorkflowLockInspector";

export interface CliStatusCommandIo {
  writeOut(message: string): void;
}

export interface CliStatusCommandDependencies {
  bootstrapCliWorkspace?: typeof bootstrapCliWorkspace;
  readWorkflowLockInspection?: typeof readWorkflowLockInspection;
  now?: () => number;
}

export interface CliStatusWorkflow extends Record<string, unknown> {
  workflowKey: string;
  runRef: string | null;
  executionState: string;
  currentStep: number;
  totalSteps: number;
  harness: string | null;
  model: string | null;
  startedAt: number | null;
  lastModifiedAt: number | null;
  liveness: {
    state: "alive" | "stale";
    heartbeatAgeMs: number | null;
    pid: number | null;
    lastHeartbeat: number | null;
  };
}

export async function statusCommand(
  options: StatusOptions,
  io: CliStatusCommandIo,
  dependencies: CliStatusCommandDependencies = {}
): Promise<void> {
  const workspace: CliWorkspaceBootstrap = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options);
  const result = await new GlobalWorkflowStatusService(
    workspace.workspaceRoot,
    workspace.createLineageRepository()
  ).getStatus({
    ...(options.workflow && { workflowKey: options.workflow as WorkflowKey }),
    ...(options.run && { runRef: options.run as RunRef }),
  });
  const now = (dependencies.now ?? Date.now)();
  const inspectLock =
    dependencies.readWorkflowLockInspection ?? readWorkflowLockInspection;
  const workflows: CliStatusWorkflow[] = await Promise.all(
    result.workflows.map(async (entry) => {
      const row = entry as unknown as CliStatusWorkflow;
      const inspection = await inspectLock(
        workspace.workspaceRoot,
        row.workflowKey as WorkflowKey,
        { now: () => now }
      );
      const lock = matchingRunInspection(inspection, row.runRef);
      const heartbeatAgeMs = lock
        ? Math.max(0, now - lock.lastHeartbeat)
        : null;
      return {
        ...row,
        liveness: {
          state: lock ? "alive" : "stale",
          heartbeatAgeMs,
          pid: lock?.pid ?? null,
          lastHeartbeat: lock?.lastHeartbeat ?? null,
        },
      };
    })
  );
  const response = { ...result, workflows };
  if (options.json) {
    io.writeOut(JSON.stringify(response));
    return;
  }
  io.writeOut(formatStatusTable(workflows));
}

function matchingRunInspection(
  inspection: WorkflowLockInspection,
  runRef: string | null
): WorkflowRunnerLock | null {
  if (!isActiveLock(inspection) || inspection.lock.runRef !== runRef)
    return null;
  return inspection.lock;
}

function formatStatusTable(workflows: readonly CliStatusWorkflow[]): string {
  const columns = [
    "WORKFLOW",
    "RUN",
    "STATE",
    "STEP",
    "HARNESS",
    "MODEL",
    "STARTED",
    "HEARTBEAT",
    "LIVENESS",
  ];
  const rows = workflows.map((workflow) => [
    workflow.workflowKey,
    workflow.runRef ?? "—",
    workflow.executionState,
    `${workflow.currentStep}/${workflow.totalSteps}`,
    workflow.harness ?? "—",
    workflow.model ?? "—",
    workflow.startedAt === null
      ? "—"
      : new Date(workflow.startedAt).toISOString(),
    workflow.liveness.heartbeatAgeMs === null
      ? "—"
      : formatAge(workflow.liveness.heartbeatAgeMs),
    workflow.liveness.state,
  ]);
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => row[index].length))
  );
  const render = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [render(columns), ...rows.map(render)].join("\n");
}

function formatAge(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1000)}s`;
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)}m`;
  return `${Math.floor(milliseconds / 3_600_000)}h`;
}
