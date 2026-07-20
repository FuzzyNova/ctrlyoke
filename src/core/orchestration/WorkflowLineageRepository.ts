import * as fs from "fs";
import * as path from "path";
import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../../types/CtrlYokeTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { withFileLock } from "../../utils/FileLockUtils";
import { getErrorMessage } from "../../utils/ErrorUtils";

const DESCRIPTOR_SCHEMA_VERSION = 1;

export interface CreatedLineage {
  workflowKey: WorkflowKey;
  descriptor: WorkflowLineageDescriptor;
  draftFilePath: string;
}

export interface AllocatedRun {
  runRef: RunRef;
  runId: number;
  runDir: string;
  runFilePath: string;
  /** True when this is the lineage's first-ever run (a draft is being promoted). */
  isFirstRun: boolean;
  /** The draft file path to remove after the caller finishes writing the new run's definition. */
  draftFilePathToRemove?: string;
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
   * Allocates a new promoted run for `workflowKey`: reserves a `RunRef` (retrying on the
   * astronomically rare directory-name collision), exclusively creates its directory, and
   * advances the descriptor's `latestRunRef`/`nextRunId`/`revision` — all under the lineage's
   * short metadata lock. The caller is responsible for writing the run's `workflow.ctrlyoke.json`
   * (via `WorkingFileManager`) and manifest/events (via `TimelineRecorder`) into `runDir`
   * immediately afterward, and for removing `draftFilePathToRemove` once that write lands.
   */
  async allocateRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<AllocatedRun> {
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceRoot,
      workflowKey
    );

    return withFileLock(descriptorPath, async () => {
      const descriptor = await this.readDescriptor(workspaceRoot, workflowKey);
      const isFirstRun = !descriptor.latestRunRef;

      const maxAttempts = 25;
      let runRef: RunRef | undefined;
      let runDir = "";
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = WorkflowPaths.formatRunRef(Date.now() + attempt);
        const candidateDir = WorkflowPaths.runDir(
          workspaceRoot,
          workflowKey,
          candidate
        );
        try {
          await fs.promises.mkdir(candidateDir);
          runRef = candidate;
          runDir = candidateDir;
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
        latestRunRef: runRef,
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
        runFilePath: WorkflowPaths.runFilePath(
          workspaceRoot,
          workflowKey,
          runRef
        ),
        isFirstRun,
        draftFilePathToRemove: isFirstRun
          ? WorkflowPaths.draftFilePath(workspaceRoot, workflowKey)
          : undefined,
      };
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
