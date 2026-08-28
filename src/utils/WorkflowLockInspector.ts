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
    const parsed: unknown = JSON.parse(content);
    // Keep development upgrades tolerant of locks written before schema v2.
    // A legacy object is still returned for liveness-only callers; ownership
    // classification will be added in a later phase. Reject non-object JSON so
    // callers never dereference null or a primitive as a lock.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as WorkflowRunnerLock;
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
