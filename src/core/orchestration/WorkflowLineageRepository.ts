import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type {
  RunRef,
  WorkflowRunAddress,
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../../types/CtrlYokeTypes";
import { isWorkflowRunAddress } from "../../types/CtrlYokeTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { withFileLock } from "../../utils/FileLockUtils";
import { getErrorMessage } from "../../utils/ErrorUtils";

const DESCRIPTOR_SCHEMA_VERSION = 1;
/** How long a `.creating-*` staging dir can go without a new write before `pruneStaleStagingDirs` removes it. */
const STALE_STAGING_DIR_MS = 5 * 60 * 1000;

export interface CreatedLineage {
  workflowKey: WorkflowKey;
  descriptor: WorkflowLineageDescriptor;
  draftFilePath: string;
}

export interface AllocatedRun {
  runRef: RunRef;
  runId: number;
  /** Hidden directory used while the three run artifacts are being written. */
  stagingRunDir: string;
  stagingRunFilePath: string;
  /** Final public directory. It does not exist until `finalizeAllocatedRun`. */
  runDir: string;
  runFilePath: string;
  /** Descriptor revision written while reserving this run ID. */
  reservationDescriptorRevision: number;
  /** True when this is the lineage's first-ever run (a draft is being promoted). */
  isFirstRun: boolean;
  /** The draft file path to remove after the caller finishes writing the new run's definition. */
  draftFilePathToRemove?: string;
}

export interface DeletedRun {
  /** Run refs still present after the deletion, newest first. */
  remainingRunRefs: RunRef[];
  /** The descriptor revision after its repair write. */
  descriptorRevision: number;
}

/**
 * Owns everything about a workflow lineage that has no pre-existing single owner: the
 * `workflow.json` descriptor, `WorkflowKey` allocation, and `RunRef` allocation/promotion.
 *
 * `WorkingFileManager` remains the only writer of run/draft `workflow.ctrlyoke.json` content;
 * `TimelineRecorder` remains the only writer of `manifest.json`/`events.jsonl`. This repository
 * only creates/renames directories and reads/writes the descriptor — it never writes those
 * other files' content itself.
 */
export class WorkflowLineageRepository {
  /**
   * Allocates a new lineage: mints a `WorkflowKey` (exclusive directory create with
   * collision retry), writes the initial descriptor, and ensures the draft directory
   * exists. The draft's `workflow.ctrlyoke.json` content itself is written by the caller
   * through `WorkingFileManager`.
   */
  async createLineage(
    workspaceRoot: string,
    nameHint: string,
    workflowName: string,
    originalFile?: string
  ): Promise<CreatedLineage> {
    const workflowKey = await WorkflowPaths.allocateWorkflowKey(
      workspaceRoot,
      nameHint
    );

    const now = Date.now();
    const descriptor: WorkflowLineageDescriptor = {
      schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
      workflowKey,
      workflowName,
      ...(originalFile ? { originalFile } : {}),
      isFavorite: false,
      createdAt: now,
      lastModifiedAt: now,
      nextRunId: 1,
      revision: 1,
    };

    await this.writeDescriptorDirect(workspaceRoot, workflowKey, descriptor);
    await fs.promises.mkdir(
      WorkflowPaths.draftDir(workspaceRoot, workflowKey),
      { recursive: true }
    );

    return {
      workflowKey,
      descriptor,
      draftFilePath: WorkflowPaths.draftFilePath(workspaceRoot, workflowKey),
    };
  }

  async readDescriptor(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<WorkflowLineageDescriptor> {
    const content = await fs.promises.readFile(
      WorkflowPaths.descriptorPath(workspaceRoot, workflowKey),
      "utf8"
    );
    return JSON.parse(content) as WorkflowLineageDescriptor;
  }

  async tryReadDescriptor(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<WorkflowLineageDescriptor | undefined> {
    try {
      return await this.readDescriptor(workspaceRoot, workflowKey);
    } catch {
      return undefined;
    }
  }

  /**
   * Reserves a RunRef and a monotonic display ID in a hidden staging directory.  The
   * public run directory and `latestRunRef` are deliberately not published here: callers
   * must first write workflow.json, manifest.json, and events.jsonl, then call
   * `finalizeAllocatedRun`.  This is what makes a promoted run atomically visible as a
   * complete three-artifact unit.
   */
  async allocateRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    expectedDescriptorRevision?: number
  ): Promise<AllocatedRun> {
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );

    return withFileLock(descriptorPath, async () => {
      const descriptor = await this.readDescriptor(workspaceRoot, workflowKey);
      if (
        expectedDescriptorRevision !== undefined &&
        descriptor.revision !== expectedDescriptorRevision
      ) {
        throw new Error(
          `Descriptor revision conflict: expected ${expectedDescriptorRevision}, found ${descriptor.revision}`
        );
      }
      const isFirstRun = !descriptor.latestRunRef;

      const maxAttempts = 25;
      let runRef: RunRef | undefined;
      let runDir = "";
      let stagingRunDir = "";
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = WorkflowPaths.formatRunRef(Date.now() + attempt);
        const candidateDir = WorkflowPaths.runDir(
          workspaceRoot,
          workflowKey,
          candidate
        );
        try {
          await fs.promises.access(candidateDir);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        try {
          const candidateStagingDir = WorkflowPaths.stagingRunDir(
            workspaceRoot,
            workflowKey,
            `${candidate}-${crypto.randomUUID()}`
          );
          await fs.promises.mkdir(candidateStagingDir);
          runRef = candidate;
          runDir = candidateDir;
          stagingRunDir = candidateStagingDir;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
        }
      }
      if (!runRef) {
        throw new Error(
          `Failed to allocate a unique runRef for lineage "${workflowKey}" after ${maxAttempts} attempts`
        );
      }

      const runId = descriptor.nextRunId;
      const updatedDescriptor: WorkflowLineageDescriptor = {
        ...descriptor,
        nextRunId: descriptor.nextRunId + 1,
        lastModifiedAt: Date.now(),
        revision: descriptor.revision + 1,
      };
      await this.writeDescriptorDirect(
        workspaceRoot,
        workflowKey,
        updatedDescriptor
      );

      return {
        runRef,
        runId,
        runDir,
        stagingRunDir,
        stagingRunFilePath: path.join(
          stagingRunDir,
          WorkflowPaths.WORKING_FILE_NAME
        ),
        runFilePath: WorkflowPaths.runFilePath(
          workspaceRoot,
          workflowKey,
          runRef
        ),
        reservationDescriptorRevision: updatedDescriptor.revision,
        isFirstRun,
        draftFilePathToRemove: isFirstRun
          ? WorkflowPaths.draftFilePath(workspaceRoot, workflowKey)
          : undefined,
      };
    });
  }

  /**
   * Publishes a fully initialized staged run.  The final rename happens before the
   * descriptor hint is updated, so a crash can at worst leave an independently
   * discoverable complete run; it can never expose a partial one.
   */
  async finalizeAllocatedRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    allocation: AllocatedRun
  ): Promise<void> {
    const requiredFiles = [
      allocation.stagingRunFilePath,
      path.join(allocation.stagingRunDir, "manifest.json"),
      path.join(allocation.stagingRunDir, "events.jsonl"),
    ];
    for (const requiredFile of requiredFiles) {
      const stat = await fs.promises.lstat(requiredFile);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Cannot publish a run without all required artifacts");
      }
    }

    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    await withFileLock(descriptorPath, async () => {
      const descriptor = await this.readDescriptor(workspaceRoot, workflowKey);
      if (descriptor.revision !== allocation.reservationDescriptorRevision) {
        throw new Error(
          `Descriptor revision conflict while publishing run: expected ${allocation.reservationDescriptorRevision}, found ${descriptor.revision}`
        );
      }
      try {
        await fs.promises.rename(allocation.stagingRunDir, allocation.runDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(
            `Run ref collision while publishing ${allocation.runRef}`
          );
        }
        throw error;
      }
      await this.writeDescriptorDirect(workspaceRoot, workflowKey, {
        ...descriptor,
        latestRunRef: allocation.runRef,
        lastModifiedAt: Date.now(),
        // Allocation already advanced the optimistic revision while reserving the
        // monotonic run ID. Publishing completes that same transaction; exposing a
        // second revision would invalidate a client that only observed one run create.
        revision: descriptor.revision,
      });
    });
  }

  /**
   * Removes one promoted run while holding the lineage metadata lock and repairs
   * the descriptor's cache-like latest-run hint. Callers supply every run that
   * is temporarily in use by their operation; the durable pending-rewind target
   * is always protected here as well.
   */
  async deleteRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    protectedRunRefs: ReadonlySet<RunRef> = new Set()
  ): Promise<DeletedRun> {
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    return withFileLock(descriptorPath, async () => {
      const descriptor = await this.readDescriptor(workspaceRoot, workflowKey);
      const protectedByPendingRewind =
        descriptor.pendingEdit?.kind === "rewind" &&
        descriptor.pendingEdit.runRef === runRef;
      if (protectedByPendingRewind || protectedRunRefs.has(runRef)) {
        throw new Error("Cannot delete a protected run");
      }
      if (
        await this.isReferencedAsPriorContext(
          workspaceRoot,
          workflowKey,
          runRef
        )
      ) {
        throw new Error(
          "Cannot delete a run that is selected as prior context by another workflow"
        );
      }

      const runDir = WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef);
      try {
        await fs.promises.rm(runDir, { recursive: true, force: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        throw new Error(
          `Run ${runRef} does not exist for workflow ${workflowKey}`
        );
      }

      const remainingRunRefs = await this.listRunRefs(
        workspaceRoot,
        workflowKey
      );
      const latestRunRef = remainingRunRefs[0];
      const updated: WorkflowLineageDescriptor = {
        ...descriptor,
        latestRunRef,
        lastModifiedAt: Date.now(),
        revision: descriptor.revision + 1,
      };
      await this.writeDescriptorDirect(workspaceRoot, workflowKey, updated);
      return { remainingRunRefs, descriptorRevision: updated.revision };
    });
  }

  /** Marks `isFavorite` and/or bumps `lastModifiedAt` without allocating anything. */
  async updateDescriptor(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    mutate: (descriptor: WorkflowLineageDescriptor) => WorkflowLineageDescriptor
  ): Promise<WorkflowLineageDescriptor> {
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    return withFileLock(descriptorPath, async () => {
      const descriptor = await this.readDescriptor(workspaceRoot, workflowKey);
      const updated: WorkflowLineageDescriptor = {
        ...mutate(descriptor),
        lastModifiedAt: Date.now(),
        revision: descriptor.revision + 1,
      };
      await this.writeDescriptorDirect(workspaceRoot, workflowKey, updated);
      return updated;
    });
  }

  /**
   * Runs a short lineage mutation while holding the descriptor lock. The caller may
   * persist a coupled working-file change in `mutate`; this repository remains the
   * sole descriptor writer. `expectedRevision` makes client-side descriptor views
   * optimistic rather than silently overwriting another client's draft preparation.
   */
  async mutateDescriptorAtRevision<T>(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    expectedRevision: number,
    mutate: (
      descriptor: WorkflowLineageDescriptor
    ) => Promise<{ value: T; descriptor: WorkflowLineageDescriptor }>
  ): Promise<T> {
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    return withFileLock(descriptorPath, async () => {
      const descriptor = await this.readDescriptor(workspaceRoot, workflowKey);
      if (descriptor.revision !== expectedRevision) {
        throw new Error(
          `Descriptor revision conflict: expected ${expectedRevision}, found ${descriptor.revision}`
        );
      }
      const result = await mutate(descriptor);
      const updated = {
        ...result.descriptor,
        lastModifiedAt: Date.now(),
        revision: descriptor.revision + 1,
      };
      await this.writeDescriptorDirect(workspaceRoot, workflowKey, updated);
      return result.value;
    });
  }

  /** Lists every valid lineage directory's `WorkflowKey` directly under `.runs/`. */
  async listLineageKeys(workspaceRoot: string): Promise<WorkflowKey[]> {
    const root = WorkflowPaths.runsRoot(workspaceRoot);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => WorkflowPaths.isLineageDirEntry(entry))
      .map((entry) => entry.name as WorkflowKey);
  }

  /** Lists valid promoted run directories newest first. */
  private async listRunRefs(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<RunRef[]> {
    try {
      const entries = await fs.promises.readdir(
        WorkflowPaths.lineageDir(workspaceRoot, workflowKey),
        { withFileTypes: true }
      );
      return entries
        .filter((entry) => WorkflowPaths.isRunDirEntry(entry))
        .map((entry) => entry.name as RunRef)
        .sort(
          (left, right) =>
            (WorkflowPaths.parseRunRefTimestamp(right) ?? 0) -
            (WorkflowPaths.parseRunRefTimestamp(left) ?? 0)
        );
    } catch {
      return [];
    }
  }

  /**
   * Removes `.creating-*` staging directories left behind when an `allocateRun` never
   * reached `finalizeAllocatedRun` (crash, disk full, a thrown validation error before
   * publishing) — otherwise they accumulate forever, since nothing else lists, counts,
   * or surfaces them. Only removes directories whose last write is older than
   * `STALE_STAGING_DIR_MS`, so this never races a legitimate in-flight allocation (which
   * normally publishes within milliseconds of creation).
   */
  async pruneStaleStagingDirs(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<void> {
    const lineageDir = WorkflowPaths.lineageDir(workspaceRoot, workflowKey);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(lineageDir, { withFileTypes: true });
    } catch {
      return;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (!WorkflowPaths.isStagingDirEntry(entry)) {
        continue;
      }
      const dir = path.join(lineageDir, entry.name);
      try {
        const stat = await fs.promises.stat(dir);
        if (now - stat.mtimeMs < STALE_STAGING_DIR_MS) {
          continue;
        }
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (error) {
        // console.warn (not Log) — this module is imported by mcp-server.ts, which has no vscode logging infrastructure.
        console.warn(
          `[WorkflowLineageRepository] Failed to prune stale staging dir ${dir}: ${getErrorMessage(error)}`
        );
      }
    }
  }

  /**
   * Source addresses are durable dependencies. Scan only known working-file
   * locations and never follow a link while deciding whether deletion is safe.
   */
  private async isReferencedAsPriorContext(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<boolean> {
    for (const key of await this.listLineageKeys(workspaceRoot)) {
      const files = [
        WorkflowPaths.draftFilePath(workspaceRoot, key),
        ...(await this.listRunRefs(workspaceRoot, key)).map((candidate) =>
          WorkflowPaths.runFilePath(workspaceRoot, key, candidate)
        ),
      ];
      for (const filePath of files) {
        try {
          const stat = await fs.promises.lstat(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const parsed = JSON.parse(
            await fs.promises.readFile(filePath, "utf8")
          ) as {
            priorContext?: unknown;
            steps?: Array<{ priorContext?: unknown }>;
            finalStep?: { priorContext?: unknown };
          };
          const contexts = [
            parsed.priorContext,
            ...(parsed.steps ?? []).map((step) => step.priorContext),
            parsed.finalStep?.priorContext,
          ];
          if (
            contexts.some((context) => {
              const address = isWorkflowRunAddress(
                context as import("../../types/CtrlYokeTypes").PriorContext
              )
                ? (context as WorkflowRunAddress)
                : undefined;
              return (
                address !== undefined &&
                address.workflowKey === workflowKey &&
                address.runRef === runRef
              );
            })
          ) {
            return true;
          }
        } catch {
          // Malformed or concurrently removed files cannot authorize deletion.
        }
      }
    }
    return false;
  }

  private async writeDescriptorDirect(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    descriptor: WorkflowLineageDescriptor
  ): Promise<void> {
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );
    await fs.promises.mkdir(path.dirname(descriptorPath), {
      recursive: true,
    });
    const tempPath = `${descriptorPath}.tmp`;
    try {
      await fs.promises.writeFile(
        tempPath,
        JSON.stringify(descriptor, null, 2),
        "utf8"
      );
      await fs.promises.rename(tempPath, descriptorPath);
    } catch (error) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // best-effort cleanup
      }
      // console.warn (not Log) — this module is imported by mcp-server.ts, which has no vscode logging infrastructure.
      console.warn(
        `[WorkflowLineageRepository] Failed to write descriptor for ${workflowKey}: ${getErrorMessage(error)}`
      );
      throw error;
    }
  }
}
