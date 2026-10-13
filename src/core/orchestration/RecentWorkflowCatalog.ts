import * as path from "path";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";
import {
  isScriptStep,
  frozenActiveExecutionMs,
  type PromptStep,
  type WorkingFile,
  type WorkflowKey,
  type WorkflowRunNavigationSummary,
  type WorkflowSummary,
  type WorkflowViewAddress,
} from "../../types/CtrlYokeTypes";
import type {
  RecentWorkflowEntry,
  RecentWorkflowUpdatedMessage,
} from "../../types/WebviewMessageTypes";
import { readJsonFile } from "../../utils/FileSystemUtils";
import {
  getLineageLastModifiedAt,
  stripLegacyWorkingFileLineageMetadata,
} from "../../utils/WorkingFileMetadata";
import { PropertyResolver } from "../../utils/PropertyResolver";
import { isUnstartedRunFile } from "../../utils/StepStatusDerivation";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { Log } from "../../utils/Log";
import type { OutputHistoryManager } from "./OutputHistoryManager";
import type { WorkflowLineageRepository } from "./WorkflowLineageRepository";

/** Delay that coalesces a burst of state changes into one row rebuild. */
export const RECENT_WORKFLOW_PUBLISH_DELAY_MS = 150;

let lastRecentWorkflowsSequence = 0;

/**
 * Orders full recent-workflow lists against single-row pushes. Taken *before*
 * the disk reads it covers, so a list that was still scanning when a row was
 * pushed carries a lower sequence than that row, however late it arrives.
 * Clock-based rather than a plain counter so it stays monotonic across an
 * extension-host restart that a client survives.
 */
export function nextRecentWorkflowsSequence(): number {
  lastRecentWorkflowsSequence = Math.max(
    lastRecentWorkflowsSequence + 1,
    Date.now()
  );
  return lastRecentWorkflowsSequence;
}

export interface RecentWorkflowCatalogHost {
  /** Every loaded instance plus external watch sessions. */
  getWorkflowSummaries(): readonly WorkflowSummary[];
  /** True when a proven external process is executing this working file. */
  ensureExternalRunWatchSession(filePath: string): Promise<boolean>;
  getOutputHistoryManager(workspaceRoot: string): OutputHistoryManager;
}

export interface RecentWorkflowList {
  workflows: RecentWorkflowEntry[];
  /** See `RecentWorkflowsMessage.seq`. */
  seq: number;
}

interface ScanContext {
  workspaceRoot: string;
  historyManager: OutputHistoryManager;
  activeWorkingFilePaths: ReadonlySet<string>;
}

function isActiveRecentState(state: string): boolean {
  return (
    state === EXECUTION_STATES.RUNNING || state === EXECUTION_STATES.PAUSING
  );
}

/**
 * Builds the workflow dropdown's lineage rows from run storage. The full list
 * (`listEntries`) reads every lineage and takes seconds once a project holds
 * thousands; `buildEntry` reads one, which is what lets a changed lineage be
 * pushed on its own.
 */
export class RecentWorkflowCatalog {
  /** The full scan in flight, shared by every request that arrives meanwhile. */
  private inFlightList?: {
    workspaceRoot: string;
    result: Promise<RecentWorkflowList>;
  };

  constructor(
    private readonly lineageRepository: WorkflowLineageRepository,
    private readonly host: RecentWorkflowCatalogHost
  ) {}

  /**
   * Every lineage's row, most recently modified first, with the sequence taken
   * before the scan began. Concurrent callers share one scan: every dropdown
   * open and every client reconnect asks, and parallel scans of thousands of
   * lineages saturate the fs threadpool that everything else waits on. A
   * shared scan can predate a caller's request, but anything that changed a
   * loaded lineage since is pushed as a row with a higher sequence. A caller
   * that just mutated history itself (delete, restore) passes `fresh`, since
   * a scan begun before its write would undo it on screen.
   */
  list(
    workspaceRoot: string,
    options: { fresh?: boolean } = {}
  ): Promise<RecentWorkflowList> {
    if (!options.fresh && this.inFlightList?.workspaceRoot === workspaceRoot) {
      return this.inFlightList.result;
    }
    const seq = nextRecentWorkflowsSequence();
    const result = this.listEntries(workspaceRoot).then((workflows) => ({
      workflows,
      seq,
    }));
    const inFlight = { workspaceRoot, result };
    this.inFlightList = inFlight;
    const clear = () => {
      if (this.inFlightList === inFlight) {
        this.inFlightList = undefined;
      }
    };
    result.then(clear, clear);
    return result;
  }

  private async listEntries(
    workspaceRoot: string
  ): Promise<RecentWorkflowEntry[]> {
    const workflowKeys =
      await this.lineageRepository.listLineageKeys(workspaceRoot);
    if (workflowKeys.length === 0) {
      return [];
    }
    const context = this.createScanContext(workspaceRoot);
    const entries = (
      await Promise.all(
        workflowKeys.map((workflowKey) => this.readEntry(context, workflowKey))
      )
    ).filter((entry): entry is RecentWorkflowEntry => entry !== null);

    // A run that finished while the scan was reading is still marked running
    // in what was read, and its instance's completion broadcast has already
    // gone out — the list would land after it and resurrect a running row.
    // Re-read just those rows against the live set as it is now.
    const stillActive = this.collectActiveWorkingFilePaths();
    const settled = await Promise.all(
      entries.map((entry) =>
        isActiveRecentState(entry.executionState) &&
        !stillActive.has(this.entryFilePath(workspaceRoot, entry.address))
          ? this.readEntry(
              { ...context, activeWorkingFilePaths: stillActive },
              entry.address.workflowKey
            )
          : entry
      )
    );

    return settled
      .filter((entry): entry is RecentWorkflowEntry => entry !== null)
      .sort((a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0));
  }

  /**
   * One lineage's row, or null when it has no readable descriptor or
   * primary working file yet. `live` overlays what an executing instance knows
   * before its working file is flushed.
   */
  async buildEntry(
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    live?: Pick<WorkflowSummary, "executionState" | "totalSteps">
  ): Promise<RecentWorkflowEntry | null> {
    const entry = await this.readEntry(
      this.createScanContext(workspaceRoot),
      workflowKey
    );
    if (!entry || !live) {
      return entry;
    }
    return {
      ...entry,
      executionState: live.executionState,
      totalSteps: live.totalSteps,
    };
  }

  private createScanContext(workspaceRoot: string): ScanContext {
    return {
      workspaceRoot,
      historyManager: this.host.getOutputHistoryManager(workspaceRoot),
      activeWorkingFilePaths: this.collectActiveWorkingFilePaths(),
    };
  }

  /** Working files of in-memory instances that are executing or paused. */
  private collectActiveWorkingFilePaths(): Set<string> {
    return new Set<string>(
      this.host
        .getWorkflowSummaries()
        .filter(
          (s) =>
            s.executionState === EXECUTION_STATES.RUNNING ||
            s.executionState === EXECUTION_STATES.PAUSING ||
            s.executionState === EXECUTION_STATES.PAUSED
        )
        .map((s) => s.workingFilePath)
        .filter((p): p is string => p !== undefined)
    );
  }

  private entryFilePath(
    workspaceRoot: string,
    address: WorkflowViewAddress
  ): string {
    return address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
      ? WorkflowPaths.runFilePath(
          workspaceRoot,
          address.workflowKey,
          address.runRef
        )
      : WorkflowPaths.draftFilePath(workspaceRoot, address.workflowKey);
  }

  private async readEntry(
    context: ScanContext,
    workflowKey: WorkflowKey
  ): Promise<RecentWorkflowEntry | null> {
    const { workspaceRoot } = context;
    let address: WorkflowViewAddress;
    let descriptor;
    try {
      descriptor = await this.lineageRepository.readDescriptor(
        workspaceRoot,
        workflowKey
      );
      address = descriptor.latestRunRef
        ? {
            workflowKey,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: descriptor.latestRunRef,
          }
        : { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT };
    } catch (error) {
      Log.warn(
        `[RecentWorkflowCatalog] Failed to read lineage descriptor ${workflowKey}:`,
        error
      );
      return null;
    }

    const filePath = this.entryFilePath(workspaceRoot, address);
    const runDirectory =
      address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
        ? WorkflowPaths.runDir(
            workspaceRoot,
            address.workflowKey,
            address.runRef
          )
        : WorkflowPaths.draftDir(workspaceRoot, address.workflowKey);

    try {
      const workingFile = stripLegacyWorkingFileLineageMetadata(
        (await readJsonFile(filePath)) as WorkingFile
      );
      const { runCount, primaryRunId } =
        await context.historyManager.getRunNavigationSummary(workflowKey);
      const hasDraft =
        !descriptor.latestRunRef ||
        descriptor.pendingEdit?.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT;
      const runNav: WorkflowRunNavigationSummary = {
        primaryAddress: address,
        primaryRunId,
        runCount,
        hasDraft,
        ...(hasDraft
          ? {
              draftDirectory: WorkflowPaths.draftDir(
                workspaceRoot,
                workflowKey
              ),
            }
          : {}),
      };

      const lastModified = await getLineageLastModifiedAt(
        workspaceRoot,
        workflowKey,
        descriptor.lastModifiedAt
      );

      let executionState: RecentWorkflowEntry["executionState"] =
        workingFile._runtime?.executionState || EXECUTION_STATES.IDLE;

      // Normalize stale active state: if the disk says "running" or
      // "pausing" but no in-memory workflow is actually executing this
      // file, show STOPPED.
      // This guards against race windows before normalizeStaleLocks finishes.
      // HOWEVER: first check whether the lock file says the CLI is actively
      // running it — this bridges the timing gap where the runner.json
      // file-watcher hasn't fired yet (common on Windows due to watcher latency).
      if (
        isActiveRecentState(executionState) &&
        !context.activeWorkingFilePaths.has(filePath)
      ) {
        const registeredExternalWatch =
          await this.host.ensureExternalRunWatchSession(filePath);
        if (registeredExternalWatch) {
          Log.trace(
            `[RecentWorkflowCatalog] "${workflowKey}" has an active external lock — keeping running state (ExternalRunWatchSession registered)`
          );
          // executionState stays "running"; the session is now in externalRunSessions
          // so the next GET_WORKFLOWS_LIST will move it to the Running section.
        } else {
          Log.trace(
            `[RecentWorkflowCatalog] normalizing "${workflowKey}" running → stopped (not in activeWorkingFilePaths: [${[...context.activeWorkingFilePaths].map((p) => path.basename(p)).join(", ") || "none"}])`
          );
          executionState = EXECUTION_STATES.STOPPED;
        }
      }

      const steps = Array.isArray(workingFile.steps) ? workingFile.steps : [];
      const firstAiStepHarness = steps.find(
        (s): s is PromptStep => !isScriptStep(s)
      )?.harness;
      const harness = PropertyResolver.resolveHarnessValue(
        firstAiStepHarness,
        workingFile.harness
      );

      return {
        address,
        runDirectory,
        workflowName: descriptor.workflowName || workflowKey,
        executionState,
        stopReason: workingFile._runtime?.stopReason,
        startedAt: workingFile.startedAt || 0,
        lastModifiedAt: lastModified,
        isFavorite: descriptor.isFavorite,
        totalSteps: steps.length,
        harness,
        // A draft is unstarted by definition and already shows Run; the
        // flag distinguishes a prepared run from an ordinary idle one.
        ...(address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        isUnstartedRunFile(workingFile)
          ? { unstarted: true }
          : {}),
        tokenTotals: workingFile._runtime?.tokenTotals,
        activeExecutionMs: frozenActiveExecutionMs(workingFile._runtime ?? {}),
        worktree: workingFile._runtime?.worktree
          ? {
              branchName: workingFile._runtime.worktree.branchName,
              worktreePath: workingFile._runtime.worktree.worktreePath,
            }
          : undefined,
        runNav,
      };
    } catch (error) {
      Log.warn(
        `[RecentWorkflowCatalog] Failed to parse workflow file ${workflowKey}:`,
        error
      );
      return null;
    }
  }
}

/**
 * Pushes a loaded lineage's rebuilt dropdown row to every client whenever
 * something the row shows changes — a new lineage, a new run, a state
 * transition, a rename, a step added. Without it a row only refreshes on the
 * next full `GET_RECENT_WORKFLOWS` rescan, which is what left a just-created
 * workflow missing from the dropdown, and a finished one still badged
 * running, for as long as that rescan took.
 */
export class RecentWorkflowPublisher {
  /** Last published row signature per lineage; unchanged summaries are skipped. */
  private readonly signatures = new Map<WorkflowKey, string>();
  private readonly pending = new Map<
    WorkflowKey,
    { summary: WorkflowSummary; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly catalog: RecentWorkflowCatalog,
    private readonly getWorkspaceRoot: () => string | undefined,
    private readonly broadcast: (message: RecentWorkflowUpdatedMessage) => void,
    private readonly delayMs = RECENT_WORKFLOW_PUBLISH_DELAY_MS
  ) {}

  observe(summary: WorkflowSummary): void {
    const workflowKey = summary.workflowKey;
    if (!workflowKey) {
      return;
    }
    const signature = [
      summary.runRef ?? "",
      summary.executionState,
      summary.workflowName,
      summary.totalSteps,
    ].join("|");
    if (this.signatures.get(workflowKey) === signature) {
      return;
    }
    this.signatures.set(workflowKey, signature);

    const existing = this.pending.get(workflowKey);
    if (existing) {
      existing.summary = summary;
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.pending.get(workflowKey);
      this.pending.delete(workflowKey);
      if (entry) {
        void this.publish(workflowKey, entry.summary);
      }
    }, this.delayMs);
    timer.unref?.();
    this.pending.set(workflowKey, { summary, timer });
  }

  dispose(): void {
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.signatures.clear();
  }

  private async publish(
    workflowKey: WorkflowKey,
    summary: WorkflowSummary
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }
    try {
      const seq = nextRecentWorkflowsSequence();
      const workflow = await this.catalog.buildEntry(
        workspaceRoot,
        workflowKey,
        summary
      );
      if (!workflow) {
        // No readable draft or run yet. Forget the signature so the next
        // summary retries even if nothing the row shows has changed.
        this.signatures.delete(workflowKey);
        return;
      }
      this.broadcast({
        type: MESSAGE_TYPES.RECENT_WORKFLOW_UPDATED,
        workflow,
        seq,
      });
    } catch (error) {
      Log.warn(
        `[RecentWorkflowPublisher] Failed to publish recent row for ${workflowKey}:`,
        error
      );
    }
  }
}
