import * as fs from "fs/promises";
import { isDeepStrictEqual } from "util";
import type {
  RunRef,
  WorkflowKey,
  WorkflowRuntimeState,
  WorkflowStep,
  PromptRuntimeMetadata,
  WorkingFile,
  WorkingFileRuntime,
  ActiveParallelGroupRuntime,
  WorkingFileWorktreeRuntimePatch,
  WorkflowTokenTotals,
  WorkflowLineageCreationOptions,
  ParallelGroupDefinition,
} from "../types/CtrlYokeTypes";
import type { FinalStepRuntimeState } from "../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  IN_FLIGHT_EXECUTION_STATES,
  PROMPT_PROPERTIES,
  QUEUE_POSITION,
  WORKTREE_EDIT_KINDS,
  type HarnessId,
  type QueuePosition,
} from "../types/DashboardConstants";
import type { ExecutionState } from "../types/DashboardConstants";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { withFileLock } from "../utils/FileLockUtils";
import { writeFileAtomic } from "../utils/AtomicFileUtils";
import { runStateWriteOptions } from "../utils/RunStateWrites";
import { invalidateRunSummaryFor } from "./orchestration/RunSummaryCache";
import { stripLegacyWorkingFileLineageMetadata } from "../utils/WorkingFileMetadata";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import {
  assertBulkWorkflowStepUpdateAllowed,
  buildDefinitionSnapshot,
  buildFinalStepUpdate,
  buildClearUpdates,
  mergeWorkflowStepUpdate,
  normalizeAgentSelection,
  stripStepRuntime,
  stripTimelineDuplicatedWorkingFileOutput,
  stripViewOnlyWorkflowStepFields,
} from "./WorkflowStepSanitizer";
import { WorkflowLineageRepository } from "./orchestration/WorkflowLineageRepository";
import { assertEditableDuringExecution } from "./orchestration/RunContinuationService";
import {
  assertDefinitionRevision,
  assertDescriptorRevision,
} from "./orchestration/RevisionPrecondition";
import { RunContinuationService } from "./orchestration/RunContinuationService";
import { TimelineRecorder } from "./orchestration/TimelineRecorder";
import {
  ensureStepIds,
  findStepById,
  resetStepRuntimeForRewind,
} from "./StepIdentity";
import {
  assertWritableSchema,
  isNewerSchemaError,
  isNewerSchemaVersion,
  isNewerRunFile,
  PERSISTED_STORES,
  prepareRunFileForWrite,
  readSchemaVersion,
  refuseNewerSchema,
} from "../utils/PersistedSchemaGuard";
import {
  assertNoParallelSiblingReferences,
  deleteParallelGroupSteps,
  insertParallelGroupSteps,
  normalizeParallelGroupTopology,
  reorderParallelGroupPendingSteps,
  type PendingParallelGroupRange,
  replaceParallelGroupStep,
  resolveParallelGroupInsertIndex,
  snapParallelGroupStartPosition,
  PARALLEL_GROUP_INSERT_POSITIONS,
  type ParallelGroupInsertPlacement,
} from "./ParallelGroupTopology";
import {
  assertStepRemovalUnreferenced,
  renumberStepReferences,
} from "./StepReferenceRenumbering";

function normalizeWorkflowPropertyValue(key: string, value: unknown): unknown {
  return key === PROMPT_PROPERTIES.AGENT &&
    (typeof value === "string" || value === null)
    ? normalizeAgentSelection(value)
    : value;
}

/**
 * Applies a workflow-level property patch to `target`, returning only the keys
 * whose persisted value actually changed.
 *
 * The comparison is **deep** on purpose. Several workflow properties are objects
 * or arrays (`endCondition`, `preCondition`, `toolPermissions`, `mcpServers`,
 * `hooks`, `skills`, `worktree`, …), and a reference comparison reports every
 * one of them as changed on every write — the client always posts a freshly
 * deserialized object. That made `definitionRevision` climb on writes that
 * persisted nothing, which is the manufactured half of "Definition revision
 * conflict" during fast editing/undo: each no-op write superseded the revision
 * the client was still holding, and the next real action was rejected against a
 * revision it had no way to have learned yet. The tell in
 * `ctrlyoke-<timestamp>.log` is a properties `write analysis` line whose
 * `definitionRevision` is `"changed"` while every attempted field is `"no-op"`.
 *
 * Shared by the instance-owned path (`updateWorkingFileProperties`) and the
 * addressed-run path (`updatePropertiesAtRun`) so the two cannot drift.
 */
function applyWorkflowPropertyWrites(
  target: Record<string, unknown>,
  properties: Record<string, unknown>,
  options: { onlyIfUndefined?: boolean; allowDeletes?: boolean } = {}
): string[] {
  const appliedKeys: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      if (options.allowDeletes && target[key] !== undefined) {
        delete target[key];
        appliedKeys.push(key);
      }
      continue;
    }

    if (options.onlyIfUndefined && target[key] !== undefined) {
      continue;
    }

    const persistedValue = normalizeWorkflowPropertyValue(key, value);
    if (!isDeepStrictEqual(target[key], persistedValue)) {
      target[key] = persistedValue;
      appliedKeys.push(key);
    }
  }
  return appliedKeys;
}

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
    const parsed = JSON.parse(content) as WorkingFile;
    const schemaVersion = readSchemaVersion(parsed);
    if (
      isNewerSchemaVersion(PERSISTED_STORES.WORKFLOW_DEFINITION, schemaVersion)
    ) {
      refuseNewerSchema(
        PERSISTED_STORES.WORKFLOW_DEFINITION,
        schemaVersion as number,
        `${workingFilePath.split(/[\\/]/).pop()} (JSON)`
      );
    }
    const workingFile = stripLegacyWorkingFileLineageMetadata(parsed);
    return stripTimelineDuplicatedWorkingFileOutput(workingFile);
  } catch (error) {
    if (isNewerSchemaError(error)) throw error;
    throw new Error(`Failed to read working file: ${getErrorMessage(error)}`);
  }
}

type WorkingFileWriteOptions = {
  skipLock?: boolean;
  operation?: string;
  attemptedFields?: readonly string[];
};

type WorkingFileFieldStatus = "added" | "removed" | "changed" | "no-op";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getFieldChangeStatuses(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  excludedFields: ReadonlySet<string> = new Set()
): Record<string, WorkingFileFieldStatus> {
  const fields = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  const statuses: Record<string, WorkingFileFieldStatus> = {};

  for (const field of fields) {
    if (excludedFields.has(field)) {
      continue;
    }
    const beforeHasField = before ? Object.hasOwn(before, field) : false;
    const afterHasField = after ? Object.hasOwn(after, field) : false;
    if (
      beforeHasField &&
      afterHasField &&
      isDeepStrictEqual(before?.[field], after?.[field])
    ) {
      statuses[field] = "no-op";
    } else if (!beforeHasField && afterHasField) {
      statuses[field] = "added";
    } else if (beforeHasField && !afterHasField) {
      statuses[field] = "removed";
    } else {
      statuses[field] = "changed";
    }
  }

  return statuses;
}

function getRuntimeChangeSummary(
  before: WorkingFile | undefined,
  after: WorkingFile
): {
  workflow: Record<string, WorkingFileFieldStatus>;
  steps: Record<string, WorkingFileFieldStatus>;
  finalStep: Record<string, WorkingFileFieldStatus>;
} {
  const beforeSteps = before?.steps ?? [];
  const afterSteps = after.steps ?? [];
  const stepStatuses: Record<string, WorkingFileFieldStatus> = {};
  for (
    let index = 0;
    index < Math.max(beforeSteps.length, afterSteps.length);
    index++
  ) {
    const statuses = getFieldChangeStatuses(
      asRecord(beforeSteps[index]?._runtime),
      asRecord(afterSteps[index]?._runtime)
    );
    for (const [field, status] of Object.entries(statuses)) {
      stepStatuses[`steps[${index}]._runtime.${field}`] = status;
    }
  }

  const finalStepStatuses = getFieldChangeStatuses(
    asRecord(before?.finalStep?._runtime),
    asRecord(after.finalStep?._runtime)
  );

  return {
    workflow: getFieldChangeStatuses(
      asRecord(before?._runtime),
      asRecord(after._runtime)
    ),
    steps: stepStatuses,
    finalStep: Object.fromEntries(
      Object.entries(finalStepStatuses).map(([field, status]) => [
        `finalStep._runtime.${field}`,
        status,
      ])
    ),
  };
}

function getRuntimeValues(workingFile: WorkingFile | undefined): {
  workflow: WorkingFileRuntime | undefined;
  steps: Record<number, WorkflowStep["_runtime"]>;
  finalStep: WorkflowStep["_runtime"];
} {
  const steps: Record<number, WorkflowStep["_runtime"]> = {};
  for (const [index, step] of (workingFile?.steps ?? []).entries()) {
    if (step._runtime !== undefined) {
      steps[index] = step._runtime;
    }
  }
  return {
    workflow: workingFile?._runtime,
    steps,
    finalStep: workingFile?.finalStep?._runtime,
  };
}

function getDefinitionChangeSummary(
  before: WorkingFile | undefined,
  after: WorkingFile
): {
  steps: Record<string, WorkingFileFieldStatus>;
  finalStep: Record<string, WorkingFileFieldStatus>;
} {
  const beforeSteps = before?.steps ?? [];
  const afterSteps = after.steps ?? [];
  const stepStatuses: Record<string, WorkingFileFieldStatus> = {};
  for (
    let index = 0;
    index < Math.max(beforeSteps.length, afterSteps.length);
    index++
  ) {
    const statuses = getFieldChangeStatuses(
      asRecord(beforeSteps[index]),
      asRecord(afterSteps[index]),
      new Set(["_runtime"])
    );
    for (const [field, status] of Object.entries(statuses)) {
      stepStatuses[`steps[${index}].${field}`] = status;
    }
  }

  const finalStepStatuses = getFieldChangeStatuses(
    asRecord(before?.finalStep),
    asRecord(after.finalStep),
    new Set(["_runtime"])
  );

  return {
    steps: stepStatuses,
    finalStep: Object.fromEntries(
      Object.entries(finalStepStatuses).map(([field, status]) => [
        `finalStep.${field}`,
        status,
      ])
    ),
  };
}

async function readWorkingFileForWriteDiagnostics(
  workingFilePath: string
): Promise<WorkingFile | undefined> {
  try {
    const content = await fs.readFile(workingFilePath, "utf-8");
    return stripTimelineDuplicatedWorkingFileOutput(
      JSON.parse(content) as WorkingFile
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      Log.trace(
        `[WorkingFileManager] Unable to read the previous working file for write diagnostics: ${workingFilePath}`
      );
    }
    return undefined;
  }
}

async function logWorkingFileWriteDiagnostics(
  workingFilePath: string,
  workingFile: WorkingFile,
  options: WorkingFileWriteOptions
): Promise<void> {
  const previousWorkingFile =
    await readWorkingFileForWriteDiagnostics(workingFilePath);
  const persistedWorkingFile =
    stripTimelineDuplicatedWorkingFileOutput(workingFile);
  const runtime = getRuntimeChangeSummary(
    previousWorkingFile,
    persistedWorkingFile
  );
  const topLevel = getFieldChangeStatuses(
    asRecord(previousWorkingFile),
    asRecord(persistedWorkingFile),
    new Set(["steps", "finalStep", "_runtime"])
  );
  const definition = getDefinitionChangeSummary(
    previousWorkingFile,
    persistedWorkingFile
  );

  Log.trace(
    `[WorkingFileManager] ${options.operation ?? "atomic-write"} write analysis: ` +
      JSON.stringify({
        path: workingFilePath,
        attemptedFields: options.attemptedFields ?? [],
        fileChanged: previousWorkingFile
          ? !isDeepStrictEqual(previousWorkingFile, persistedWorkingFile)
          : "new-file",
        topLevel,
        definition,
        runtime,
        runtimeValues: {
          before: getRuntimeValues(previousWorkingFile),
          after: getRuntimeValues(persistedWorkingFile),
        },
      })
  );
}

/** Write a working file atomically (temp + rename), optionally under `withFileLock`. */
async function writeWorkingFileAtomicTo(
  workingFilePath: string,
  workingFile: WorkingFile,
  options: WorkingFileWriteOptions = {}
): Promise<void> {
  // Outside the try below so a NewerSchemaError keeps its type for callers.
  const stamped = prepareRunFileForWrite(workingFile, workingFilePath);
  const writeAction = async () => {
    try {
      await logWorkingFileWriteDiagnostics(workingFilePath, stamped, options);
      await writeFileAtomic(
        workingFilePath,
        JSON.stringify(
          stripTimelineDuplicatedWorkingFileOutput(stamped),
          null,
          2
        ),
        runStateWriteOptions(workingFilePath, "WorkingFileManager")
      );
    } catch (error) {
      throw new Error(
        `Failed to write working file: ${getErrorMessage(error)}`
      );
    } finally {
      // This function is the single writer of every run/draft working file, so
      // it is the one place that can keep the run-summary cache honest for
      // in-process writes. In `finally` because a write whose outcome is
      // ambiguous must drop the entry, not keep it. Draft/staging paths are
      // not cached and no-op here.
      invalidateRunSummaryFor(workingFilePath);
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
  try {
    await writeFileAtomic(
      snapshotPath,
      content,
      runStateWriteOptions(snapshotPath, "WorkingFileManager")
    );
  } catch (error) {
    throw new Error(
      `Failed to write pending rewind snapshot: ${getErrorMessage(error)}`
    );
  }
}

/** Restores opaque recovery bytes without reserializing a working file. */
async function restoreSnapshotAtomic(
  workingFilePath: string,
  content: Buffer
): Promise<void> {
  try {
    await writeFileAtomic(
      workingFilePath,
      content,
      runStateWriteOptions(workingFilePath, "WorkingFileManager")
    );
  } catch (error) {
    throw new Error(
      `Failed to restore pending rewind snapshot: ${getErrorMessage(error)}`
    );
  } finally {
    // The second writer of a run's working file — this one replaces it with
    // recovery bytes rather than reserializing, so it bypasses
    // `writeWorkingFileAtomicTo` and needs its own invalidation.
    invalidateRunSummaryFor(workingFilePath);
  }
}

class DiscardConfirmationRequiredError extends Error {}

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

  /** Authoritative workflow execution status/timing snapshot. */
  getRuntimeState?(): WorkflowRuntimeState;

  /** Latest timeline-projected run token aggregate, if any. */
  getTokenTotals?(): WorkflowTokenTotals | undefined;

  /** Current in-memory definition revision counter (see `WorkingFile.definitionRevision`) */
  getDefinitionRevision(): number;

  /** Reconcile the in-memory definition revision counter after a disk-authoritative write. */
  setDefinitionRevision(revision: number): void;

  /** Current workflow name */
  getWorkflowName(): string | undefined;

  /** Workflow variables that should be persisted with the current run. */
  getWorkflowVars?(): Record<string, string> | undefined;

  /** Current normalized parallel-group topology. */
  getParallelGroups?(): ParallelGroupDefinition[];

  /** Durable admission state for the currently executing parallel group. */
  getActiveParallelGroupRuntime?(): ActiveParallelGroupRuntime | undefined;

  /** Merge disk steps into memory, returning newly added steps */
  mergeDiskSteps(
    diskSteps: WorkflowStep[],
    parallelGroups?: ParallelGroupDefinition[],
    options?: { authoritativeRuntime?: boolean }
  ): WorkflowStep[];

  /** Notify the execution owner that disk supplied new queue members. */
  onDiskStepsMerged?(steps: readonly WorkflowStep[]): void;

  /** Adopt the rewind marker present in the working file. */
  setPendingRewind?(pendingRewind: WorkingFileRuntime["pendingRewind"]): void;

  /** Adopt the queue position and runtime state from an authoritative snapshot. */
  adoptDiskRuntime?(workingFile: WorkingFile): void;

  /** Emit state change notification to listeners */
  emitStateChange(): void;

  /** Runtime metadata for workflow-level finalStep execution */
  getFinalStepRuntime(): FinalStepRuntimeState | undefined;

  /** Per-step execution metadata for the finalStep definition */
  getFinalStepExecutionMetadata?(): PromptRuntimeMetadata | undefined;

  /** Durable same-run rewind marker, when the queue is editing a suffix. */
  getPendingRewind?():
    { fromStepIndex: number; baseDefinitionRevision: number } | undefined;

  /** Update a workflow property in cached workflow file */
  updateWorkflowProperty(key: string, value: unknown): void;
}

/**
 * Manages run/draft working-file persistence in run storage under
 * `<workflowKey>/{draft,run-<ts>}/workflow.ctrlyoke.json`.
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

  // ==================== Pure File Operations ====================

  /**
   * Read working file from disk
   * @param workingFilePath Path to working file
   * @returns Parsed working file
   */
  public async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return WorkingFileManager.readWorkingFileFromDisk(workingFilePath);
  }

  /** Read any run-storage working file without requiring a live queue adapter. */
  public static async readWorkingFileFromDisk(
    workingFilePath: string
  ): Promise<WorkingFile> {
    return readWorkingFileFromDisk(workingFilePath);
  }

  /** Write a run-storage working file atomically without requiring a live queue adapter. */
  public static async writeWorkingFileAtomic(
    workingFilePath: string,
    workingFile: WorkingFile
  ): Promise<void> {
    return writeWorkingFileAtomicTo(workingFilePath, workingFile);
  }

  /** Applies to the next definition write only; runtime persistence remains unguarded. */
  public expectDefinitionRevision(revision: number): void {
    this.expectedDefinitionRevision = revision;
  }

  /**
   * Consumes the pending expectation as it checks it, so it can only ever guard
   * the one write it was primed for. Leaving it armed made a superseded
   * expectation fail an unrelated later write — including writes to a different
   * lineage's file after the queue changed working files.
   */
  private assertExpectedDefinitionRevision(workingFile: WorkingFile): void {
    const expected = this.expectedDefinitionRevision;
    this.expectedDefinitionRevision = undefined;
    if (expected === undefined) {
      return;
    }
    assertDefinitionRevision(expected, workingFile.definitionRevision);
  }

  /**
   * Write working file atomically (temp + rename)
   * @param workingFilePath Path to working file
   * @param workingFile Working file data
   */
  private async writeWorkingFileAtomic(
    workingFilePath: string,
    workingFile: WorkingFile,
    options: WorkingFileWriteOptions = {}
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
   * @param workflowName Computed display name stored in the lineage descriptor
   * @param originalFilePath The source file path stored in the lineage descriptor, if any.
   * @returns The draft's path and the lineage's new WorkflowKey
   */
  public async createWorkingFile(
    nameForFile: string,
    steps: WorkflowStep[],
    workspaceFolderPath: string,
    workflowName: string,
    originalFilePath?: string,
    options?: WorkflowLineageCreationOptions,
    parallelGroups: ParallelGroupDefinition[] = []
  ): Promise<{ workingFilePath: string; workflowKey: WorkflowKey }> {
    const topology = normalizeParallelGroupTopology({
      steps,
      parallelGroups,
    });
    const identifiedSteps = ensureStepIds(topology.steps);
    const { workflowKey, draftFilePath } =
      await this.lineageRepository.createLineage(
        workspaceFolderPath,
        nameForFile,
        workflowName,
        originalFilePath,
        undefined,
        options
      );

    const workingFile: WorkingFile = {
      startedAt: Date.now(),
      definitionRevision: 1,
      steps: identifiedSteps.map(stripViewOnlyWorkflowStepFields),
      parallelGroups: topology.parallelGroups,
      _runtime: {
        currentIndex: 0,
        executionState: EXECUTION_STATES.IDLE,
      },
    };

    // Write atomically (temp + rename)
    await this.writeWorkingFileAtomic(draftFilePath, workingFile);

    Log.info(
      `[WorkingFileManager] Created draft working file: ${draftFilePath}`
    );
    return { workingFilePath: draftFilePath, workflowKey };
  }

  /**
   * The lineage definition the queue is currently bound to, read from disk.
   * Workflow-level properties live only in that file — the queue exposes step
   * topology and runtime, not settings — so any code that rewrites a
   * definition from queue state must merge this first.
   */
  private async readCurrentDefinitionHead(): Promise<WorkingFile | undefined> {
    const currentPath = this.queueAccess.getWorkingFilePath();
    if (!currentPath) return undefined;
    try {
      return await readWorkingFileFromDisk(currentPath);
    } catch {
      // A missing/unreadable head is not fatal: promotion still produces a
      // valid run from queue state, exactly as it did before.
      return undefined;
    }
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
    stagingRunDir: string;
    stagingWorkingFilePath: string;
    allocation: import("./orchestration/WorkflowLineageRepository").AllocatedRun;
  }> {
    // Read before allocating: a head a newer ctrlyoke wrote must not be
    // re-run by this build (its fresh `_runtime` would drop the version the
    // run-file writer checks), and refusing first leaves no staging run behind.
    const head = await this.readCurrentDefinitionHead();
    if (head && isNewerRunFile(head)) {
      refuseNewerSchema(
        PERSISTED_STORES.RUN_FILE,
        head._runtime?.schemaVersion as number,
        this.queueAccess.getWorkingFilePath()
      );
    }
    const allocation = await this.lineageRepository.allocateRun(
      workspaceFolderPath,
      workflowKey
    );
    const descriptor = await this.lineageRepository.readDescriptor(
      workspaceFolderPath,
      workflowKey
    );

    // The lineage's current head carries everything that is *not* queue state:
    // harness/model/agent/skills/mcpServers/hooks/conditions/permissions and
    // `finalStep`. Building the run file from queue state alone silently
    // dropped all of it, so a workflow's first execution ran with global
    // defaults and every later view of that run showed no saved settings.
    // Mirrors `seedNewRun`, which already carries its source forward.
    const finalStepRuntime = this.queueAccess.getFinalStepRuntime();
    const workingFile: WorkingFile = {
      ...head,
      startedAt,
      definitionRevision: 1,
      steps: ensureStepIds(this.queueAccess.getSteps()).map(
        stripViewOnlyWorkflowStepFields
      ),
      parallelGroups: normalizeParallelGroupTopology({
        steps: this.queueAccess.getSteps(),
        parallelGroups:
          this.queueAccess.getParallelGroups?.() ?? head?.parallelGroups,
      }).parallelGroups,
      _runtime: {
        currentIndex: this.queueAccess.getCurrentIndex(),
        executionState: this.queueAccess.getStatus(),
        ...this.getPersistedExecutionTiming(),
        ...(finalStepRuntime ? { finalStep: finalStepRuntime } : {}),
      },
    };

    await this.writeWorkingFileAtomic(
      allocation.stagingRunFilePath,
      workingFile
    );
    await new TimelineRecorder().initializeRunAt(
      allocation.stagingRunDir,
      workflowKey,
      allocation.runId,
      startedAt,
      EXECUTION_STATES.RUNNING,
      workingFile.definitionRevision ?? 1,
      buildDefinitionSnapshot(
        descriptor.workflowName,
        workingFile.steps ?? [],
        undefined,
        workingFile.finalStep,
        workingFile.worktree,
        workingFile.parallelGroups
      )
    );
    await WorkingFileManager.finalizeAllocatedRun(
      workspaceFolderPath,
      workflowKey,
      allocation,
      this.lineageRepository
    );

    Log.info(
      `[WorkingFileManager] Promoted lineage ${workflowKey} to new run ${allocation.runRef}`
    );
    return {
      workingFilePath: allocation.runFilePath,
      runRef: allocation.runRef,
      runId: allocation.runId,
      runDir: allocation.runDir,
      stagingRunDir: allocation.stagingRunDir,
      stagingWorkingFilePath: allocation.stagingRunFilePath,
      allocation,
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
   *
   * `initialTimelineState` is the execution state written into the seeded run's
   * manifest. Seeding and executing are separate operations — `Set start position`
   * on the first step seeds a run the user has not started — and the manifest is
   * what the dashboard's run list badges. It also has to be right the first time:
   * `TimelineRecorder.initializeRunAt` is a no-op once manifest+events exist, so the
   * executing callers' own `initializeRunAt` never corrects this value. Callers that
   * execute the seeded run immediately pass `RUNNING`.
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
    },
    initialTimelineState: ExecutionState = EXECUTION_STATES.IDLE
  ): Promise<{
    workingFilePath: string;
    sourceRunRef: RunRef;
    runRef: RunRef;
    runId: number;
    runDir: string;
    stagingRunDir: string;
    stagingWorkingFilePath: string;
    allocation: import("./orchestration/WorkflowLineageRepository").AllocatedRun;
    startedAt: number;
  }> {
    const sourceFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      fromRunRef
    );
    const source = await readWorkingFileFromDisk(sourceFilePath);
    assertWritableSchema(
      PERSISTED_STORES.RUN_FILE,
      source._runtime,
      sourceFilePath
    );
    const sourceRevision = source.definitionRevision ?? 1;
    if (expected?.definitionRevision !== undefined) {
      assertDefinitionRevision(expected.definitionRevision, sourceRevision);
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
    if (expected?.descriptorRevision !== undefined) {
      assertDescriptorRevision(
        expected.descriptorRevision,
        sourceDescriptor.revision
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
    const sourceTopology = normalizeParallelGroupTopology({
      steps: source.steps ?? [],
      parallelGroups: source.parallelGroups,
    });
    const identifiedSteps = ensureStepIds(
      stripStepRuntime(sourceTopology.steps).map(
        stripViewOnlyWorkflowStepFields
      )
    );
    const finalStep = source.finalStep
      ? stripViewOnlyWorkflowStepFields(stripStepRuntime([source.finalStep])[0])
      : undefined;
    const workingFile: WorkingFile = {
      ...source,
      startedAt,
      definitionRevision: 1,
      steps: identifiedSteps,
      parallelGroups: sourceTopology.parallelGroups,
      ...(finalStep ? { finalStep } : {}),
      ...(overrides.harness ? { harness: overrides.harness } : {}),
      ...(overrides.model ? { model: overrides.model } : {}),
      _runtime: {
        currentIndex: 0,
        executionState: EXECUTION_STATES.IDLE,
      },
    };

    await writeWorkingFileAtomicTo(allocation.stagingRunFilePath, workingFile);
    await new TimelineRecorder().initializeRunAt(
      allocation.stagingRunDir,
      workflowKey,
      allocation.runId,
      startedAt,
      initialTimelineState,
      workingFile.definitionRevision ?? 1,
      buildDefinitionSnapshot(
        descriptor.workflowName,
        workingFile.steps ?? [],
        undefined,
        workingFile.finalStep,
        workingFile.worktree,
        workingFile.parallelGroups
      )
    );
    await WorkingFileManager.finalizeAllocatedRun(
      workspaceFolderPath,
      workflowKey,
      allocation,
      lineageRepository
    );

    Log.info(
      `[WorkingFileManager] Seeded lineage ${workflowKey} run ${fromRunRef} into new run ${allocation.runRef}`
    );
    return {
      workingFilePath: allocation.runFilePath,
      sourceRunRef: fromRunRef,
      runRef: allocation.runRef,
      runId: allocation.runId,
      runDir: allocation.runDir,
      stagingRunDir: allocation.stagingRunDir,
      stagingWorkingFilePath: allocation.stagingRunFilePath,
      allocation,
      startedAt,
    };
  }

  /** Publishes a staged run only after TimelineRecorder created its two artifacts. */
  public static async finalizeAllocatedRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    allocation: import("./orchestration/WorkflowLineageRepository").AllocatedRun,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<void> {
    await lineageRepository.finalizeAllocatedRun(
      workspaceFolderPath,
      workflowKey,
      allocation
    );
    if (allocation.draftFilePathToRemove) {
      await fs
        .rm(allocation.draftFilePathToRemove, { force: true })
        .catch((error) =>
          Log.warn(
            `[WorkingFileManager] Failed to remove promoted draft: ${getErrorMessage(error)}`
          )
        );
    }
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
          assertDefinitionRevision(expectedDefinitionRevision, sourceRevision);
          const topology = normalizeParallelGroupTopology({
            steps: ensureStepIds(source.steps ?? []),
            parallelGroups: source.parallelGroups,
          });
          const sourceHasBackfilledIds = topology.steps.some(
            (step, index) => step !== source.steps?.[index]
          );
          const sourceForRewind = sourceHasBackfilledIds
            ? { ...source, steps: topology.steps }
            : source;
          const snapshotBytes = sourceHasBackfilledIds
            ? Buffer.from(JSON.stringify(sourceForRewind, null, 2))
            : sourceBytes;
          if (fromStepIndex >= topology.steps.length) {
            throw new Error(
              `Invalid rewind index ${fromStepIndex}; expected a suffix within ${topology.steps.length} step(s)`
            );
          }
          const boundary = snapParallelGroupStartPosition(
            topology,
            fromStepIndex
          );

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
          await writeSnapshotAtomic(snapshotPath, snapshotBytes);
          const pendingRewind = {
            fromStepIndex: boundary,
            baseDefinitionRevision: sourceRevision,
          };
          const workingFile: WorkingFile = {
            ...sourceForRewind,
            definitionRevision: sourceRevision + 1,
            steps: topology.steps.map((step, index) =>
              index < boundary
                ? stripViewOnlyWorkflowStepFields(step)
                : stripViewOnlyWorkflowStepFields(
                    resetStepRuntimeForRewind(step)
                  )
            ),
            parallelGroups: topology.parallelGroups,
            _runtime: {
              ...sourceForRewind._runtime,
              currentIndex: boundary,
              executionState:
                sourceForRewind._runtime?.executionState ===
                EXECUTION_STATES.PAUSED
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
                kind: WORKTREE_EDIT_KINDS.REWIND,
                runRef,
                fromStepIndex: boundary,
                baseDefinitionRevision: sourceRevision,
              },
            },
          };
        });
      }
    );
  }

  /**
   * Appends new, runtime-free steps to one explicitly addressed promoted run.
   * The descriptor lock is acquired before the definition lock, matching the
   * other addressed definition transactions.  Existing steps are copied
   * untouched so their execution/session metadata remains associated with the
   * steps that produced it.
   */
  public static async appendStepsToRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    tail: WorkflowStep[],
    expectedDefinitionRevision: number,
    globalMaxSteps: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    allowInterruptedRun: boolean = false,
    position: QueuePosition = QUEUE_POSITION.END
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
    placement: ParallelGroupInsertPlacement;
    /** @deprecated Use placement.insertedIndex. */
    insertIndex: number;
  }> {
    return RunContinuationService.appendStepsToRun(
      workspaceFolderPath,
      workflowKey,
      runRef,
      tail,
      expectedDefinitionRevision,
      globalMaxSteps,
      lineageRepository,
      allowInterruptedRun,
      position
    );
  }

  /**
   * Shared shell for every addressed, in-place edit of an idle promoted run's
   * current definition head. Mirrors `beginPendingRewind`/`appendTailToRun`'s
   * lock ordering (descriptor lock, then run-file lock) and state guards so
   * callers only supply the step/property transform itself.
   *
   * The descriptor lock here is pure mutual exclusion against a concurrent
   * draft-seed/rewind (via the `pendingEdit` gate) — this shell never writes
   * the descriptor, since a run's own steps/properties/finalStep are not
   * descriptor content. `descriptorRevision` is intentionally decoupled from
   * `expectedDefinitionRevision`'s check: only `definitionRevision` (the run
   * file's own revision) has to match, or every edit to any run in a lineage
   * would spuriously conflict with unrelated lineage-level activity (another
   * run's rewind, a favorite toggle, a second run being promoted) that never
   * touched this run's content. See `core.instructions.md`.
   *
   * A run reaching this shell is never actively `PAUSED`: a paused run always
   * has a live `WorkflowInstance` holding the runner lock, so orchestrator
   * callers route those edits through that instance instead of here. The
   * `PAUSED` rejection below is defense-in-depth, not a supported case.
   *
   * `allowDuringPendingRewind` lets a property-only transform proceed while
   * this exact run has a pending rewind continuation; step-topology
   * transforms must leave it `false` (the default) until the suffix stays
   * restricted per the pending-rewind policy.
   */
  private static async mutateRunDefinition<T>(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision: number,
    transform: (source: WorkingFile) => { workingFile: WorkingFile; result: T },
    options: {
      lineageRepository?: WorkflowLineageRepository;
      allowDuringPendingRewind?: boolean;
    } = {}
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
    result: T;
  }> {
    const lineageRepository =
      options.lineageRepository ?? new WorkflowLineageRepository();
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      runRef
    );
    const descriptorPath = WorkflowPaths.descriptorPath(
      workspaceFolderPath,
      workflowKey
    );

    return withFileLock(descriptorPath, async () => {
      const descriptor = await lineageRepository.readDescriptor(
        workspaceFolderPath,
        workflowKey
      );
      if (descriptor.pendingEdit) {
        const pendingRewindOnThisRun =
          descriptor.pendingEdit.kind === "rewind" &&
          descriptor.pendingEdit.runRef === runRef;
        if (!options.allowDuringPendingRewind || !pendingRewindOnThisRun) {
          throw new Error(
            "Cannot edit while this workflow has a draft or pending continuation"
          );
        }
      }
      return withFileLock(runFilePath, async () => {
        const source = await readWorkingFileFromDisk(runFilePath);
        const sourceRevision = source.definitionRevision ?? 1;
        assertDefinitionRevision(expectedDefinitionRevision, sourceRevision);
        const sourceState = source._runtime?.executionState;
        if (
          sourceState === EXECUTION_STATES.RUNNING ||
          sourceState === EXECUTION_STATES.PAUSING ||
          sourceState === EXECUTION_STATES.CANCELLING ||
          sourceState === EXECUTION_STATES.PAUSED
        ) {
          throw new Error(`Cannot edit while run is in state ${sourceState}`);
        }
        const { workingFile: transformed, result } = transform(source);
        // A transform that reproduced the definition already on disk must not
        // bump `definitionRevision`. That revision is the optimistic-concurrency
        // token every client echoes on its next mutation, so bumping it for a
        // write that persists nothing supersedes a revision the client is still
        // legitimately holding and rejects its *next* real action as a
        // conflict. See `applyWorkflowPropertyWrites`.
        if (isDeepStrictEqual(source, transformed)) {
          return {
            workingFile: source,
            definitionRevision: sourceRevision,
            descriptorRevision: descriptor.revision,
            result,
          };
        }
        const workingFile: WorkingFile = {
          ...transformed,
          definitionRevision: sourceRevision + 1,
        };
        await writeWorkingFileAtomicTo(runFilePath, workingFile, {
          skipLock: true,
        });
        return {
          workingFile,
          definitionRevision: workingFile.definitionRevision,
          descriptorRevision: descriptor.revision,
          result,
        };
      });
    });
  }

  /**
   * Addressed workflow-level property edit (including a `finalStep`
   * replace, which is persisted as an ordinary property on `WorkingFile`).
   * Always allowed during a pending rewind on this exact run — properties
   * aren't part of the restricted suffix.
   */
  public static async updatePropertiesAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    properties: Record<string, unknown>,
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    options: { allowDeletes?: boolean } = {}
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
    appliedKeys: string[];
  }> {
    return this.mutateRunDefinition(
      workspaceFolderPath,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const workingFile: WorkingFile = { ...source };
        const appliedKeys = applyWorkflowPropertyWrites(
          workingFile as unknown as Record<string, unknown>,
          properties,
          { allowDeletes: options.allowDeletes }
        );
        return { workingFile, result: appliedKeys };
      },
      { lineageRepository, allowDuringPendingRewind: true }
    ).then(
      ({ workingFile, definitionRevision, descriptorRevision, result }) => ({
        workingFile,
        definitionRevision,
        descriptorRevision,
        appliedKeys: result,
      })
    );
  }

  /** Addressed workflow name rename. */
  public static async updateWorkflowNameAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    _runRef: RunRef,
    workflowName: string,
    _expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<{ descriptorRevision: number }> {
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      _runRef
    );
    const workingFile =
      await WorkingFileManager.readWorkingFileFromDisk(runFilePath);
    assertDefinitionRevision(
      _expectedDefinitionRevision,
      workingFile.definitionRevision ?? 1
    );
    const descriptor = await lineageRepository.updateDescriptor(
      workspaceFolderPath,
      workflowKey,
      (current) => ({ ...current, workflowName })
    );
    return { descriptorRevision: descriptor.revision };
  }

  /**
   * Addressed step insert, mirroring `PromptQueue.insertStepAfterIndex`'s
   * splice and `currentIndex` shift (adapted to the persisted
   * `_runtime.currentIndex`; `results`/`completedIndices` are in-memory-only
   * `PromptQueue` bookkeeping, not part of `WorkingFile`).
   */
  public static async insertStepAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    afterIndex: number,
    step: WorkflowStep,
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    return this.mutateRunDefinition(
      workspaceFolderPath,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const topology = normalizeParallelGroupTopology({
          steps: ensureStepIds(source.steps ?? []),
          parallelGroups: source.parallelGroups,
        });
        const steps = topology.steps;
        const isEmptyInsert = steps.length === 0 && afterIndex === -1;
        const isValidExistingIndex =
          steps.length > 0 && afterIndex >= 0 && afterIndex < steps.length;
        if (!isEmptyInsert && !isValidExistingIndex) {
          throw new Error(`Invalid insert index: ${afterIndex}`);
        }
        const requestedIndex = afterIndex + 1;
        const placement = resolveParallelGroupInsertIndex(
          topology,
          requestedIndex,
          PARALLEL_GROUP_INSERT_POSITIONS.AFTER
        );
        const insertIndex = placement.insertedIndex;
        const nextTopology = insertParallelGroupSteps(
          topology,
          requestedIndex,
          [ensureStepIds([...topology.steps, step]).at(-1)!]
        );
        const renumbered = renumberStepReferences(
          topology.steps,
          nextTopology.steps,
          source.finalStep
        );
        const currentIndex = source._runtime?.currentIndex ?? 0;
        // Strict `<`, matching `PromptQueue.insertStepAfterIndex`: an insert at
        // `currentIndex` becomes the next step to run rather than being shifted
        // into the already-consumed prefix.
        const nextCurrentIndex =
          insertIndex < currentIndex ? currentIndex + 1 : currentIndex;
        return {
          workingFile: {
            ...source,
            steps: renumbered.steps,
            ...(renumbered.finalStep
              ? { finalStep: renumbered.finalStep }
              : {}),
            parallelGroups: nextTopology.parallelGroups,
            _runtime: source._runtime
              ? { ...source._runtime, currentIndex: nextCurrentIndex }
              : source._runtime,
          },
          result: undefined,
        };
      },
      { lineageRepository }
    );
  }

  /**
   * Addressed step update: `updates` merges into the existing step (matching
   * `PromptQueue.updatePrompt`); pass a full `WorkflowStep` via `replace` for
   * a type-changing edit (matching `PromptQueue.replaceStep`).
   */
  public static async updateStepAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    index: number,
    change:
      | { updates: Partial<WorkflowStep> }
      | { replace: WorkflowStep; clearProperties?: string[] },
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    return this.mutateRunDefinition(
      workspaceFolderPath,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const topology = normalizeParallelGroupTopology({
          steps: source.steps ?? [],
          parallelGroups: source.parallelGroups,
        });
        const steps = topology.steps;
        if (index < 0 || index >= steps.length) {
          throw new Error(`Invalid prompt index: ${index}`);
        }
        const rewindBoundary = source._runtime?.pendingRewind?.fromStepIndex;
        if (rewindBoundary !== undefined && index < rewindBoundary) {
          throw new Error(
            `Cannot update step ${index + 1} before pending rewind boundary ${rewindBoundary + 1}`
          );
        }
        const incomingStep =
          "replace" in change
            ? change.replace
            : (change.updates as WorkflowStep);
        const nextTopology = replaceParallelGroupStep(
          topology,
          index,
          mergeWorkflowStepUpdate(
            steps[index],
            incomingStep,
            "replace" in change ? change.clearProperties : undefined
          )
        );
        assertNoParallelSiblingReferences(nextTopology, source);
        return {
          workingFile: {
            ...source,
            steps: nextTopology.steps,
            parallelGroups: nextTopology.parallelGroups,
          },
          result: undefined,
        };
      },
      // Content/type edits are safe inside the rewound suffix. Structural
      // insert/delete/reorder operations retain the stricter pending-edit
      // guard until their prefix-identity behavior is explicitly audited.
      { lineageRepository, allowDuringPendingRewind: true }
    );
  }

  /** Apply one sparse property patch to several editable steps in one run write. */
  public static async updateStepsAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    indices: number[],
    properties: Partial<WorkflowStep>,
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    clearProperties?: string[]
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    return this.mutateRunDefinition(
      workspaceFolderPath,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const steps = source.steps ?? [];
        const unique = [...new Set(indices)];
        if (unique.length !== indices.length || unique.length === 0) {
          throw new Error(
            "Update indices must be a non-empty set of unique indices"
          );
        }
        for (const index of unique) {
          if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
            throw new Error(`Invalid prompt index: ${index}`);
          }
          const rewindBoundary = source._runtime?.pendingRewind?.fromStepIndex;
          if (rewindBoundary !== undefined && index < rewindBoundary) {
            throw new Error(
              `Cannot update step ${index + 1} before pending rewind boundary ${rewindBoundary + 1}`
            );
          }
          assertEditableDuringExecution(source, steps, index, "update");
          assertBulkWorkflowStepUpdateAllowed(
            steps[index],
            index,
            properties as Record<string, unknown>,
            clearProperties
          );
        }
        const nextSteps = [...steps];
        for (const index of unique) {
          nextSteps[index] = mergeWorkflowStepUpdate(
            steps[index],
            properties,
            clearProperties
          );
        }
        assertNoParallelSiblingReferences(
          { steps: nextSteps, parallelGroups: source.parallelGroups ?? [] },
          source
        );
        return {
          workingFile: { ...source, steps: nextSteps },
          result: undefined,
        };
      },
      { lineageRepository, allowDuringPendingRewind: true }
    );
  }

  /**
   * Addressed final-step update: merge same-kind edits against the disk head,
   * replace on a prompt/script type change, and delete on an explicit null.
   */
  public static async updateFinalStepAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    finalStep: WorkflowStep | null,
    clearProperties: string[] | undefined,
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    return this.mutateRunDefinition(
      workspaceFolderPath,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const workingFile: WorkingFile = { ...source };
        if (finalStep === null) {
          delete workingFile.finalStep;
          if (workingFile._runtime?.finalStep) {
            const { finalStep: _finalStep, ...runtime } = workingFile._runtime;
            void _finalStep;
            workingFile._runtime = runtime;
          }
          return { workingFile, result: undefined };
        }

        const incomingStep = buildFinalStepUpdate(finalStep);
        workingFile.finalStep = source.finalStep
          ? mergeWorkflowStepUpdate(
              source.finalStep,
              incomingStep,
              clearProperties
            )
          : ({
              ...incomingStep,
              ...buildClearUpdates(clearProperties),
            } as WorkflowStep);
        return { workingFile, result: undefined };
      },
      { lineageRepository, allowDuringPendingRewind: true }
    );
  }

  /**
   * Addressed step delete, mirroring `PromptQueue.deletePrompts`' splice and
   * `currentIndex` shift.
   */
  public static async deleteStepsAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    indices: number[],
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    return this.mutateRunDefinition(
      workspaceFolderPath,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const topology = normalizeParallelGroupTopology({
          steps: source.steps ?? [],
          parallelGroups: source.parallelGroups,
        });
        const steps = topology.steps;
        const unique = [...new Set(indices)];
        if (unique.length !== indices.length || unique.length === 0) {
          throw new Error(
            "Delete indices must be a non-empty set of unique indices"
          );
        }
        for (const index of unique) {
          if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
            throw new Error(`Invalid prompt index: ${index}`);
          }
          assertEditableDuringExecution(source, steps, index, "delete");
        }
        const nextTopology = deleteParallelGroupSteps(topology, unique);
        const renumbered = renumberStepReferences(
          topology.steps,
          nextTopology.steps,
          source.finalStep
        );
        assertStepRemovalUnreferenced(renumbered, unique);
        const currentIndex = source._runtime?.currentIndex ?? 0;
        const nextCurrentIndex =
          currentIndex - unique.filter((index) => index < currentIndex).length;
        return {
          workingFile: {
            ...source,
            steps: renumbered.steps,
            ...(renumbered.finalStep
              ? { finalStep: renumbered.finalStep }
              : {}),
            parallelGroups: nextTopology.parallelGroups,
            _runtime: source._runtime
              ? { ...source._runtime, currentIndex: nextCurrentIndex }
              : source._runtime,
          },
          result: undefined,
        };
      },
      { lineageRepository }
    );
  }

  public static async updateStepColorsAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    indices: number[],
    color: string | null,
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    return this.mutateRunDefinition(
      workspaceFolderPath,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const steps = [...(source.steps ?? [])];
        const unique = [...new Set(indices)];
        if (unique.length !== indices.length || unique.length === 0) {
          throw new Error(
            "Color indices must be a non-empty set of unique indices"
          );
        }
        for (const index of unique) {
          if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
            throw new Error(`Invalid prompt index: ${index}`);
          }
        }
        for (const index of unique) {
          steps[index] = {
            ...steps[index],
            color: color ?? undefined,
          } as WorkflowStep;
        }
        return { workingFile: { ...source, steps }, result: undefined };
      },
      { lineageRepository, allowDuringPendingRewind: true }
    );
  }

  /**
   * Addressed reorder of the pending (not-yet-executed) suffix, mirroring
   * `PromptQueue.reorderPendingPrompts`'s done/pending split.
   * `newPendingOrder` entries are indices relative to the pending slice
   * (steps from `_runtime.currentIndex` onward), matching the existing
   * webview contract.
   */
  public static async reorderStepsAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    newPendingOrder: number[],
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    pendingGroups?: PendingParallelGroupRange[]
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    return this.mutateRunDefinition(
      workspaceFolderPath,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const topology = normalizeParallelGroupTopology({
          steps: source.steps ?? [],
          parallelGroups: source.parallelGroups,
        });
        const currentIndex = source._runtime?.currentIndex ?? 0;
        const nextTopology = reorderParallelGroupPendingSteps(
          topology,
          currentIndex,
          newPendingOrder,
          pendingGroups,
          IN_FLIGHT_EXECUTION_STATES.has(
            source._runtime?.executionState as ExecutionState
          )
        );
        const renumbered = renumberStepReferences(
          topology.steps,
          nextTopology.steps,
          source.finalStep
        );
        return {
          workingFile: {
            ...source,
            steps: renumbered.steps,
            ...(renumbered.finalStep
              ? { finalStep: renumbered.finalStep }
              : {}),
            parallelGroups: nextTopology.parallelGroups,
          },
          result: undefined,
        };
      },
      { lineageRepository }
    );
  }

  /**
   * Addressed undo/redo step-array replace for an idle run. Preserves
   * `_runtime` from the current on-disk step with the same `stepId`; for
   * incoming steps without an ID, it falls back to the same index. Otherwise
   * it trusts whatever `_runtime` the restored snapshot carries. This
   * deliberately does not replicate `PromptQueue.syncStepsForUndoRedo`'s in-memory
   * `runtimeArchive` restoration: that archive is scoped to one live
   * instance's continuous editing session and was never persisted to disk,
   * so an addressed edit against an idle run (no live instance) has no
   * archive to restore from regardless.
   */
  public static async syncStepsForUndoRedoAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    newSteps: WorkflowStep[],
    expectedDefinitionRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository(),
    parallelGroups?: ParallelGroupDefinition[]
  ): Promise<{
    workingFile: WorkingFile;
    definitionRevision: number;
    descriptorRevision: number;
  }> {
    return this.mutateRunDefinition(
      workspaceFolderPath,
      workflowKey,
      runRef,
      expectedDefinitionRevision,
      (source) => {
        const existingTopology = normalizeParallelGroupTopology({
          steps: source.steps ?? [],
          parallelGroups: source.parallelGroups,
        });
        const incomingTopology = normalizeParallelGroupTopology({
          steps: newSteps,
          parallelGroups: parallelGroups ?? existingTopology.parallelGroups,
        });
        const identifiedSteps = ensureStepIds(
          incomingTopology.steps,
          existingTopology.steps
        );
        const nextSteps = identifiedSteps.map((newStep, index) => {
          const persistableStep = stripViewOnlyWorkflowStepFields(newStep);
          const hasExecutionRuntime = Object.keys(
            persistableStep._runtime ?? {}
          ).some((key) => key !== "stepId");
          if (hasExecutionRuntime) {
            return persistableStep;
          }
          const stepId = persistableStep._runtime?.stepId;
          const existing =
            (stepId === undefined
              ? undefined
              : findStepById(existingTopology.steps, stepId)) ??
            (stepId === undefined ? existingTopology.steps[index] : undefined);
          return existing?._runtime
            ? {
                ...persistableStep,
                _runtime: {
                  ...existing._runtime,
                  ...(stepId === undefined ? {} : { stepId }),
                },
              }
            : persistableStep;
        });
        return {
          workingFile: {
            ...source,
            steps: nextSteps,
            parallelGroups: incomingTopology.parallelGroups,
          },
          result: undefined,
        };
      },
      { lineageRepository }
    );
  }

  /**
   * Restores a durable pre-rewind definition. This is deliberately the sole
   * rollback path: the in-memory runtime archive is not crash-safe and must
   * never be used to reconstruct a discarded suffix.
   */
  public static async discardPendingRewind(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    confirmEditedSuffix: boolean = false,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<
    | { discarded: false; hasSuffixEdits: true }
    | {
        discarded: true;
        hasSuffixEdits: boolean;
        workingFile: WorkingFile;
        definitionRevision: number;
        descriptorRevision: number;
      }
  > {
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

    try {
      return await lineageRepository.mutateDescriptorAtRevision<
        | { discarded: false; hasSuffixEdits: true }
        | {
            discarded: true;
            hasSuffixEdits: boolean;
            workingFile: WorkingFile;
            definitionRevision: number;
            descriptorRevision: number;
          }
      >(
        workspaceFolderPath,
        workflowKey,
        expectedDescriptorRevision,
        async (descriptor) => {
          const pending = descriptor.pendingEdit;
          if (
            pending?.kind !== WORKTREE_EDIT_KINDS.REWIND ||
            pending.runRef !== runRef
          ) {
            throw new Error(
              "This run does not have a pending continuation to discard"
            );
          }
          return withFileLock(runFilePath, async () => {
            const current = await readWorkingFileFromDisk(runFilePath);
            const currentRevision = current.definitionRevision ?? 1;
            assertDefinitionRevision(
              expectedDefinitionRevision,
              currentRevision
            );
            const snapshotBytes = await fs.readFile(snapshotPath);
            const base = JSON.parse(
              snapshotBytes.toString("utf8")
            ) as WorkingFile;
            if (
              (base.definitionRevision ?? 1) !== pending.baseDefinitionRevision
            ) {
              throw new Error(
                "Pending continuation snapshot does not match its descriptor"
              );
            }
            const boundary = pending.fromStepIndex;
            const currentSuffix = (current.steps ?? [])
              .slice(boundary)
              .map(
                (step) =>
                  stripStepRuntime([stripViewOnlyWorkflowStepFields(step)])[0]
              );
            const baseSuffix = (base.steps ?? [])
              .slice(boundary)
              .map(
                (step) =>
                  stripStepRuntime([stripViewOnlyWorkflowStepFields(step)])[0]
              );
            const hasSuffixEdits =
              JSON.stringify(currentSuffix) !== JSON.stringify(baseSuffix);
            if (hasSuffixEdits && !confirmEditedSuffix) {
              throw new DiscardConfirmationRequiredError();
            }

            await restoreSnapshotAtomic(runFilePath, snapshotBytes);
            // Never recursively remove this directory: a damaged/foreign entry
            // must survive for investigation rather than being silently erased.
            await fs.unlink(snapshotPath);
            await fs
              .rmdir(
                WorkflowPaths.pendingRewindDir(
                  workspaceFolderPath,
                  workflowKey,
                  runRef
                )
              )
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT")
                  throw error;
              });
            return {
              value: {
                discarded: true as const,
                hasSuffixEdits,
                workingFile: base,
                definitionRevision: base.definitionRevision ?? 1,
                descriptorRevision: expectedDescriptorRevision + 1,
              },
              descriptor: { ...descriptor, pendingEdit: undefined },
            };
          });
        }
      );
    } catch (error) {
      if (error instanceof DiscardConfirmationRequiredError) {
        return { discarded: false, hasSuffixEdits: true };
      }
      throw error;
    }
  }

  /**
   * Commits a pending rewind in place: the rewound-and-possibly-edited current
   * head becomes the run's durable definition, the discard snapshot is removed,
   * and the descriptor's `pendingEdit` marker is cleared. This is the commit
   * counterpart to {@link discardPendingRewind}; continuing a rewound run is an
   * intentional commit, so discard availability ends here. The definition
   * revision is deliberately unchanged — clearing the runtime rewind marker is
   * not a definition edit, and the caller's continuation validates against the
   * same head revision it just observed.
   */
  public static async commitPendingRewind(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<{ definitionRevision: number; descriptorRevision: number }> {
    return lineageRepository.mutateDescriptorAtRevision(
      workspaceFolderPath,
      workflowKey,
      expectedDescriptorRevision,
      async (descriptor) => {
        const pending = descriptor.pendingEdit;
        if (
          pending?.kind !== WORKTREE_EDIT_KINDS.REWIND ||
          pending.runRef !== runRef
        ) {
          throw new Error(
            "This run does not have a pending continuation to commit"
          );
        }
        const definitionRevision =
          await WorkingFileManager.stripPendingRewindFromRunFile(
            workspaceFolderPath,
            workflowKey,
            runRef,
            expectedDefinitionRevision
          );
        return {
          value: {
            definitionRevision,
            descriptorRevision: expectedDescriptorRevision + 1,
          },
          descriptor: { ...descriptor, pendingEdit: undefined },
        };
      }
    );
  }

  /**
   * Remove a run file's `_runtime.pendingRewind` that the lineage descriptor
   * no longer backs (no `pendingEdit` rewinding this run). Such a flag is left
   * behind when an instance that still held the rewind in memory rewrote the
   * run file after the continuation was committed; left alone, it shows the
   * continuation banner forever and cannot be discarded. A descriptor that
   * *does* back the flag is left untouched — that is a real pending
   * continuation. Returns whether anything was removed.
   */
  public static async clearOrphanedPendingRewind(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    lineageRepository: WorkflowLineageRepository = new WorkflowLineageRepository()
  ): Promise<boolean> {
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      runRef
    );
    return withFileLock(
      WorkflowPaths.descriptorPath(workspaceFolderPath, workflowKey),
      async () => {
        const descriptor = await lineageRepository.readDescriptor(
          workspaceFolderPath,
          workflowKey
        );
        if (
          descriptor.pendingEdit?.kind === WORKTREE_EDIT_KINDS.REWIND &&
          descriptor.pendingEdit.runRef === runRef
        ) {
          return false;
        }
        const current = await readWorkingFileFromDisk(runFilePath);
        if (!current._runtime?.pendingRewind) {
          return false;
        }
        Log.warn(
          `[WorkingFileManager] clearing orphaned pendingRewind on ${workflowKey}/${runRef} (descriptor has no matching pendingEdit)`
        );
        await WorkingFileManager.stripPendingRewindFromRunFile(
          workspaceFolderPath,
          workflowKey,
          runRef
        );
        return true;
      }
    );
  }

  /**
   * Drop `_runtime.pendingRewind` from a run file and clean up its rewind
   * snapshot. Callers must already hold the lineage descriptor lock.
   * Returns the run's (unchanged) definition revision.
   */
  private static async stripPendingRewindFromRunFile(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision?: number
  ): Promise<number> {
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
    return withFileLock(runFilePath, async () => {
      const current = await readWorkingFileFromDisk(runFilePath);
      const currentRevision = current.definitionRevision ?? 1;
      if (expectedDefinitionRevision !== undefined) {
        assertDefinitionRevision(expectedDefinitionRevision, currentRevision);
      }
      const nextRuntime = current._runtime
        ? { ...current._runtime }
        : undefined;
      if (nextRuntime) {
        delete nextRuntime.pendingRewind;
      }
      await writeWorkingFileAtomicTo(
        runFilePath,
        { ...current, _runtime: nextRuntime },
        { skipLock: true }
      );
      // Best-effort snapshot cleanup: the run head is now durable, so a
      // leftover snapshot must never be able to overwrite it. Never
      // recursively remove the directory — a damaged/foreign entry must
      // survive for investigation rather than being silently erased.
      await fs.unlink(snapshotPath).catch(() => {});
      await fs
        .rmdir(
          WorkflowPaths.pendingRewindDir(
            workspaceFolderPath,
            workflowKey,
            runRef
          )
        )
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT")
            throw error;
        });
      return currentRevision;
    });
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

    const caller = new Error().stack
      ?.split("\n")
      .slice(2, 6)
      .map((line) => line.trim())
      .join(" <- ");
    Log.trace(
      `[WorkingFileManager] updateWorkingFile requested: ` +
        JSON.stringify({ skipMerge, caller })
    );

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
   * @param alreadyLocked If true, assumes the caller already holds the working-file lock
   */
  public async updateWorkingFileDirect(
    skipMerge: boolean = false,
    alreadyLocked: boolean = false
  ): Promise<void> {
    await this.writeQueueState({ skipMerge, alreadyLocked });
  }

  /**
   * Persist a local definition mutation the queue has already applied in
   * memory. Must run inside the operation queue (`runInQueue`) in the same
   * serialized operation as the mutation, so no other queued write can observe
   * the half-applied state first.
   *
   * `baseDefinitionRevision` is the queue revision the mutation was applied to
   * (before its bump). Under the working-file lock the write is rejected when
   * disk has moved past that base — another process (an MCP append/edit)
   * changed the definition the mutation never saw, and writing memory would
   * drop that change under a fresh revision number. On rejection the queue is
   * re-synchronized from disk (discarding the unpersisted local mutation), so
   * memory and disk agree again. On success the written revision is strictly
   * greater than the one on disk it replaces.
   */
  public async persistDefinitionMutationDirect(
    baseDefinitionRevision: number,
    alreadyLocked: boolean = false
  ): Promise<void> {
    await this.writeQueueState({
      skipMerge: true,
      alreadyLocked,
      definitionBase: baseDefinitionRevision,
    });
  }

  /**
   * Discard an unpersisted local definition mutation by adopting disk's
   * definition and revision. `mergeDiskSteps` is disk-authoritative for step
   * definitions, order and topology, so memory-only edits are dropped while the
   * queue's runtime metadata survives.
   */
  private resyncQueueFromWorkingFile(
    workingFile: WorkingFile,
    authoritativeRuntime = false
  ): void {
    const newStepsFromDisk = this.queueAccess.mergeDiskSteps(
      workingFile.steps ?? [],
      workingFile.parallelGroups,
      { authoritativeRuntime }
    );
    this.queueAccess.setDefinitionRevision(workingFile.definitionRevision ?? 1);
    this.queueAccess.setPendingRewind?.(workingFile._runtime?.pendingRewind);
    if (authoritativeRuntime) {
      this.queueAccess.adoptDiskRuntime?.(workingFile);
    }
    if (newStepsFromDisk.length > 0) {
      this.queueAccess.onDiskStepsMerged?.(newStepsFromDisk);
    }
    this.queueAccess.emitStateChange();
  }

  /**
   * Adopt the current working file snapshot in memory, including an intentional
   * revision rollback such as discarding a pending rewind. Runtime writes use
   * max(disk, memory), so they cannot perform this reconciliation themselves.
   */
  public async resyncQueueFromDisk(): Promise<void> {
    const workingFilePath = this.queueAccess.getWorkingFilePath();
    if (!workingFilePath) return;

    const operation = this.operationQueue.then(async () => {
      const workingFile = await this.readWorkingFile(workingFilePath);
      this.resyncQueueFromWorkingFile(workingFile, true);
    });
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
  }

  private async writeQueueState(options: {
    skipMerge: boolean;
    alreadyLocked: boolean;
    definitionBase?: number;
  }): Promise<void> {
    const { skipMerge, alreadyLocked, definitionBase } = options;
    const workingFilePath = this.queueAccess.getWorkingFilePath();
    if (!workingFilePath) {
      return; // No working file to update
    }
    const isDefinitionMutation = definitionBase !== undefined;

    const update = async () => {
      // Read current working file from disk
      const workingFile = await this.readWorkingFile(workingFilePath);
      const diskDefinitionRevision = workingFile.definitionRevision ?? 1;
      try {
        this.assertExpectedDefinitionRevision(workingFile);
        if (isDefinitionMutation && diskDefinitionRevision > definitionBase) {
          Log.warn(
            `[WorkingFileManager] Rejecting local definition mutation based on revision ${definitionBase}: ` +
              `${workingFilePath} is at revision ${diskDefinitionRevision} (changed by another writer)`
          );
          assertDefinitionRevision(definitionBase, diskDefinitionRevision);
        }
      } catch (error) {
        if (isDefinitionMutation) {
          this.resyncQueueFromWorkingFile(workingFile);
        }
        throw error;
      }
      // CRITICAL FIX: Merge steps from disk instead of blindly overwriting
      // This preserves MCP-appended steps that may have been added while we were running
      // BUT: Skip merge for intentional writes (delete/update) to avoid undoing changes
      if (!skipMerge) {
        const diskSteps = workingFile.steps || [];

        const newStepsFromDisk = this.queueAccess.mergeDiskSteps(
          diskSteps,
          workingFile.parallelGroups
        );

        // If disk has new steps, log and emit state change
        if (newStepsFromDisk.length > 0) {
          Log.info(
            `[WorkingFileManager] updateWorkingFile - Detected ${newStepsFromDisk.length} steps added externally (likely via MCP), merging into queue`
          );

          this.queueAccess.onDiskStepsMerged?.(newStepsFromDisk);

          // Emit state change so dashboard updates
          this.queueAccess.emitStateChange();
        }
      } // End skipMerge check

      // A runtime write carries forward the newer of disk and memory: memory
      // can lag an out-of-process append it has not merged yet, and a runtime
      // flush must never roll that append's revision back. A definition
      // mutation (already checked against disk above) must land strictly
      // above the disk revision it replaces, or a different definition would
      // share a revision number an MCP append already reported (ABA).
      // Deliberate rollbacks (`discardPendingRewind`) are static writers that
      // never pass through here.
      const definitionRevision = isDefinitionMutation
        ? Math.max(
            diskDefinitionRevision + 1,
            this.queueAccess.getDefinitionRevision()
          )
        : Math.max(
            diskDefinitionRevision,
            this.queueAccess.getDefinitionRevision()
          );
      this.queueAccess.setDefinitionRevision(definitionRevision);

      // Now write back the steps array (merged or direct from memory)
      // CRITICAL: Preserve _runtime metadata during save (Phase 4: Per-Prompt Session Management)
      workingFile.steps = this.queueAccess
        .getSteps()
        .map(stripViewOnlyWorkflowStepFields);
      const workflowVars = this.queueAccess.getWorkflowVars?.();
      if (workflowVars !== undefined) {
        workingFile.vars = workflowVars;
      }
      workingFile.parallelGroups = normalizeParallelGroupTopology({
        steps: this.queueAccess.getSteps(),
        parallelGroups: this.queueAccess.getParallelGroups?.() ?? [],
      }).parallelGroups;
      const tokenTotals =
        this.queueAccess.getTokenTotals?.() ??
        workingFile._runtime?.tokenTotals;

      // The finalStep definition remains disk-authoritative, but its per-step
      // execution metadata is owned by PromptQueue just like queue-step runtime.
      // Copy only `_runtime` so a runtime flush cannot overwrite a concurrent
      // definition/property edit to the finalStep itself.
      if (
        workingFile.finalStep &&
        this.queueAccess.getFinalStepExecutionMetadata
      ) {
        const { _runtime: _diskRuntime, ...finalStepDefinition } =
          workingFile.finalStep;
        const finalStepExecutionMetadata =
          this.queueAccess.getFinalStepExecutionMetadata();
        workingFile.finalStep = finalStepExecutionMetadata
          ? { ...finalStepDefinition, _runtime: finalStepExecutionMetadata }
          : finalStepDefinition;
      }
      // Count steps with _runtime metadata (Phase 4: Session Management)
      const stepsWithRuntime = workingFile.steps.filter(
        (p) => p._runtime
      ).length;
      Log.trace(
        `[WorkingFileManager] updateWorkingFile - Writing ${workingFile.steps.length} steps to ${workingFilePath}, ` +
          `_runtime: ${stepsWithRuntime}/${workingFile.steps.length} steps`
      );

      workingFile.definitionRevision = definitionRevision;

      // Update workflow-level runtime state
      // completedPrompts is no longer written; per-prompt _runtime.completedAt is the source of truth
      const finalStepRuntime = this.queueAccess.getFinalStepRuntime();
      const activeParallelGroup =
        this.queueAccess.getActiveParallelGroupRuntime?.();
      workingFile._runtime = {
        currentIndex: this.queueAccess.getCurrentIndex(),
        executionState: this.queueAccess.getStatus(),
        ...(tokenTotals ? { tokenTotals } : {}),
        ...this.getPersistedExecutionTiming(),
        ...(finalStepRuntime ? { finalStep: finalStepRuntime } : {}),
        ...(activeParallelGroup ? { activeParallelGroup } : {}),
        ...(this.queueAccess.getPendingRewind?.()
          ? { pendingRewind: this.queueAccess.getPendingRewind() }
          : {}),
        ...(workingFile._runtime?.worktree
          ? { worktree: workingFile._runtime.worktree }
          : {}),
        ...(workingFile._runtime?.lastActivityAt !== undefined
          ? { lastActivityAt: workingFile._runtime.lastActivityAt }
          : {}),
      };

      // Write atomically while holding lock
      await this.writeWorkingFileAtomic(workingFilePath, workingFile, {
        skipLock: true,
        operation: "updateWorkingFileDirect",
        attemptedFields: [
          "steps",
          "finalStep._runtime",
          "definitionRevision",
          "_runtime",
        ],
      });
    };

    if (alreadyLocked) {
      await update();
    } else {
      await withFileLock(workingFilePath, update);
    }
  }

  private getPersistedExecutionTiming(): Pick<
    WorkingFileRuntime,
    "startTime" | "pausedTime" | "totalPausedDuration" | "executionEndTime"
  > {
    const { startTime, pausedTime, totalPausedDuration, executionEndTime } =
      this.queueAccess.getRuntimeState?.() ?? {
        status: this.queueAccess.getStatus(),
        stopped: false,
        totalPausedDuration: 0,
      };
    return {
      ...(startTime !== undefined ? { startTime } : {}),
      ...(pausedTime !== undefined ? { pausedTime } : {}),
      ...(startTime !== undefined || totalPausedDuration > 0
        ? { totalPausedDuration }
        : {}),
      ...(executionEndTime !== undefined ? { executionEndTime } : {}),
    };
  }

  /** Patch persisted worktree lifecycle metadata for an addressed run. */
  public static async updateWorktreeRuntimeAtRun(
    workspaceFolderPath: string,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    patch: WorkingFileWorktreeRuntimePatch
  ): Promise<void> {
    const workingFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      runRef
    );
    await withFileLock(workingFilePath, async () => {
      const workingFile = await readWorkingFileFromDisk(workingFilePath);
      const currentRuntime = workingFile._runtime ?? {
        currentIndex: 0,
        executionState: EXECUTION_STATES.IDLE,
      };
      const nextRuntime = {
        ...currentRuntime,
        worktree: {
          ...currentRuntime.worktree,
          ...patch,
          updatedAt: patch.updatedAt ?? Date.now(),
        } as NonNullable<typeof currentRuntime.worktree>,
      };
      workingFile._runtime = nextRuntime;
      await writeWorkingFileAtomicTo(workingFilePath, workingFile, {
        skipLock: true,
        operation: "updateWorktreeRuntimeAtRun",
        attemptedFields: ["_runtime.worktree"],
      });
    });
  }

  /**
   * Atomically patch the disk-authoritative worktree runtime block.
   *
   * Worktree lifecycle metadata is intentionally kept out of PromptQueue's
   * state projection. This operation serializes with ordinary runtime and
   * definition writes, preserves every queue-owned runtime field, and never
   * changes definitionRevision.
   */
  public async updateWorktreeRuntime(
    patch: WorkingFileWorktreeRuntimePatch
  ): Promise<void> {
    const workingFilePath = this.queueAccess.getWorkingFilePath();
    if (!workingFilePath) {
      return;
    }

    const operation = this.operationQueue.then(async () => {
      await withFileLock(workingFilePath, async () => {
        const workingFile = await this.readWorkingFile(workingFilePath);
        const currentRuntime = workingFile._runtime ?? {
          currentIndex: this.queueAccess.getCurrentIndex(),
          executionState: this.queueAccess.getStatus(),
        };
        const nextRuntime = {
          ...currentRuntime,
          worktree: {
            ...currentRuntime.worktree,
            ...patch,
            updatedAt: patch.updatedAt ?? Date.now(),
          } as NonNullable<typeof currentRuntime.worktree>,
        };
        workingFile._runtime = nextRuntime;
        await this.writeWorkingFileAtomic(workingFilePath, workingFile, {
          skipLock: true,
          operation: "updateWorktreeRuntime",
          attemptedFields: ["_runtime.worktree"],
        });
      });
    });
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
  }

  /** Persist a run-scoped notice without manufacturing a worktree runtime block. */
  public async updateWorktreeNotice(notice: string): Promise<void> {
    const workingFilePath = this.queueAccess.getWorkingFilePath();
    if (!workingFilePath) {
      return;
    }

    const operation = this.operationQueue.then(async () => {
      await withFileLock(workingFilePath, async () => {
        const workingFile = await this.readWorkingFile(workingFilePath);
        const currentRuntime = workingFile._runtime ?? {
          currentIndex: this.queueAccess.getCurrentIndex(),
          executionState: this.queueAccess.getStatus(),
        };
        const nextRuntime = {
          ...currentRuntime,
          worktreeNotice: notice,
        };
        workingFile._runtime = nextRuntime;
        await this.writeWorkingFileAtomic(workingFilePath, workingFile, {
          skipLock: true,
          operation: "updateWorktreeNotice",
          attemptedFields: ["_runtime.worktreeNotice"],
        });
      });
    });
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
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

        // Properties aren't part of the restricted prefix/suffix a pending
        // rewind protects (only step topology is, via PromptQueue's own
        // assertNoPendingRewindWorkflowMutation/assertPendingRewindSuffixIndex
        // guards) — mirrors updatePropertiesAtRun's allowDuringPendingRewind.
        // Discard Continuation still reverts these via its separate base
        // snapshot, taken before this write.

        appliedKeys.push(
          ...applyWorkflowPropertyWrites(
            workingFile as unknown as Record<string, unknown>,
            properties,
            {
              onlyIfUndefined: options.onlyIfUndefined,
              allowDeletes: options.allowDeletes,
            }
          )
        );
        let modified = appliedKeys.length > 0;

        if (options.ensureHarnessAndModel) {
          if (!workingFile.harness) {
            workingFile.harness = ConfigurationUtils.getIntegrationMode();
            modified = true;
            appliedKeys.push("harness");
          }

          if (!workingFile.model) {
            workingFile.model = ConfigurationUtils.getModelForHarness(
              workingFile.harness
            );
            modified = true;
            appliedKeys.push("model");
          }
        }

        if (modified) {
          workingFile.definitionRevision =
            (workingFile.definitionRevision ?? 1) + 1;
          await this.writeWorkingFileAtomic(workingFilePath, workingFile, {
            skipLock: true,
            operation: "updateWorkingFileProperties",
            attemptedFields: [
              ...Object.keys(properties),
              "harness",
              "model",
              "definitionRevision",
            ],
          });
          this.queueAccess.setDefinitionRevision(
            workingFile.definitionRevision
          );
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
    const operation = this.operationQueue.then(fn);
    this.operationQueue = operation.then(
      () => undefined,
      (err) => {
        Log.error(
          `[WorkingFileManager] operationQueue: serialized operation failed: ${getErrorMessage(err)}`
        );
      }
    );
    await operation;
  }

  /**
   * Run a serialized queue operation while holding the working-file lock.
   * The callback must use `updateWorkingFileDirect(true, true)` for writes.
   */
  public async runInQueueWithWorkingFileLock<T>(
    fn: () => Promise<T>
  ): Promise<T> {
    const operation = this.operationQueue.then(async () => {
      const workingFilePath = this.queueAccess.getWorkingFilePath();
      if (!workingFilePath) {
        return fn();
      }
      return withFileLock(workingFilePath, fn);
    });
    this.operationQueue = operation.then(
      () => undefined,
      (err) => {
        Log.error(
          `[WorkingFileManager] operationQueue: locked operation failed: ${getErrorMessage(err)}`
        );
      }
    );
    return operation;
  }
}
