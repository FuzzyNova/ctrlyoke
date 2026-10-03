import type { StatusOptions } from "./StatusCommandDefinitions";
import { bootstrapCliWorkspace } from "./CliWorkspaceBootstrap";
import type { CliWorkspaceBootstrap } from "./CliWorkspaceBootstrap";
import {
  GlobalWorkflowStatusService,
  type GlobalWorkflowStatusRow,
  type GlobalWorkflowStatusWording,
} from "../core/orchestration/GlobalWorkflowStatusService";
import type { RunRef, WorkflowKey } from "../types/CtrlYokeTypes";
import {
  CLI_STATUS_LIVENESS_REASONS,
  CLI_STATUS_LIVENESS_STATES,
  WORKFLOW_LOCK_LIVENESS,
  type CliStatusLivenessReason,
  type CliStatusLivenessState,
} from "../types/DashboardConstants";
import {
  isActiveLock,
  readWorkflowLockInspection,
} from "../utils/WorkflowLockInspector";
import type { WorkflowLockInspection } from "../utils/WorkflowLockInspector";
import {
  isProcessAlive,
  type ProcessLivenessCheck,
} from "../utils/LockSafetyPrimitives";

export interface CliStatusCommandIo {
  writeOut(message: string): void;
}

export interface CliStatusCommandDependencies {
  bootstrapCliWorkspace?: typeof bootstrapCliWorkspace;
  readWorkflowLockInspection?: typeof readWorkflowLockInspection;
  isProcessAlive?: ProcessLivenessCheck;
  now?: () => number;
}

/** CLI wording for the shared status service's errors. */
const CLI_STATUS_WORDING: GlobalWorkflowStatusWording = {
  surface: "status",
  runRequiresWorkflow: "--run requires --workflow",
  listWorkflowsHint:
    "Run `ctrlyoke history list` to see the workflow keys that exist.",
};

export interface CliStatusLiveness {
  state: CliStatusLivenessState;
  reason: CliStatusLivenessReason;
  /** Age of the lock's heartbeat; null when runner.json has none. */
  heartbeatAgeMs: number | null;
  /** The lock's process whenever runner.json exists, even when stale. */
  pid: number | null;
  lastHeartbeat: number | null;
  /** The run runner.json is held for, when it is a different run. */
  lockRunRef?: string;
}

export interface CliStatusWorkflow extends GlobalWorkflowStatusRow {
  liveness: CliStatusLiveness;
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
    workspace.createLineageRepository(),
    CLI_STATUS_WORDING
  ).getStatus({
    ...(options.workflow && { workflowKey: options.workflow as WorkflowKey }),
    ...(options.run && { runRef: options.run as RunRef }),
  });
  const now = (dependencies.now ?? Date.now)();
  const processAlive = dependencies.isProcessAlive ?? isProcessAlive;
  const inspectLock =
    dependencies.readWorkflowLockInspection ?? readWorkflowLockInspection;
  const workflows: CliStatusWorkflow[] = await Promise.all(
    result.workflows.map(async (row) => {
      const inspection = await inspectLock(
        workspace.workspaceRoot,
        row.workflowKey,
        { now: () => now, isProcessAlive: processAlive }
      );
      return {
        ...row,
        liveness: describeLiveness(inspection, row.runRef, now, processAlive),
      };
    })
  );
  const response = { ...result, workflows };
  if (options.json) {
    io.writeOut(JSON.stringify(response));
    return;
  }
  const lines: string[] = [];
  if (workflows.length === 0) {
    lines.push("No workflows are executing.");
  } else {
    lines.push(formatStatusTable(workflows));
  }
  if (result.omittedCount > 0) {
    lines.push(
      `${result.omittedCount} more executing workflow${result.omittedCount === 1 ? "" : "s"} not shown.`
    );
  }
  if (result.note) lines.push(result.note);
  io.writeOut(lines.join("\n"));
}

function describeLiveness(
  inspection: WorkflowLockInspection,
  runRef: string | null,
  now: number,
  processAlive: ProcessLivenessCheck
): CliStatusLiveness {
  if (inspection.liveness === WORKFLOW_LOCK_LIVENESS.ABSENT) {
    return {
      state: CLI_STATUS_LIVENESS_STATES.STALE,
      reason: CLI_STATUS_LIVENESS_REASONS.ABSENT,
      heartbeatAgeMs: null,
      pid: null,
      lastHeartbeat: null,
    };
  }
  const { lock } = inspection;
  // A lock written by a newer ctrlyoke is reported active without being
  // validated, so its fields are guarded rather than trusted.
  const lastHeartbeat =
    typeof lock.lastHeartbeat === "number" &&
    Number.isFinite(lock.lastHeartbeat)
      ? lock.lastHeartbeat
      : null;
  const pid =
    typeof lock.pid === "number" && Number.isSafeInteger(lock.pid)
      ? lock.pid
      : null;
  const evidence = {
    heartbeatAgeMs:
      lastHeartbeat === null ? null : Math.max(0, now - lastHeartbeat),
    pid,
    lastHeartbeat,
  };
  if (isActiveLock(inspection)) {
    if (lock.runRef === runRef) {
      return {
        state: CLI_STATUS_LIVENESS_STATES.ALIVE,
        reason: CLI_STATUS_LIVENESS_REASONS.ACTIVE,
        ...evidence,
      };
    }
    return {
      state: CLI_STATUS_LIVENESS_STATES.STALE,
      reason: CLI_STATUS_LIVENESS_REASONS.OTHER_RUN,
      ...evidence,
      lockRunRef: lock.runRef,
    };
  }
  return {
    state: CLI_STATUS_LIVENESS_STATES.STALE,
    reason:
      pid === null || !processAlive(pid)
        ? CLI_STATUS_LIVENESS_REASONS.STALE_DEAD_PID
        : CLI_STATUS_LIVENESS_REASONS.STALE_HEARTBEAT,
    ...evidence,
  };
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
    "PID",
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
    workflow.liveness.pid === null ? "—" : String(workflow.liveness.pid),
    workflow.liveness.heartbeatAgeMs === null
      ? "—"
      : formatAge(workflow.liveness.heartbeatAgeMs),
    workflow.liveness.reason === CLI_STATUS_LIVENESS_REASONS.ACTIVE
      ? workflow.liveness.state
      : `${workflow.liveness.state} (${workflow.liveness.reason})`,
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
