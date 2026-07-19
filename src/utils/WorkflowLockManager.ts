import * as fs from "fs";
import * as path from "path";
import { WorkflowRunnerLock } from "../types/CtrlYokeTypes";
import {
  RUNNER_IDS,
  LOCK_STATUS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PROMPT_TERMINAL_STATUS,
  STEP_STATUS,
} from "../types/DashboardConstants";
import type { LockStatus } from "../types/DashboardConstants";
import { Log } from "./Log";

export type { LockStatus };

/** Heartbeat staleness threshold in milliseconds (30 seconds) */
const STALE_HEARTBEAT_MS = 30_000;

/**
 * WorkflowLockManager
 *
 * Atomic lock file CRUD for workflow process coordination.
 * Lock files live at {queueDir}/{workflowId}.runner.json alongside working files.
 *
 * All writes are atomic: content is written to a .tmp file first, then renamed
 * into place so readers never see a partial file.
 */
export class WorkflowLockManager {
  /**
   * Derive the lock file path from a working file path.
   * "workflow-name.ctrlyoke.json" → "workflow-name.runner.json"
   */
  static getLockPath(workingFilePath: string): string {
    const dir = path.dirname(workingFilePath);
    const base = path
      .basename(workingFilePath)
      .replace(/\.ctrlyoke\.json$/, "");
    return path.join(dir, `${base}.runner.json`);
  }

  /**
   * Acquire a lock by writing the lock file atomically.
   * Writes to a .tmp file first, then renames to the final path.
   */
  static async acquireLock(
    workingFilePath: string,
    lock: WorkflowRunnerLock
  ): Promise<void> {
    const lockPath = WorkflowLockManager.getLockPath(workingFilePath);
    const tmpPath = lockPath + ".tmp";
    await fs.promises.writeFile(tmpPath, JSON.stringify(lock, null, 2), "utf8");
    await fs.promises.rename(tmpPath, lockPath);
    Log.debug(`[WorkflowLockManager] acquireLock: ${path.basename(lockPath)}`);
  }

  /**
   * Release a lock by deleting the lock file.
   * Swallows ENOENT (already deleted is fine).
   */
  static async releaseLock(workingFilePath: string): Promise<void> {
    const lockPath = WorkflowLockManager.getLockPath(workingFilePath);
    try {
      await fs.promises.unlink(lockPath);
      Log.debug(
        `[WorkflowLockManager] releaseLock: ${path.basename(lockPath)}`
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        Log.warn(
          `[WorkflowLockManager] releaseLock: failed to delete ${path.basename(lockPath)}:`,
          err
        );
      }
    }
  }

  /**
   * Update the heartbeat timestamp in the lock file atomically.
   * Reads the existing lock, updates lastHeartbeat, writes atomically.
   * No-ops silently if the lock file is gone (ENOENT).
   */
  static async updateHeartbeat(workingFilePath: string): Promise<void> {
    const lockPath = WorkflowLockManager.getLockPath(workingFilePath);
    try {
      const content = await fs.promises.readFile(lockPath, "utf8");
      const lock = JSON.parse(content) as WorkflowRunnerLock;
      lock.lastHeartbeat = Date.now();
      const tmpPath = lockPath + ".tmp";
      await fs.promises.writeFile(
        tmpPath,
        JSON.stringify(lock, null, 2),
        "utf8"
      );
      await fs.promises.rename(tmpPath, lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        Log.warn(
          `[WorkflowLockManager] updateHeartbeat: failed for ${path.basename(lockPath)}:`,
          err
        );
      }
    }
  }

  /**
   * Read the raw lock data for a given working file.
   * Returns null if the lock file does not exist or cannot be parsed.
   */
  static async readLock(
    workingFilePath: string
  ): Promise<WorkflowRunnerLock | null> {
    const lockPath = WorkflowLockManager.getLockPath(workingFilePath);
    try {
      const content = await fs.promises.readFile(lockPath, "utf8");
      return JSON.parse(content) as WorkflowRunnerLock;
    } catch {
      return null;
    }
  }

  /**
   * Check the status of the lock for a given working file.
   *
   * Returns:
   *   "none"          — no lock file or parse error
   *   "stale"         — lock exists but PID is dead OR heartbeat is older than 30s
   *   "active-vscode" — live VS Code Extension Host holds the lock
   *   "active-cli"    — live CLI process holds the lock
   */
  static async checkLock(workingFilePath: string): Promise<LockStatus> {
    const lockPath = WorkflowLockManager.getLockPath(workingFilePath);
    let lock: WorkflowRunnerLock;
    try {
      const content = await fs.promises.readFile(lockPath, "utf8");
      lock = JSON.parse(content) as WorkflowRunnerLock;
    } catch {
      return LOCK_STATUS.NONE;
    }

    const pidAlive = isPidAlive(lock.pid);
    const heartbeatAge = Date.now() - lock.lastHeartbeat;
    const heartbeatFresh = heartbeatAge <= STALE_HEARTBEAT_MS;

    if (!pidAlive || !heartbeatFresh) {
      Log.debug(
        `[WorkflowLockManager] checkLock: stale — runner="${lock.runner}" pid=${lock.pid} pidAlive=${pidAlive} heartbeatAge=${heartbeatAge}ms fresh=${heartbeatFresh}`
      );
      return LOCK_STATUS.STALE;
    }

    return lock.runner === RUNNER_IDS.CLI
      ? LOCK_STATUS.ACTIVE_CLI
      : LOCK_STATUS.ACTIVE_VSCODE;
  }

  /**
   * Normalize stale locks on extension startup.
   *
   * Scans all *.ctrlyoke.json files in queueDir. For each file whose
   * _runtime.executionState is active (running/pausing/cancelling):
   *   - "none" or "stale" lock  → writes "stopped" to _runtime.executionState,
   *     cleans up any stale lock file
   *   - "active-vscode"         → this shouldn't happen on startup (we just started);
   *     treat as stale and normalize to "stopped"
   *   - "active-cli"            → preserves RUNNING; returns this path as a CLI-managed entry
   *
   * Returns active CLI paths plus files recovered from an interrupted owner.
   */
  static async normalizeStaleLocks(queueDir: string): Promise<{
    activeCliPaths: string[];
    recoveredPaths: string[];
  }> {
    const activeCli: string[] = [];
    const recoveredPaths: string[] = [];

    let entries: string[];
    try {
      entries = await fs.promises.readdir(queueDir);
    } catch {
      return { activeCliPaths: activeCli, recoveredPaths };
    }

    const workingFiles = entries.filter((f) => f.endsWith(".ctrlyoke.json"));

    for (const fileName of workingFiles) {
      const workingFilePath = path.join(queueDir, fileName);
      let workingFile: {
        _runtime?: {
          executionState?: string;
          currentIndex?: number;
          finalStep?: {
            phase?: string;
            status?: string;
            completedAt?: number;
          };
        };
        steps?: Array<{
          _runtime?: {
            startedAt?: number;
            completedAt?: number;
            terminalStatus?: string;
          };
        }>;
        [key: string]: unknown;
      };

      try {
        const content = await fs.promises.readFile(workingFilePath, "utf8");
        workingFile = JSON.parse(content);
      } catch {
        // Race condition: file being written mid-read — skip safely
        continue;
      }

      const executionState = workingFile._runtime?.executionState;
      if (
        executionState !== EXECUTION_STATES.RUNNING &&
        executionState !== EXECUTION_STATES.PAUSING &&
        executionState !== EXECUTION_STATES.CANCELLING
      ) {
        continue;
      }

      const status = await WorkflowLockManager.checkLock(workingFilePath);

      if (status === LOCK_STATUS.ACTIVE_CLI) {
        Log.info(
          `[WorkflowLockManager] normalizeStaleLocks: ${fileName} is active-cli — preserving RUNNING`
        );
        activeCli.push(workingFilePath);
        continue;
      }

      // "none", "stale", or "active-vscode" (we just started — can't be us)
      Log.info(
        `[WorkflowLockManager] normalizeStaleLocks: normalizing ${fileName} from ${executionState} → stopped (lock=${status})`
      );

      // Normalize the working file to "stopped"
      if (workingFile._runtime) {
        workingFile._runtime.executionState = EXECUTION_STATES.STOPPED;
        const currentIndex = workingFile._runtime.currentIndex ?? 0;
        const interruptedStep = workingFile.steps?.[currentIndex];
        if (
          interruptedStep?._runtime?.startedAt &&
          !interruptedStep._runtime.completedAt
        ) {
          const stoppedAt = Date.now();
          interruptedStep._runtime = {
            startedAt: interruptedStep._runtime?.startedAt ?? stoppedAt,
            ...interruptedStep._runtime,
            completedAt: stoppedAt,
            terminalStatus: PROMPT_TERMINAL_STATUS.CANCELLED,
          };
          workingFile._runtime.currentIndex = currentIndex + 1;
        } else if (
          currentIndex >= (workingFile.steps?.length ?? 0) &&
          workingFile._runtime.finalStep?.phase ===
            FINAL_STEP_PHASES.FINAL_STEP &&
          workingFile._runtime.finalStep.status !== STEP_STATUS.COMPLETED
        ) {
          workingFile._runtime.finalStep = {
            ...workingFile._runtime.finalStep,
            status: STEP_STATUS.CANCELLED,
            completedAt: Date.now(),
          };
        }
      }
      try {
        const tmpPath = workingFilePath + ".tmp";
        await fs.promises.writeFile(
          tmpPath,
          JSON.stringify(workingFile, null, 2),
          "utf8"
        );
        await fs.promises.rename(tmpPath, workingFilePath);
        recoveredPaths.push(workingFilePath);
      } catch (writeErr) {
        Log.warn(
          `[WorkflowLockManager] normalizeStaleLocks: failed to normalize ${fileName}:`,
          writeErr
        );
      }

      // Clean up any stale lock file
      await WorkflowLockManager.releaseLock(workingFilePath);
    }

    return { activeCliPaths: activeCli, recoveredPaths };
  }
}

/**
 * Check if a process is alive using signal 0.
 *
 * - Returns true if the process exists (alive or EPERM = alive but different user)
 * - Returns false if ESRCH (no such process — dead)
 * - Works on Windows via Node.js's OpenProcess emulation
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = process exists but caller lacks permission → alive
    // ESRCH = no such process → dead
    return code === "EPERM";
  }
}
