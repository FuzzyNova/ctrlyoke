import * as crypto from "crypto";

/** Shared heartbeat cadence for process-owned coordination records. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** A coordination record is reclaimable after this much heartbeat silence. */
export const STALE_HEARTBEAT_MS = 30_000;

/** Generate a fresh token for an owner of a coordination record. */
export function generateOwnerToken(): string {
  return crypto.randomUUID();
}

/** Return whether a heartbeat has exceeded the shared staleness threshold. */
export function isHeartbeatStale(
  lastHeartbeat: number,
  now = Date.now()
): boolean {
  return now - lastHeartbeat > STALE_HEARTBEAT_MS;
}

/** Check process ownership without making a dead PID assumption. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Shared stale-owner rule used by runner locks and execution leases. */
export function isOwnerStale(
  pid: number,
  lastHeartbeat: number,
  now = Date.now()
): boolean {
  return !isProcessAlive(pid) || isHeartbeatStale(lastHeartbeat, now);
}
