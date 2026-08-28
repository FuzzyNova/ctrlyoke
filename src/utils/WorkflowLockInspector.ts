import * as fs from "fs";
import type {
  RunnerHostIdentity,
  WorkflowRunnerLock,
  WorkflowKey,
} from "../types/CtrlYokeTypes";
import { RUNNER_IDS } from "../types/DashboardConstants";
import * as WorkflowPaths from "./WorkflowPaths";
import {
  isOwnerStale,
  isProcessAlive,
  type ProcessLivenessCheck,
} from "./LockSafetyPrimitives";

/** Shared, Node-only runner-lock reader for CLI and MCP process boundaries. */

export type WorkflowLockInspection =
  | { liveness: "absent" }
  | { liveness: "stale"; lock: WorkflowRunnerLock }
  | {
      liveness: "active";
      locality: "self" | "external" | "indeterminate";
      lock: WorkflowRunnerLock;
    };

export type WorkflowLockInspectionOptions = {
  /** Injectable clock for deterministic heartbeat classification. */
  now?: () => number;
  /** Injectable process-liveness check for deterministic PID classification. */
  isProcessAlive?: ProcessLivenessCheck;
  /** Injectable diagnostic sink for deterministic contradiction assertions. */
  onIdentityDiagnostic?: (diagnostic: WorkflowLockIdentityDiagnostic) => void;
};

export type WorkflowLockIdentityDiagnostic = {
  event: "workflow-lock-identity-contradiction";
  workflowKey: string;
  runRef: string;
  runner: RunnerHostIdentity["runner"];
  observerRunner: RunnerHostIdentity["runner"];
  lockPid: number;
  observerPid: number;
  pidRelationship: "same" | "different";
  reason:
    | "legacy-lock-different-pid"
    | "same-host-different-pid"
    | "different-host-same-pid";
  locality: "indeterminate";
};

type ActiveWorkflowLockInspection = Extract<
  WorkflowLockInspection,
  { liveness: "active" }
>;

/** Return whether an inspection found a live lock. */
export function isActiveLock(
  inspection: WorkflowLockInspection
): inspection is ActiveWorkflowLockInspection {
  return inspection.liveness === "active";
}

/** Return whether an active lock belongs to the observing host. */
export function isSelfOwnedLock(
  inspection: WorkflowLockInspection
): inspection is ActiveWorkflowLockInspection & { locality: "self" } {
  return isActiveLock(inspection) && inspection.locality === "self";
}

/** Return whether an active lock belongs to another host. */
export function isExternalOwnedLock(
  inspection: WorkflowLockInspection
): inspection is ActiveWorkflowLockInspection & { locality: "external" } {
  return isActiveLock(inspection) && inspection.locality === "external";
}

/**
 * Classify a parsed lock relative to one explicitly supplied host identity.
 *
 * A missing lock and malformed raw lock both produce `absent`: neither is
 * usable as ownership proof. Legacy locks without a host identity remain
 * liveness-visible, but a different PID is deliberately indeterminate rather
 * than external because the old schema cannot establish host locality.
 */
export function inspectWorkflowLockOwnership(
  rawLock: unknown,
  observer: RunnerHostIdentity | undefined,
  options: WorkflowLockInspectionOptions = {}
): WorkflowLockInspection {
  if (!isWorkflowRunnerLock(rawLock)) {
    return { liveness: "absent" };
  }

  const now = options.now ?? Date.now;
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  if (isOwnerStale(rawLock.pid, rawLock.lastHeartbeat, now(), processAlive)) {
    return { liveness: "stale", lock: rawLock };
  }

  // Liveness-only consumers deliberately do not provide an observer identity.
  // Keep the lock active without inventing a locality classification for them.
  if (!observer) {
    return { liveness: "active", locality: "indeterminate", lock: rawLock };
  }

  const lockHostInstanceId = rawLock.hostInstanceId;
  if (!lockHostInstanceId) {
    if (rawLock.pid === observer.pid) {
      return { liveness: "active", locality: "self", lock: rawLock };
    }

    logIdentityDiagnostic(
      rawLock,
      observer,
      "legacy-lock-different-pid",
      options.onIdentityDiagnostic
    );
    return { liveness: "active", locality: "indeterminate", lock: rawLock };
  }

  if (lockHostInstanceId === observer.hostInstanceId) {
    if (rawLock.pid === observer.pid) {
      return { liveness: "active", locality: "self", lock: rawLock };
    }

    logIdentityDiagnostic(
      rawLock,
      observer,
      "same-host-different-pid",
      options.onIdentityDiagnostic
    );
    return { liveness: "active", locality: "indeterminate", lock: rawLock };
  }

  if (rawLock.pid === observer.pid) {
    logIdentityDiagnostic(
      rawLock,
      observer,
      "different-host-same-pid",
      options.onIdentityDiagnostic
    );
    return { liveness: "active", locality: "indeterminate", lock: rawLock };
  }

  return { liveness: "active", locality: "external", lock: rawLock };
}

function isWorkflowRunnerLock(value: unknown): value is WorkflowRunnerLock {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.workflowKey === "string" &&
    typeof candidate.runRef === "string" &&
    (candidate.runner === RUNNER_IDS.VSCODE ||
      candidate.runner === RUNNER_IDS.CLI) &&
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.ownerToken === "string" &&
    typeof candidate.startedAt === "number" &&
    Number.isFinite(candidate.startedAt) &&
    typeof candidate.lastHeartbeat === "number" &&
    Number.isFinite(candidate.lastHeartbeat) &&
    (candidate.schemaVersion === undefined || candidate.schemaVersion === 2) &&
    (candidate.hostInstanceId === undefined ||
      typeof candidate.hostInstanceId === "string") &&
    (candidate.executionInstanceId === undefined ||
      typeof candidate.executionInstanceId === "string")
  );
}

function logIdentityDiagnostic(
  lock: WorkflowRunnerLock,
  observer: RunnerHostIdentity,
  reason:
    | "legacy-lock-different-pid"
    | "same-host-different-pid"
    | "different-host-same-pid",
  onIdentityDiagnostic?: (diagnostic: WorkflowLockIdentityDiagnostic) => void
): void {
  const diagnostic: WorkflowLockIdentityDiagnostic = {
    event: "workflow-lock-identity-contradiction",
    workflowKey: lock.workflowKey,
    runRef: lock.runRef,
    runner: lock.runner,
    observerRunner: observer.runner,
    lockPid: lock.pid,
    observerPid: observer.pid,
    pidRelationship: lock.pid === observer.pid ? "same" : "different",
    reason,
    locality: "indeterminate",
  };

  if (onIdentityDiagnostic) {
    onIdentityDiagnostic(diagnostic);
    return;
  }

  // This utility is imported by the MCP server, so keep the diagnostic
  // vscode-free. Never include host IDs or owner tokens in the diagnostic.
  // eslint-disable-next-line no-console -- this utility is also used by MCP.
  console.warn("[WorkflowLockInspector] identity diagnostic", diagnostic);
}

export async function readWorkflowLock(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): Promise<WorkflowRunnerLock | null> {
  return readWorkflowLockAtPath(
    WorkflowPaths.runnerLockPath(workspaceRoot, workflowKey)
  );
}

/** Read a runner lock from an already-resolved path for non-workspace stores. */
export async function readWorkflowLockAtPath(
  lockPath: string
): Promise<WorkflowRunnerLock | null> {
  try {
    const content = await fs.promises.readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(content);
    // Keep development upgrades tolerant of locks written before schema v2.
    // A legacy object is still returned for liveness-only callers; callers
    // needing ownership classification pass it through the structured
    // inspector. Reject non-object JSON so callers never dereference null or
    // a primitive as a lock.
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

/**
 * Read a lock as structured liveness evidence for consumers that do not need
 * to interpret ownership. Active locks intentionally carry indeterminate
 * locality because no observer identity was supplied.
 */
export async function readWorkflowLockInspection(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  options: WorkflowLockInspectionOptions = {}
): Promise<WorkflowLockInspection> {
  const lock = await readWorkflowLock(workspaceRoot, workflowKey);
  return inspectWorkflowLockOwnership(lock, undefined, options);
}

/** Inspect a runner lock at an already-resolved path without exposing raw JSON. */
export async function readWorkflowLockInspectionAtPath(
  lockPath: string,
  options: WorkflowLockInspectionOptions = {}
): Promise<WorkflowLockInspection> {
  const lock = await readWorkflowLockAtPath(lockPath);
  return inspectWorkflowLockOwnership(lock, undefined, options);
}

/**
 * Read and classify a lock relative to the supplied observer. Ownership-aware
 * callers use this boundary so raw runner.json parsing stays in this module.
 */
export async function readWorkflowLockOwnershipInspection(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  observer: RunnerHostIdentity | undefined,
  options: WorkflowLockInspectionOptions = {}
): Promise<WorkflowLockInspection> {
  const lock = await readWorkflowLock(workspaceRoot, workflowKey);
  return inspectWorkflowLockOwnership(lock, observer, options);
}

export { isProcessAlive } from "./LockSafetyPrimitives";
