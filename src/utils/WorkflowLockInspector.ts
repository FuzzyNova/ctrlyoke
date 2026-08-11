import * as fs from "fs";
import type { WorkflowRunnerLock, WorkflowKey } from "../types/CtrlYokeTypes";
import {
  LOCK_STATUS,
  RUNNER_IDS,
  type LockStatus,
} from "../types/DashboardConstants";
import * as WorkflowPaths from "./WorkflowPaths";
import { isOwnerStale } from "./LockSafetyPrimitives";

/** Shared, Node-only runner-lock reader for CLI and MCP process boundaries. */

export async function readWorkflowLock(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): Promise<WorkflowRunnerLock | null> {
  try {
    const content = await fs.promises.readFile(
      WorkflowPaths.runnerLockPath(workspaceRoot, workflowKey),
      "utf8"
    );
    return JSON.parse(content) as WorkflowRunnerLock;
  } catch {
    return null;
  }
}

export async function inspectWorkflowLock(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): Promise<LockStatus> {
  const lock = await readWorkflowLock(workspaceRoot, workflowKey);
  if (!lock) return LOCK_STATUS.NONE;

  if (isOwnerStale(lock.pid, lock.lastHeartbeat)) {
    return LOCK_STATUS.STALE;
  }

  return lock.runner === RUNNER_IDS.CLI
    ? LOCK_STATUS.ACTIVE_CLI
    : LOCK_STATUS.ACTIVE_VSCODE;
}

export { isProcessAlive } from "./LockSafetyPrimitives";
