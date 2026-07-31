import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { writeFileAtomic } from "../../../utils/AtomicFileUtils";
import { withFileLock } from "../../../utils/FileLockUtils";
import { AsyncMutex } from "./AsyncMutex";

export interface QwenTrustedHooksTrackerOptions {
  /** Override the global trust file path, primarily for unit tests. */
  trustedHooksPath?: string;
}

type TrustedHooksFile = Record<string, unknown>;

/**
 * Tracks Qwen's global trusted hook keys.
 *
 * Qwen treats this file as a persistent approval store. Consequently, trust
 * keys registered by ctrlyoke are intentionally retained after a workflow
 * unregisters: removing them would revoke a user's Qwen approval and would
 * make the next run prompt again. The tracker still reference-counts only
 * ctrlyoke-owned keys by workflow key so registration is idempotent and the
 * active ownership state is explicit. Existing keys, including user-added
 * keys, are never removed.
 *
 * Every read-modify-write is protected by both the in-host mutex and the
 * cross-process lock. Writes use atomic replacement so another Qwen process
 * observes either the old or the complete new JSON document.
 */
export class QwenTrustedHooksTracker {
  private static instance: QwenTrustedHooksTracker | undefined;

  static getInstance(
    options?: QwenTrustedHooksTrackerOptions
  ): QwenTrustedHooksTracker {
    if (!this.instance) {
      this.instance = new QwenTrustedHooksTracker(options);
    }
    return this.instance;
  }

  /** Reset tracker state. Intended for tests only. */
  static resetAll(): void {
    this.instance = undefined;
  }

  private readonly trustedHooksPath: string;
  private readonly mutex = new AsyncMutex();
  private readonly workflowKeys = new Map<string, Set<string>>();
  private readonly references = new Map<string, number>();

  private constructor(options?: QwenTrustedHooksTrackerOptions) {
    this.trustedHooksPath =
      options?.trustedHooksPath ??
      path.join(os.homedir(), ".qwen", "trusted_hooks.json");
  }

  /**
   * Add trust keys for one workflow. Re-registering a workflow replaces its
   * tracked ctrlyoke keys instead of incrementing them a second time.
   * Additional keys are user-hook trust keys and are persisted but not owned
   * by ctrlyoke for reference-counting purposes.
   */
  async registerWorkflow(
    workflowKey: string,
    workspaceRoot: string,
    ctrlyokeKeys: string[],
    additionalKeys: string[] = []
  ): Promise<void> {
    await this.withLock(async () => {
      const nextKeys = new Set(ctrlyokeKeys);
      const previousKeys = this.workflowKeys.get(workflowKey) ?? new Set();

      await fs.mkdir(path.dirname(this.trustedHooksPath), { recursive: true });
      await withFileLock(this.trustedHooksPath, async () => {
        const trustedHooks = await this.readTrustedHooks();
        const existingWorkspaceEntries = trustedHooks[workspaceRoot];
        if (
          existingWorkspaceEntries !== undefined &&
          !Array.isArray(existingWorkspaceEntries)
        ) {
          throw new Error(
            `Invalid Qwen trusted hooks entry for workspace: ${workspaceRoot}`
          );
        }

        const workspaceEntries = Array.isArray(existingWorkspaceEntries)
          ? [...existingWorkspaceEntries]
          : [];
        for (const key of [...nextKeys, ...additionalKeys]) {
          if (!workspaceEntries.includes(key)) {
            workspaceEntries.push(key);
          }
        }
        trustedHooks[workspaceRoot] = workspaceEntries;
        await writeFileAtomic(
          this.trustedHooksPath,
          JSON.stringify(trustedHooks, null, 2)
        );
      });

      for (const key of previousKeys) {
        this.decrementReference(key);
      }
      for (const key of nextKeys) {
        this.references.set(key, (this.references.get(key) ?? 0) + 1);
      }
      this.workflowKeys.set(workflowKey, nextKeys);
    });
  }

  /**
   * Release a workflow's in-memory ownership. Persistent Qwen trust entries
   * remain in the file by design; no read or write is needed during cleanup.
   */
  async unregisterWorkflow(workflowKey: string): Promise<void> {
    await this.withLock(async () => {
      const keys = this.workflowKeys.get(workflowKey);
      if (!keys) {
        return;
      }
      for (const key of keys) {
        this.decrementReference(key);
      }
      this.workflowKeys.delete(workflowKey);
    });
  }

  getActiveWorkflowCount(): number {
    return this.workflowKeys.size;
  }

  getReferenceCount(key: string): number {
    return this.references.get(key) ?? 0;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.mutex.acquire();
    try {
      return await fn();
    } finally {
      this.mutex.release();
    }
  }

  private async readTrustedHooks(): Promise<TrustedHooksFile> {
    try {
      const content = await fs.readFile(this.trustedHooksPath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("root must be an object");
      }
      return parsed as TrustedHooksFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid Qwen trusted hooks JSON: ${error.message}`);
      }
      throw error;
    }
  }

  private decrementReference(key: string): void {
    const count = (this.references.get(key) ?? 1) - 1;
    if (count <= 0) {
      this.references.delete(key);
    } else {
      this.references.set(key, count);
    }
  }
}
