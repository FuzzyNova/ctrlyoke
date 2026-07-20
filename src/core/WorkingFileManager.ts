import * as fs from "fs/promises";
import type {
  RunRef,
  WorkflowKey,
  WorkflowStep,
  WorkingFile,
} from "../types/CtrlYokeTypes";
import type { FinalStepRuntimeState } from "../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  HARNESS_IDS,
  type HarnessId,
} from "../types/DashboardConstants";
import type { ExecutionState } from "../types/DashboardConstants";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { withFileLock } from "../utils/FileLockUtils";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import {
  stripStepRuntime,
  stripViewOnlyWorkflowStepFields,
} from "./WorkflowStepSanitizer";
import { WorkflowLineageRepository } from "./orchestration/WorkflowLineageRepository";

/**
 * Read a working file straight off disk. Free function (rather than an instance method)
 * so `WorkingFileManager.seedNewRun` can read an arbitrary run's file — one that may not
 * be the one currently loaded into any live queue — without needing an `IWorkingFileQueueAccess`.
 */
async function readWorkingFileFromDisk(
  workingFilePath: string
): Promise<WorkingFile> {
  try {
    const content = await fs.readFile(workingFilePath, "utf-8");
    return JSON.parse(content) as WorkingFile;
  } catch (error) {
    throw new Error(`Failed to read working file: ${getErrorMessage(error)}`);
  }
}

/** Write a working file atomically (temp + rename), optionally under `withFileLock`. */
async function writeWorkingFileAtomicTo(
  workingFilePath: string,
  workingFile: WorkingFile,
  options: { skipLock?: boolean } = {}
): Promise<void> {
  const tempPath = `${workingFilePath}.tmp`;

  const writeAction = async () => {
    try {
      await fs.writeFile(tempPath, JSON.stringify(workingFile, null, 2));
      await fs.rename(tempPath, workingFilePath);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {}

      throw new Error(
        `Failed to write working file: ${getErrorMessage(error)}`
      );
    }
  };

  if (options.skipLock) {
    await writeAction();
    return;
  }

  await withFileLock(workingFilePath, writeAction);
}

/** Atomically writes an opaque snapshot without reserializing its JSON bytes. */
async function writeSnapshotAtomic(
  snapshotPath: string,
  content: Buffer
): Promise<void> {
  const tempPath = `${snapshotPath}.tmp`;
  try {
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, snapshotPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw new Error(
      `Failed to write pending rewind snapshot: ${getErrorMessage(error)}`
    );
  }
}

/**
 * Interface providing queue state access for working file persistence operations.
 * Implemented as an adapter by PromptQueue to decouple file I/O from queue state management.
 */
export interface IWorkingFileQueueAccess {
  /** The current working file path, if any */
  getWorkingFilePath(): string | undefined;

  /** Current steps in the queue */
  getSteps(): WorkflowStep[];

  /** Current execution index */
  getCurrentIndex(): number;

  /** Current execution status */
  getStatus(): ExecutionState;

  /** Current in-memory definition revision counter (see `WorkingFile.definitionRevision`) */
  getDefinitionRevision(): number;

  /** Reconcile the in-memory definition revision counter after a disk-authoritative write. */
  setDefinitionRevision(revision: number): void;

  /** Current workflow name */
  getWorkflowName(): string | undefined;

  /** Merge disk steps into memory, returning newly added steps */
  mergeDiskSteps(diskSteps: WorkflowStep[]): WorkflowStep[];

  /** Emit state change notification to listeners */
  emitStateChange(): void;

  /** Runtime metadata for workflow-level finalStep execution */
  getFinalStepRuntime(): FinalStepRuntimeState | undefined;

  /** Durable same-run rewind marker, when the queue is editing a suffix. */
  getPendingRewind?():
    | { fromStepIndex: number; baseDefinitionRevision: number }
    | undefined;

  /** Update a workflow property in cached workflow file */
  updateWorkflowProperty(key: string, value: unknown): void;
}

/**
 * Manages run/draft working file (.ctrlyoke/.runs/<workflowKey>/{draft,run-<ts>}/workflow.ctrlyoke.json) persistence.
 *
 * Extracted from PromptQueue to separate file I/O concerns from queue state management.
 * All serialized operations go through an internal operation queue to prevent races.
 *
 * The class accesses queue state through the IWorkingFileQueueAccess interface,
 * allowing PromptQueue to remain the single owner of queue state while this class
 * handles only persistence.
 */
export class WorkingFileManager {
  private operationQueue: Promise<void> = Promise.resolve();
  private expectedDefinitionRevision: number | undefined;
  private readonly lineageRepository: WorkflowLineageRepository;

  constructor(
    private readonly queueAccess: IWorkingFileQueueAccess,
    lineageRepository?: WorkflowLineageRepository
  ) {
    this.lineageRepository =
      lineageRepository ?? new WorkflowLineageRepository();
  }

  /**
   * Forks an immutable promoted run into the lineage's one mutable draft. This
   * holds the descriptor lock across the source revision check, draft write, and
   * pending-edit update so a second client cannot redirect or overwrite it.
   */
  public static async seedDraftFromRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    fromRunRef: RunRef,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<{
    workingFilePath: string;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    const draftFilePath = WorkflowPaths.draftFilePath(
      workspaceFolderPath,
      workflowKey
    );
    return lineageRepository.mutateDescriptorAtRevision(
      workspaceFolderPath,
      workflowKey,
      expectedDescriptorRevision,
      async (descriptor) => {
        if (descriptor.pendingEdit) {
          throw new Error(
            "A draft or continuation is already being prepared for this workflow"
          );
        }
        const source = await readWorkingFileFromDisk(
          WorkflowPaths.runFilePath(
            workspaceFolderPath,
            workflowKey,
            fromRunRef
          )
        );
        const sourceRevision = source.definitionRevision ?? 1;
        if (sourceRevision !== expectedDefinitionRevision) {
          throw new Error(
            `Definition revision conflict: expected ${expectedDefinitionRevision}, found ${sourceRevision}`
          );
        }

        const now = Date.now();
        const draft: WorkingFile = {
          ...source,
          ...(descriptor.originalFile
            ? { originalFile: descriptor.originalFile }
            : {}),
          workflowName: source.workflowName ?? descriptor.workflowName,
          startedAt: now,
          lastModifiedAt: now,
          isFavorite: descriptor.isFavorite,
          definitionRevision: sourceRevision,
          steps: stripStepRuntime(source.steps ?? []).map(
            stripViewOnlyWorkflowStepFields
          ),
          ...(source.finalStep
            ? {
                finalStep: stripViewOnlyWorkflowStepFields(
                  stripStepRuntime([source.finalStep])[0]
                ),
              }
            : {}),
          _runtime: {
            currentIndex: 0,
            executionState: EXECUTION_STATES.IDLE,
          },
        };
        await fs.mkdir(
          WorkflowPaths.draftDir(workspaceFolderPath, workflowKey),
          {
            recursive: true,
          }
        );
        await writeWorkingFileAtomicTo(draftFilePath, draft);

        return {
          value: {
            workingFilePath: draftFilePath,
            definitionRevision: sourceRevision,
            descriptorRevision: expectedDescriptorRevision + 1,
          },
          descriptor: { ...descriptor, pendingEdit: { kind: "draft" } },
        };
      }
    );
  }

  // ==================== Pure File Operations ====================

  /**
   * Read working file from disk
   * @param workingFilePath Path to working file
   * @returns Parsed working file
   */
  public async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return readWorkingFileFromDisk(workingFilePath);
  }

  /** Applies to the next definition write only; runtime persistence remains unguarded. */
  public expectDefinitionRevision(revision: number): void {
    this.expectedDefinitionRevision = revision;
  }

  private assertExpectedDefinitionRevision(workingFile: WorkingFile): void {
    if (this.expectedDefinitionRevision === undefined) {
      return;
    }
    const actual = workingFile.definitionRevision ?? 1;
    if (actual !== this.expectedDefinitionRevision) {
      throw new Error(
        `Definition revision conflict: expected ${this.expectedDefinitionRevision}, found ${actual}`
      );
    }
  }

  private consumeExpectedDefinitionRevision(): void {
    this.expectedDefinitionRevision = undefined;
  }

  /**
   * Write working file atomically (temp + rename)
   * @param workingFilePath Path to working file
   * @param workingFile Working file data
   */
  private async writeWorkingFileAtomic(
    workingFilePath: string,
    workingFile: WorkingFile,
    options: { skipLock?: boolean } = {}
  ): Promise<void> {
    return writeWorkingFileAtomicTo(workingFilePath, workingFile, options);
  }

  // ==================== Higher-Level Operations ====================

  /**
   * Create a new lineage and its mutable draft working file, ahead of the lineage's
   * first execution.
   * @param nameForFile Display name or file path used to generate the lineage's WorkflowKey
   * @param steps Steps to store in the draft
   * @param workspaceFolder Current workspace folder
   * @param workflowName Computed workflow name for the working file
   * @param originalFilePath The true source file path (if any). Only set for file-based workflows;
   *   leave undefined for ephemeral/dashboard-created workflows so the save dialog defaults correctly.
   * @returns The draft's path and the lineage's new WorkflowKey
   */
  public async createWorkingFile(
    nameForFile: string,
    steps: WorkflowStep[],
    workspaceFolderPath: string,
    workflowName: string,
    originalFilePath?: string
  ): Promise<{ workingFilePath: string; workflowKey: WorkflowKey }> {
    const { workflowKey, draftFilePath } =
      await this.lineageRepository.createLineage(
        workspaceFolderPath,
        nameForFile,
        workflowName,
        originalFilePath
      );

    const workingFile: WorkingFile = {
      ...(originalFilePath ? { originalFile: originalFilePath } : {}),
      workflowName,
      startedAt: Date.now(),
      lastModifiedAt: Date.now(),
      definitionRevision: 1,
      steps: steps.map(stripViewOnlyWorkflowStepFields),
      _runtime: {
        currentIndex: 0,
        executionState: EXECUTION_STATES.IDLE,
      },
    };

    // Write atomically (temp + rename)
    await this.writeWorkingFileAtomic(draftFilePath, workingFile);

    Log.info(` Created draft working file: ${draftFilePath}`);
    return { workingFilePath: draftFilePath, workflowKey };
  }

  /**
   * Promotes the lineage's current definition (the draft, or the previous run if one
   * already exists) into a freshly allocated run, using the queue's CURRENT in-memory
   * state as the new run's starting definition/runtime. This is the moment a "fresh
   * execution start" (not continue/append/idle-continuation) mints a new `RunRef` —
   * mirroring the pre-refactor behavior where every such start created a new history run
   * while the single working file kept being reused.
   */
  public async promoteToNewRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    startedAt: number
  ): Promise<{
    workingFilePath: string;
    runRef: RunRef;
    runId: number;
    runDir: string;
  }> {
    const allocation = await this.lineageRepository.allocateRun(
      workspaceFolderPath,
      workflowKey
    );
    const descriptor = await this.lineageRepository.readDescriptor(
      workspaceFolderPath,
      workflowKey
    );

    const finalStepRuntime = this.queueAccess.getFinalStepRuntime();
    const workingFile: WorkingFile = {
      ...(descriptor.originalFile
        ? { originalFile: descriptor.originalFile }
        : {}),
      workflowName:
        this.queueAccess.getWorkflowName() ?? descriptor.workflowName,
      startedAt,
      lastModifiedAt: startedAt,
      isFavorite: descriptor.isFavorite,
      definitionRevision: 1,
      steps: this.queueAccess.getSteps().map(stripViewOnlyWorkflowStepFields),
      _runtime: {
        currentIndex: this.queueAccess.getCurrentIndex(),
        executionState: this.queueAccess.getStatus(),
        ...(finalStepRuntime ? { finalStep: finalStepRuntime } : {}),
      },
    };

    await this.writeWorkingFileAtomic(allocation.runFilePath, workingFile);

    if (allocation.draftFilePathToRemove) {
      await fs
        .rm(allocation.draftFilePathToRemove, { force: true })
        .catch((error) =>
          Log.warn(
            `[WorkingFileManager] Failed to remove promoted draft: ${getErrorMessage(error)}`
          )
        );
    }

    Log.info(
      ` Promoted lineage ${workflowKey} to new run ${allocation.runRef}`
    );
    return {
      workingFilePath: allocation.runFilePath,
      runRef: allocation.runRef,
      runId: allocation.runId,
      runDir: allocation.runDir,
    };
  }

  /**
   * Seeds a brand-new run from an existing run's *persisted* definition (Re-run / CLI
   * `rerun`). Unlike `promoteToNewRun`, this never reads a live queue's in-memory state —
   * `fromRunRef` may not be the run currently loaded into any queue (the lineage can be
   * idle while a client views/re-runs an older run), so the source definition is read
   * straight off disk. Strips all execution runtime (workflow-level `_runtime` and every
   * step's `_runtime`) so the new run starts fresh, applies optional harness/model
   * overrides, and leaves `fromRunRef`'s own file byte-for-byte untouched.
   *
   * Static because it has no per-queue state to coordinate with — the destination run
   * is brand new and nothing is currently writing to it.
   */
  public static async seedNewRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    fromRunRef: RunRef,
    overrides: { harness?: HarnessId; model?: string } = {},
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    expected?: {
      definitionRevision?: number;
      descriptorRevision?: number;
    }
  ): Promise<{
    workingFilePath: string;
    runRef: RunRef;
    runId: number;
    runDir: string;
    startedAt: number;
  }> {
    const sourceFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      fromRunRef
    );
    const source = await readWorkingFileFromDisk(sourceFilePath);
    const sourceRevision = source.definitionRevision ?? 1;
    if (
      expected?.definitionRevision !== undefined &&
      sourceRevision !== expected.definitionRevision
    ) {
      throw new Error(
        `Definition revision conflict: expected ${expected.definitionRevision}, found ${sourceRevision}`
      );
    }

    const sourceDescriptor = await lineageRepository.readDescriptor(
      workspaceFolderPath,
      workflowKey
    );
    if (sourceDescriptor.pendingEdit) {
      throw new Error(
        "A draft or continuation is already being prepared for this workflow"
      );
    }
    if (
      expected?.descriptorRevision !== undefined &&
      sourceDescriptor.revision !== expected.descriptorRevision
    ) {
      throw new Error(
        `Descriptor revision conflict: expected ${expected.descriptorRevision}, found ${sourceDescriptor.revision}`
      );
    }

    const allocation = await lineageRepository.allocateRun(
      workspaceFolderPath,
      workflowKey,
      sourceDescriptor.revision
    );
    const descriptor = await lineageRepository.readDescriptor(
      workspaceFolderPath,
      workflowKey
    );

    const startedAt = Date.now();
    const workingFile: WorkingFile = {
      ...source,
      ...(descriptor.originalFile
        ? { originalFile: descriptor.originalFile }
        : {}),
      workflowName: source.workflowName ?? descriptor.workflowName,
      startedAt,
      lastModifiedAt: startedAt,
      isFavorite: descriptor.isFavorite,
      definitionRevision: 1,
      steps: stripStepRuntime(source.steps ?? []).map(
        stripViewOnlyWorkflowStepFields
      ),
      ...(overrides.harness ? { harness: overrides.harness } : {}),
      ...(overrides.model ? { model: overrides.model } : {}),
      _runtime: {
        currentIndex: 0,
        executionState: EXECUTION_STATES.IDLE,
      },
    };

    await writeWorkingFileAtomicTo(allocation.runFilePath, workingFile);

    if (allocation.draftFilePathToRemove) {
      await fs
        .rm(allocation.draftFilePathToRemove, { force: true })
        .catch((error) =>
          Log.warn(
            `[WorkingFileManager] Failed to remove promoted draft: ${getErrorMessage(error)}`
          )
        );
    }

    Log.info(
      ` Seeded lineage ${workflowKey} run ${fromRunRef} into new run ${allocation.runRef}`
    );
    return {
      workingFilePath: allocation.runFilePath,
      runRef: allocation.runRef,
      runId: allocation.runId,
      runDir: allocation.runDir,
      startedAt,
    };
  }

  /**
   * Begins a durable, in-place continuation for a promoted run. Lock ordering is
   * descriptor -> working file throughout this operation, matching draft seeding;
   * the lineage lock makes `pendingEdit` and the snapshot/file transition visible
   * as one transaction to other preparation requests.
   */
  public static async beginPendingRewind(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    fromStepIndex: number,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    if (!Number.isInteger(fromStepIndex) || fromStepIndex <= 0) {
      throw new Error("A pending rewind must start at a nonzero step index");
    }
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      runRef
    );
    const snapshotPath = WorkflowPaths.pendingRewindBaseFilePath(
      workspaceFolderPath,
      workflowKey,
      runRef
    );

    return lineageRepository.mutateDescriptorAtRevision(
      workspaceFolderPath,
      workflowKey,
      expectedDescriptorRevision,
      async (descriptor) => {
        if (descriptor.pendingEdit) {
          throw new Error(
            "A draft or continuation is already being prepared for this workflow"
          );
        }
        return withFileLock(runFilePath, async () => {
          const sourceBytes = await fs.readFile(runFilePath);
          const source = JSON.parse(
            sourceBytes.toString("utf8")
          ) as WorkingFile;
          const sourceRevision = source.definitionRevision ?? 1;
          if (sourceRevision !== expectedDefinitionRevision) {
            throw new Error(
              `Definition revision conflict: expected ${expectedDefinitionRevision}, found ${sourceRevision}`
            );
          }
          const steps = source.steps ?? [];
          if (fromStepIndex >= steps.length) {
            throw new Error(
              `Invalid rewind index ${fromStepIndex}; expected a suffix within ${steps.length} step(s)`
            );
          }

          // Snapshot first. A crash after this point is recoverable; a crash before
          // it leaves the untouched run and descriptor without a pending marker.
          await fs.mkdir(
            WorkflowPaths.pendingRewindDir(
              workspaceFolderPath,
              workflowKey,
              runRef
            ),
            { recursive: true }
          );
          await writeSnapshotAtomic(snapshotPath, sourceBytes);
          const now = Date.now();
          const pendingRewind = {
            fromStepIndex,
            baseDefinitionRevision: sourceRevision,
          };
          const workingFile: WorkingFile = {
            ...source,
            lastModifiedAt: now,
            definitionRevision: sourceRevision + 1,
            steps: steps.map((step, index) =>
              index < fromStepIndex
                ? stripViewOnlyWorkflowStepFields(step)
                : stripViewOnlyWorkflowStepFields(stripStepRuntime([step])[0])
            ),
            _runtime: {
              ...source._runtime,
              currentIndex: fromStepIndex,
              executionState:
                source._runtime?.executionState === EXECUTION_STATES.PAUSED
                  ? EXECUTION_STATES.PAUSED
                  : EXECUTION_STATES.IDLE,
              pendingRewind,
            },
          };
          await writeWorkingFileAtomicTo(runFilePath, workingFile, {
            skipLock: true,
          });
          return {
            value: {
              workingFile,
              definitionRevision: workingFile.definitionRevision,
              descriptorRevision: expectedDescriptorRevision + 1,
            },
            descriptor: {
              ...descriptor,
              pendingEdit: {
                kind: "rewind",
                runRef,
                fromStepIndex,
                baseDefinitionRevision: sourceRevision,
              },
            },
          };
        });
      }
    );
  }

  /**
   * Update working file with current queue state (serialized through operation queue).
   * This is called after prompt completion, append, or any queue modification.
   * @param skipMerge If true, writes memory state directly without checking for MCP changes (used for deletes/updates)
   */
  public async updateWorkingFile(skipMerge: boolean = false): Promise<void> {
    if (!this.queueAccess.getWorkingFilePath()) {
      return; // No working file to update
    }

    // Serialize operation to prevent race conditions
    const operation = this.operationQueue.then(() =>
      this.updateWorkingFileDirect(skipMerge)
    );
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
  }

  /**
   * Direct working file update (no operation queue serialization).
   * Use this when already executing within the operation queue context (e.g., from runInQueue).
   * @param skipMerge If true, writes memory state directly without checking for MCP changes
   */
  public async updateWorkingFileDirect(
    skipMerge: boolean = false
  ): Promise<void> {
    const workingFilePath = this.queueAccess.getWorkingFilePath();
    if (!workingFilePath) {
      return; // No working file to update
    }

    await withFileLock(workingFilePath, async () => {
      // Read current working file from disk
      const workingFile = await this.readWorkingFile(workingFilePath);
      this.assertExpectedDefinitionRevision(workingFile);

      // CRITICAL FIX: Merge steps from disk instead of blindly overwriting
      // This preserves MCP-appended steps that may have been added while we were running
      // BUT: Skip merge for intentional writes (delete/update) to avoid undoing changes
      if (!skipMerge) {
        const diskSteps = workingFile.steps || [];

        const newStepsFromDisk = this.queueAccess.mergeDiskSteps(diskSteps);

        // If disk has new steps, log and emit state change
        if (newStepsFromDisk.length > 0) {
          Log.info(
            `updateWorkingFile - Detected ${newStepsFromDisk.length} steps added externally (likely via MCP), merging into queue`
          );

          // Emit state change so dashboard updates
          this.queueAccess.emitStateChange();
        }
      } // End skipMerge check

      // Now write back the steps array (merged or direct from memory)
      // CRITICAL: Preserve _runtime metadata during save (Phase 4: Per-Prompt Session Management)
      workingFile.steps = this.queueAccess
        .getSteps()
        .map(stripViewOnlyWorkflowStepFields);
      // Count steps with _runtime metadata (Phase 4: Session Management)
      const stepsWithRuntime = workingFile.steps.filter(
        (p) => p._runtime
      ).length;
      Log.debug(
        `updateWorkingFile - Writing ${workingFile.steps.length} steps to ${workingFilePath}, ` +
          `_runtime: ${stepsWithRuntime}/${workingFile.steps.length} steps`
      );

      // Update workflow name if set in state
      const workflowName = this.queueAccess.getWorkflowName();
      if (workflowName) {
        workingFile.workflowName = workflowName;
      }

      // Update last modified timestamp
      workingFile.lastModifiedAt = Date.now();

      // Definition revision is bumped by the queue's definition-mutating methods
      // (append/insert/replace/delete/reorder); this just serializes the current
      // in-memory value. Not bumped here — pure runtime persistence must not advance it.
      workingFile.definitionRevision = this.queueAccess.getDefinitionRevision();

      // Update workflow-level runtime state
      // completedPrompts is no longer written; per-prompt _runtime.completedAt is the source of truth
      const finalStepRuntime = this.queueAccess.getFinalStepRuntime();
      workingFile._runtime = {
        currentIndex: this.queueAccess.getCurrentIndex(),
        executionState: this.queueAccess.getStatus(),
        ...(finalStepRuntime ? { finalStep: finalStepRuntime } : {}),
        ...(this.queueAccess.getPendingRewind?.()
          ? { pendingRewind: this.queueAccess.getPendingRewind() }
          : {}),
      };

      // Write atomically while holding lock
      await this.writeWorkingFileAtomic(workingFilePath, workingFile, {
        skipLock: true,
      });
      this.consumeExpectedDefinitionRevision();
    });
  }

  /**
   * Update workflow-level properties in the working file (atomic + serialized).
   */
  public async updateWorkingFileProperties(
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {}
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    const workingFilePath = this.queueAccess.getWorkingFilePath();
    if (!workingFilePath) {
      return null;
    }

    let result: { workingFile: WorkingFile; appliedKeys: string[] } | null =
      null;

    const operation = this.operationQueue.then(async () => {
      const appliedKeys: string[] = [];

      await withFileLock(workingFilePath, async () => {
        const workingFile = await this.readWorkingFile(workingFilePath);
        this.assertExpectedDefinitionRevision(workingFile);

        if (workingFile._runtime?.pendingRewind) {
          throw new Error(
            "Cannot change workflow-level properties while a continuation is pending; create a draft instead"
          );
        }

        let modified = false;
        for (const [key, value] of Object.entries(properties)) {
          if (value === undefined) {
            if (
              options.allowDeletes &&
              (workingFile as any)[key] !== undefined
            ) {
              delete (workingFile as any)[key];
              modified = true;
              appliedKeys.push(key);
            }
            continue;
          }

          if (
            options.onlyIfUndefined &&
            (workingFile as any)[key] !== undefined
          ) {
            continue;
          }

          if ((workingFile as any)[key] !== value) {
            (workingFile as any)[key] = value;
            modified = true;
            appliedKeys.push(key);
          }
        }

        if (options.ensureHarnessAndModel) {
          if (!workingFile.harness) {
            workingFile.harness = ConfigurationUtils.getIntegrationMode();
            modified = true;
            appliedKeys.push("harness");
          }

          if (!workingFile.model) {
            workingFile.model = this.getDefaultModelForHarness(
              workingFile.harness
            );
            modified = true;
            appliedKeys.push("model");
          }
        }

        if (modified) {
          workingFile.lastModifiedAt = Date.now();
          workingFile.definitionRevision =
            (workingFile.definitionRevision ?? 1) + 1;
          await this.writeWorkingFileAtomic(workingFilePath, workingFile, {
            skipLock: true,
          });
          this.queueAccess.setDefinitionRevision(
            workingFile.definitionRevision
          );
          this.consumeExpectedDefinitionRevision();
        }

        for (const key of appliedKeys) {
          this.queueAccess.updateWorkflowProperty(
            key,
            (workingFile as any)[key]
          );
        }

        result = { workingFile, appliedKeys };
      });
    });
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
    return result;
  }

  /**
   * Run an async function serialized in the operation queue.
   * Used by PromptQueue for compound operations that need both state mutations
   * and file I/O to be atomic (e.g., appendSteps).
   */
  public async runInQueue(fn: () => Promise<void>): Promise<void> {
    this.operationQueue = this.operationQueue.then(fn).catch((err) => {
      Log.error(
        `operationQueue: serialized operation failed: ${getErrorMessage(err)}`
      );
    });

    await this.operationQueue;
  }

  // ==================== Private Helpers ====================

  /**
   * Get default model for a given harness from settings
   */
  private getDefaultModelForHarness(harness: HarnessId): string {
    switch (harness) {
      case HARNESS_IDS.COPILOT_CLI:
        return ConfigurationUtils.getCliModel();
      case HARNESS_IDS.CLAUDE_CLI:
        return ConfigurationUtils.getClaudeCliModel();
      case HARNESS_IDS.CODEX_CLI:
        return ConfigurationUtils.getCodexCliModel();
      case HARNESS_IDS.OPENCODE_CLI:
        return ConfigurationUtils.getOpenCodeCliModel();
      case HARNESS_IDS.QWEN_CLI:
        return ConfigurationUtils.getQwenCliModel();
      case HARNESS_IDS.ANTIGRAVITY_CLI:
        return ConfigurationUtils.getAntigravityCliModel();
      default:
        return ConfigurationUtils.getCliModel();
    }
  }
}
