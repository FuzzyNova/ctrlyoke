import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import {
  HISTORY_TRASH_ENTRY_KINDS,
  MESSAGE_TYPES,
  WORKFLOW_LOCK_LIVENESS,
  type HistoryTrashEntryKind,
} from "../../types/DashboardConstants";
import type {
  HistoryClearPreview,
  HistoryTrashEntry,
  HistoryTrashEntrySummary,
  HistoryTrashItem,
  HistoryTrashRestoreResult,
} from "../../types/HistoryTrashTypes";
import type { HistoryTrashedMessage } from "../../types/WebviewMessageTypes";
import {
  describeTrashEntry,
  TRASH_ENTRY_GONE_MESSAGE,
} from "../../utils/HistoryTrashDescriptions";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  renameWithTransientRetry,
  writeFileAtomic,
} from "../../utils/AtomicFileUtils";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";
import { readWorkflowLockInspection } from "../../utils/WorkflowLockInspector";
import { isProcessAlive } from "../../utils/LockSafetyPrimitives";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { Log } from "../../utils/Log";
import {
  deriveWorkflowNameFromKey,
  WorkflowLineageRepository,
} from "./WorkflowLineageRepository";
import { getSharedHistorySearchIndexService } from "./HistorySearchIndexServiceRegistry";

const ENTRY_FILE_NAME = "entry.json";
const OWNER_FILE_NAME = "owner.json";
const PAYLOAD_DIR_NAME = "payload";
const RUN_MANIFEST_FILE_NAME = "manifest.json";
const ENTRY_SCHEMA_VERSION =
  CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.HISTORY_TRASH_ENTRY];
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A `.pending` entry untouched for this long belongs to a delete that crashed
 * part-way. Anything younger may be another process still moving files in.
 */
const STALE_PENDING_ENTRY_MS = 5 * 60 * 1000;
/**
 * Moving a lineage is a directory rename, and Windows refuses it while another
 * handle is open inside. Brief holders (an antivirus pass, a search-index
 * rebuild reading a run) let go within this window; a directory watcher never
 * does, which is what {@link movePath}'s copy fallback is for.
 */
const MOVE_RENAME_BUDGET_MS = 2_000;
/** Moving the files out one by one works where renaming their directory cannot. */
const COPY_FALLBACK_ERROR_CODES = new Set([
  "EXDEV",
  "EPERM",
  "EACCES",
  "EBUSY",
]);

const LOG_PREFIX = "[HistoryTrash]";

/** `requestedBy` values for deletes that do not come from a dashboard client. */
export const HISTORY_TRASH_REQUESTERS = {
  CLI: "cli",
  UNKNOWN: "unknown",
  RECOVERED: "recovered",
} as const;

/** Thrown when a delete targets a lineage that has a live run. */
export class LiveLineageDeleteError extends Error {
  constructor(readonly workflowKey: WorkflowKey) {
    super(
      `"${deriveWorkflowNameFromKey(workflowKey)}" is running. Stop it before deleting it.`
    );
    this.name = "LiveLineageDeleteError";
  }
}

/** Callers that know about in-process executions report them here. */
export type ExecutingLineagePredicate = (workflowKey: WorkflowKey) => boolean;

/**
 * Moves a path, preferring a same-volume rename. Falls back to copy-then-delete
 * when the rename is refused: on Windows a directory cannot be renamed while
 * anything holds a handle inside it, and VS Code watches the directory of
 * every open workflow's run file, so the workflow on screen is exactly the
 * one whose rename always fails. Deleting its files one by one still works,
 * as the permanent delete this replaced always did. The copy is complete
 * before anything is deleted, so a failure never loses the only copy.
 */
async function movePath(source: string, destination: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  try {
    await renameWithTransientRetry(source, destination, {
      budgetMs: MOVE_RENAME_BUDGET_MS,
    });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!COPY_FALLBACK_ERROR_CODES.has(code)) {
      throw error;
    }
    Log.info(
      `${LOG_PREFIX} rename refused (${code}); copying instead: ${source}`
    );
  }
  try {
    await fs.promises.cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (error) {
    await fs.promises.rm(destination, { recursive: true, force: true });
    throw error;
  }
  try {
    await fs.promises.rm(source, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch (error) {
    // Every file is safely in the destination; only an emptied directory
    // (or a file something still holds) is left behind.
    Log.warn(
      `${LOG_PREFIX} moved ${source} but could not remove all of it: ${getErrorMessage(error)}`
    );
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(child);
    } else if (entry.isFile()) {
      try {
        total += (await fs.promises.stat(child)).size;
      } catch {
        // Vanished mid-walk; it no longer takes space.
      }
    }
  }
  return total;
}

async function readRunId(runDir: string): Promise<number | undefined> {
  try {
    const manifest = JSON.parse(
      await fs.promises.readFile(
        path.join(runDir, RUN_MANIFEST_FILE_NAME),
        "utf8"
      )
    ) as { runId?: unknown };
    return typeof manifest.runId === "number" ? manifest.runId : undefined;
  } catch {
    return undefined;
  }
}

async function listRunDirNames(dir: string): Promise<RunRef[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => WorkflowPaths.isRunDirEntry(entry))
      .map((entry) => entry.name as RunRef);
  } catch {
    return [];
  }
}

function newEntryId(now: number): string {
  // Sorts by deletion time as a plain string, like a RunRef does.
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function describeItems(items: readonly HistoryTrashItem[]): string {
  const lineages = items.filter((item) => item.wholeLineage).length;
  const runs = items.reduce((count, item) => count + item.runRefs.length, 0);
  return `lineages=${lineages} runs=${runs}`;
}

/**
 * One Recently deleted entry being assembled. Everything a single user action
 * deletes goes into one batch, so one Undo puts all of it back.
 *
 * The batch lives in `<id>.pending/` until {@link commit} writes `entry.json`
 * and renames it into place. A crash in between leaves a pending directory
 * that {@link HistoryTrashRepository.recoverPendingEntries} finishes later, so
 * nothing moved out of `.runs` is ever unreachable.
 */
export class HistoryTrashBatch {
  private readonly items = new Map<WorkflowKey, HistoryTrashItem>();
  private readonly skippedLive: WorkflowKey[] = [];
  private created = false;

  constructor(
    private readonly repository: HistoryTrashRepository,
    readonly entryId: string,
    readonly kind: HistoryTrashEntryKind,
    readonly requestedBy: string,
    private readonly deletedAt: number
  ) {}

  get isEmpty(): boolean {
    return this.items.size === 0;
  }

  private get pendingDir(): string {
    return WorkflowPaths.pendingTrashEntryDir(
      this.repository.stateRoot,
      this.entryId
    );
  }

  private payloadPath(workflowKey: WorkflowKey, runRef?: RunRef): string {
    const lineagePayload = path.join(
      this.pendingDir,
      PAYLOAD_DIR_NAME,
      workflowKey
    );
    return runRef ? path.join(lineagePayload, runRef) : lineagePayload;
  }

  private async ensureCreated(): Promise<void> {
    if (this.created) return;
    await fs.promises.mkdir(path.join(this.pendingDir, PAYLOAD_DIR_NAME), {
      recursive: true,
    });
    await writeFileAtomic(
      path.join(this.pendingDir, OWNER_FILE_NAME),
      JSON.stringify({ pid: process.pid, host: os.hostname() })
    );
    this.created = true;
  }

  private itemFor(workflowKey: WorkflowKey, workflowName: string) {
    let item = this.items.get(workflowKey);
    if (!item) {
      item = {
        workflowKey,
        workflowName,
        wholeLineage: false,
        runRefs: [],
        runIds: [],
      };
      this.items.set(workflowKey, item);
    }
    return item;
  }

  /**
   * Moves one run directory in. Shaped for `WorkflowLineageRepository.deleteRun`'s
   * `removeRunDir`, which calls it under the lineage's descriptor lock.
   */
  async moveRunDir(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    runDir: string
  ): Promise<void> {
    const runId = await readRunId(runDir);
    const workflowName = await this.repository.readWorkflowName(workflowKey);
    await this.ensureCreated();
    await movePath(runDir, this.payloadPath(workflowKey, runRef));
    const item = this.itemFor(workflowKey, workflowName);
    item.runRefs.push(runRef);
    if (runId !== undefined) item.runIds.push(runId);
  }

  /** Moves a whole lineage directory in: descriptor, draft, and every run. */
  async moveLineageDir(workflowKey: WorkflowKey): Promise<void> {
    const lineageDir = WorkflowPaths.lineageDir(
      this.repository.stateRoot,
      workflowKey
    );
    const workflowName = await this.repository.readWorkflowName(workflowKey);
    const runRefs = await listRunDirNames(lineageDir);
    const runIds = (
      await Promise.all(
        runRefs.map((runRef) => readRunId(path.join(lineageDir, runRef)))
      )
    ).filter((runId): runId is number => runId !== undefined);
    await this.ensureCreated();
    const payloadLineageDir = this.payloadPath(workflowKey);
    const existingItem = this.items.get(workflowKey);
    if (await pathExists(payloadLineageDir)) {
      // A delete-last-run operation may already have moved its run directory
      // into this batch. Merge the remaining descriptor/draft into that same
      // payload so one Undo restores the complete lineage.
      for (const name of await fs.promises.readdir(lineageDir)) {
        await movePath(
          path.join(lineageDir, name),
          path.join(payloadLineageDir, name)
        );
      }
      await fs.promises.rm(lineageDir, { recursive: true, force: true });
    } else {
      await movePath(lineageDir, payloadLineageDir);
    }
    this.items.set(workflowKey, {
      workflowKey,
      workflowName,
      wholeLineage: true,
      runRefs: [...new Set([...(existingItem?.runRefs ?? []), ...runRefs])],
      runIds: [...new Set([...(existingItem?.runIds ?? []), ...runIds])],
    });
  }

  markSkippedLive(workflowKey: WorkflowKey): void {
    this.skippedLive.push(workflowKey);
  }

  getSkippedLive(): readonly WorkflowKey[] {
    return this.skippedLive;
  }

  /**
   * Publishes the entry. Returns undefined, and leaves nothing behind, when
   * nothing was moved in.
   */
  async commit(): Promise<HistoryTrashEntry | undefined> {
    if (this.isEmpty) {
      if (this.created) {
        await fs.promises.rm(this.pendingDir, { recursive: true, force: true });
      }
      return undefined;
    }
    const entry: HistoryTrashEntry = {
      schemaVersion: ENTRY_SCHEMA_VERSION,
      id: this.entryId,
      kind: this.kind,
      deletedAt: this.deletedAt,
      requestedBy: this.requestedBy,
      items: [...this.items.values()],
      skippedLive: [...this.skippedLive],
      bytes: await directorySize(path.join(this.pendingDir, PAYLOAD_DIR_NAME)),
    };
    await this.repository.publishEntry(this.pendingDir, entry);
    Log.info(
      `${LOG_PREFIX} trashed kind=${entry.kind} ${describeItems(entry.items)} skippedLive=${entry.skippedLive.length} requestedBy=${entry.requestedBy} id=${entry.id}`
    );
    for (const item of entry.items) {
      Log.info(
        `${LOG_PREFIX}   ${item.workflowKey}${item.wholeLineage ? " (whole workflow)" : ` runs=${item.runRefs.join(",")}`}`
      );
    }
    return entry;
  }
}

/**
 * Recently deleted run history for one project: `.trash/` beside `.runs/`.
 *
 * User-initiated history deletes (a run, a workflow, "Delete all runs", Clear
 * all history) move directories in here instead of removing them, and
 * {@link purgeExpired} removes them for good after the retention window.
 * Retention pruning under `runs.maxRuns` stays a permanent delete.
 */
export class HistoryTrashRepository {
  constructor(
    readonly stateRoot: string,
    private readonly lineageRepository = new WorkflowLineageRepository()
  ) {}

  get root(): string {
    return WorkflowPaths.trashRoot(this.stateRoot);
  }

  begin(kind: HistoryTrashEntryKind, requestedBy: string): HistoryTrashBatch {
    const now = Date.now();
    return new HistoryTrashBatch(this, newEntryId(now), kind, requestedBy, now);
  }

  async readWorkflowName(workflowKey: WorkflowKey): Promise<string> {
    return this.lineageRepository.readWorkflowDisplayName(
      this.stateRoot,
      workflowKey
    );
  }

  /** True when a runner lock names a live owner, or the caller knows one is executing. */
  async isLineageLive(
    workflowKey: WorkflowKey,
    isExecuting?: ExecutingLineagePredicate
  ): Promise<boolean> {
    if (isExecuting?.(workflowKey)) return true;
    try {
      const inspection = await readWorkflowLockInspection(
        this.stateRoot,
        workflowKey
      );
      return inspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE;
    } catch (error) {
      // An unreadable lock cannot prove the lineage idle; keep it.
      Log.warn(
        `${LOG_PREFIX} could not inspect runner lock for ${workflowKey}; treating it as live: ${getErrorMessage(error)}`
      );
      return true;
    }
  }

  /** Moves one whole lineage to Recently deleted, refusing a live one. */
  async trashLineage(
    workflowKey: WorkflowKey,
    requestedBy: string,
    isExecuting?: ExecutingLineagePredicate
  ): Promise<HistoryTrashEntry | undefined> {
    if (await this.isLineageLive(workflowKey, isExecuting)) {
      throw new LiveLineageDeleteError(workflowKey);
    }
    const batch = this.begin(HISTORY_TRASH_ENTRY_KINDS.LINEAGE, requestedBy);
    try {
      await batch.moveLineageDir(workflowKey);
    } catch (error) {
      await batch.commit();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    return batch.commit();
  }

  /**
   * Clear all history: moves every lineage that is not live into one entry.
   * Live lineages are skipped and recorded on the entry, never refused, so
   * one running workflow cannot block clearing the rest.
   */
  async trashAllLineages(
    requestedBy: string,
    isExecuting?: ExecutingLineagePredicate
  ): Promise<{
    entry: HistoryTrashEntry | undefined;
    skippedLive: WorkflowKey[];
    failed: WorkflowKey[];
  }> {
    const batch = this.begin(HISTORY_TRASH_ENTRY_KINDS.ALL, requestedBy);
    const failed: WorkflowKey[] = [];
    for (const workflowKey of await this.lineageRepository.listLineageKeys(
      this.stateRoot
    )) {
      if (await this.isLineageLive(workflowKey, isExecuting)) {
        batch.markSkippedLive(workflowKey);
        continue;
      }
      try {
        await batch.moveLineageDir(workflowKey);
      } catch (error) {
        failed.push(workflowKey);
        Log.warn(
          `${LOG_PREFIX} could not move ${workflowKey} to Recently deleted: ${getErrorMessage(error)}`
        );
      }
    }
    const entry = await batch.commit();
    return { entry, skippedLive: [...batch.getSkippedLive()], failed };
  }

  /** Counts what {@link trashAllLineages} would move right now. */
  async previewClearAll(
    isExecuting?: ExecutingLineagePredicate
  ): Promise<HistoryClearPreview> {
    const preview: HistoryClearPreview = {
      lineageCount: 0,
      runCount: 0,
      bytes: 0,
      liveLineages: [],
    };
    for (const workflowKey of await this.lineageRepository.listLineageKeys(
      this.stateRoot
    )) {
      if (await this.isLineageLive(workflowKey, isExecuting)) {
        preview.liveLineages.push({
          workflowKey,
          workflowName: await this.readWorkflowName(workflowKey),
        });
        continue;
      }
      const lineageDir = WorkflowPaths.lineageDir(this.stateRoot, workflowKey);
      preview.lineageCount += 1;
      preview.runCount += (await listRunDirNames(lineageDir)).length;
      preview.bytes += await directorySize(lineageDir);
    }
    return preview;
  }

  /** Writes `entry.json` and publishes the pending directory into place. */
  async publishEntry(
    pendingDir: string,
    entry: HistoryTrashEntry
  ): Promise<void> {
    let target = WorkflowPaths.trashEntryDir(this.stateRoot, entry.id);
    if (await pathExists(target)) {
      entry.id = newEntryId(Date.now());
      target = WorkflowPaths.trashEntryDir(this.stateRoot, entry.id);
      while (await pathExists(target)) {
        entry.id = newEntryId(Date.now());
        target = WorkflowPaths.trashEntryDir(this.stateRoot, entry.id);
      }
    }
    const entryPath = path.join(pendingDir, ENTRY_FILE_NAME);
    assertWritableSchema(
      PERSISTED_STORES.HISTORY_TRASH_ENTRY,
      entry,
      entryPath
    );
    await writeFileAtomic(entryPath, JSON.stringify(entry, null, 2));
    let renameRefused = false;
    try {
      await renameWithTransientRetry(pendingDir, target, {
        budgetMs: MOVE_RENAME_BUDGET_MS,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!COPY_FALLBACK_ERROR_CODES.has(code)) throw error;
      renameRefused = true;
      Log.info(
        `${LOG_PREFIX} pending entry rename refused (${code}); copying payload for publication: ${pendingDir}`
      );
    }
    if (!renameRefused) {
      await fs.promises.rm(path.join(target, OWNER_FILE_NAME), { force: true });
      return;
    }

    // A watcher can sit inside one run directory and prevent renaming its
    // ancestor. Keep the pending copy intact until the destination payload is
    // complete; readers only recognize the destination after entry.json lands.
    await fs.promises.mkdir(target, { recursive: false });
    try {
      await fs.promises.cp(
        path.join(pendingDir, PAYLOAD_DIR_NAME),
        path.join(target, PAYLOAD_DIR_NAME),
        { recursive: true, errorOnExist: true, force: false }
      );
      await writeFileAtomic(
        path.join(target, ENTRY_FILE_NAME),
        JSON.stringify(entry, null, 2)
      );
      try {
        await fs.promises.rm(pendingDir, { recursive: true, force: true });
      } catch (error) {
        // The published copy is complete. An open watcher can still prevent
        // deleting the old copy; recovery removes it after the handle closes.
        Log.warn(
          `${LOG_PREFIX} published ${entry.id} but could not remove pending copy: ${getErrorMessage(error)}`
        );
      }
    } catch (error) {
      // Before entry.json, this destination is not a visible trash entry.
      // The pending source remains authoritative and recoverable after a crash.
      if (!(await pathExists(path.join(target, ENTRY_FILE_NAME)))) {
        await fs.promises.rm(target, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private async readEntry(
    entryId: string
  ): Promise<HistoryTrashEntry | undefined> {
    try {
      const entry = JSON.parse(
        await fs.promises.readFile(
          path.join(
            WorkflowPaths.trashEntryDir(this.stateRoot, entryId),
            ENTRY_FILE_NAME
          ),
          "utf8"
        )
      ) as HistoryTrashEntry;
      return entry && Array.isArray(entry.items) ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Finishes entries a crashed delete left pending: whatever made it into the
   * payload is described from disk and committed, so it can be restored like
   * any other entry. Young pending directories are left alone; another
   * process may still be filling them.
   */
  async recoverPendingEntries(now = Date.now()): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      const parsed = WorkflowPaths.parseTrashEntryDirName(name);
      if (!parsed?.pending) continue;
      const pendingDir = WorkflowPaths.pendingTrashEntryDir(
        this.stateRoot,
        parsed.entryId
      );
      try {
        const stats = await fs.promises.stat(pendingDir);
        const ownerPath = path.join(pendingDir, OWNER_FILE_NAME);
        if (await pathExists(ownerPath)) {
          let owner: { pid?: unknown; host?: unknown };
          try {
            owner = JSON.parse(await fs.promises.readFile(ownerPath, "utf8"));
          } catch {
            // A marker we cannot read cannot establish that its owner is gone.
            continue;
          }
          if (typeof owner.pid !== "number" || typeof owner.host !== "string") {
            continue;
          }
          if (owner.host === os.hostname() && isProcessAlive(owner.pid)) {
            continue;
          }
        } else if (now - stats.mtimeMs < STALE_PENDING_ENTRY_MS) {
          continue;
        }

        const publishedDir = WorkflowPaths.trashEntryDir(
          this.stateRoot,
          parsed.entryId
        );
        if (await pathExists(publishedDir)) {
          if (await this.readEntry(parsed.entryId)) {
            // The copy-based publisher writes this marker after copying every
            // payload file. A crash before pending cleanup leaves both copies.
            await fs.promises.rm(pendingDir, { recursive: true, force: true });
            continue;
          }
          // An interrupted payload copy has no marker and was never visible.
          // Reached only after proving the pending publisher is gone.
          await fs.promises.rm(publishedDir, { recursive: true, force: true });
        }
        const items = await this.describePayload(
          path.join(pendingDir, PAYLOAD_DIR_NAME)
        );
        if (items.length === 0) {
          await fs.promises.rm(pendingDir, { recursive: true, force: true });
          continue;
        }
        await this.publishEntry(pendingDir, {
          schemaVersion: ENTRY_SCHEMA_VERSION,
          id: parsed.entryId,
          kind: HISTORY_TRASH_ENTRY_KINDS.ALL,
          deletedAt: stats.mtimeMs,
          requestedBy: HISTORY_TRASH_REQUESTERS.RECOVERED,
          items,
          skippedLive: [],
          bytes: await directorySize(path.join(pendingDir, PAYLOAD_DIR_NAME)),
        });
        Log.info(
          `${LOG_PREFIX} recovered interrupted delete id=${parsed.entryId} ${describeItems(items)}`
        );
      } catch (error) {
        Log.warn(
          `${LOG_PREFIX} could not recover pending entry ${name}: ${getErrorMessage(error)}`
        );
      }
    }
  }

  /** Rebuilds item descriptions from what is actually in a payload directory. */
  private async describePayload(
    payloadDir: string
  ): Promise<HistoryTrashItem[]> {
    let lineageNames: fs.Dirent[];
    try {
      lineageNames = await fs.promises.readdir(payloadDir, {
        withFileTypes: true,
      });
    } catch {
      return [];
    }
    const items: HistoryTrashItem[] = [];
    for (const lineage of lineageNames) {
      if (!WorkflowPaths.isLineageDirEntry(lineage)) continue;
      const workflowKey = lineage.name as WorkflowKey;
      const dir = path.join(payloadDir, workflowKey);
      const runRefs = await listRunDirNames(dir);
      const runIds = (
        await Promise.all(
          runRefs.map((runRef) => readRunId(path.join(dir, runRef)))
        )
      ).filter((runId): runId is number => runId !== undefined);
      const wholeLineage = await pathExists(
        path.join(
          dir,
          path.basename(
            WorkflowPaths.descriptorPath(this.stateRoot, workflowKey)
          )
        )
      );
      if (!wholeLineage && runRefs.length === 0) continue;
      items.push({
        workflowKey,
        workflowName: deriveWorkflowNameFromKey(workflowKey),
        wholeLineage,
        runRefs,
        runIds,
      });
    }
    return items;
  }

  /** Recently deleted, newest first. */
  async list(retentionDays: number): Promise<HistoryTrashEntrySummary[]> {
    await this.recoverPendingEntries();
    let names: string[];
    try {
      names = await fs.promises.readdir(this.root);
    } catch {
      return [];
    }
    const entries: HistoryTrashEntrySummary[] = [];
    for (const name of names) {
      const parsed = WorkflowPaths.parseTrashEntryDirName(name);
      if (!parsed || parsed.pending) continue;
      const entry = await this.readEntry(parsed.entryId);
      if (!entry) continue;
      entries.push({
        ...entry,
        expiresAt: entry.deletedAt + retentionDays * DAY_MS,
      });
    }
    return entries.sort((left, right) => right.deletedAt - left.deletedAt);
  }

  /**
   * Puts an entry's history back. Anything whose destination is occupied again
   * stays in the entry and is reported; everything else is restored.
   */
  async restore(entryId: string): Promise<HistoryTrashRestoreResult> {
    const entry = await this.readEntry(entryId);
    if (!entry) {
      throw new Error(TRASH_ENTRY_GONE_MESSAGE);
    }
    const entryDir = WorkflowPaths.trashEntryDir(this.stateRoot, entryId);
    assertWritableSchema(
      PERSISTED_STORES.HISTORY_TRASH_ENTRY,
      entry,
      path.join(entryDir, ENTRY_FILE_NAME)
    );
    const payloadDir = path.join(entryDir, PAYLOAD_DIR_NAME);
    const result: HistoryTrashRestoreResult = {
      restoredLineages: 0,
      restoredRuns: 0,
      restoredWorkflowKeys: [],
      conflicts: [],
    };

    for (const item of entry.items) {
      const source = path.join(payloadDir, item.workflowKey);
      if (!(await pathExists(source))) continue;
      const lineageDir = WorkflowPaths.lineageDir(
        this.stateRoot,
        item.workflowKey
      );
      if (item.wholeLineage && !(await pathExists(lineageDir))) {
        await movePath(source, lineageDir);
        result.restoredLineages += 1;
        result.restoredRuns += item.runRefs.length;
        result.restoredWorkflowKeys.push(item.workflowKey);
        continue;
      }
      // Either only some runs were deleted, or the lineage exists again:
      // merge the run directories back under the lineage lock.
      const restoredRunsBeforeItem = result.restoredRuns;
      const fallbackDescriptor = item.wholeLineage
        ? await this.lineageRepository
            .readDescriptorFromPath(
              path.join(
                source,
                path.basename(
                  WorkflowPaths.descriptorPath(this.stateRoot, item.workflowKey)
                )
              )
            )
            .catch(() => undefined)
        : undefined;
      await this.lineageRepository.restoreRuns(
        this.stateRoot,
        item.workflowKey,
        item.workflowName,
        async (targetLineageDir) => {
          const restoredRunIds: number[] = [];
          for (const runRef of await listRunDirNames(source)) {
            const target = path.join(targetLineageDir, runRef);
            if (await pathExists(target)) {
              result.conflicts.push(`${item.workflowKey}/${runRef}`);
              continue;
            }
            const runId = await readRunId(path.join(source, runRef));
            await movePath(path.join(source, runRef), target);
            result.restoredRuns += 1;
            if (runId !== undefined) restoredRunIds.push(runId);
          }
          const trashedDraftDir = path.join(
            source,
            path.basename(
              WorkflowPaths.draftDir(this.stateRoot, item.workflowKey)
            )
          );
          const liveDraftDir = WorkflowPaths.draftDir(
            this.stateRoot,
            item.workflowKey
          );
          if (
            item.wholeLineage &&
            (await pathExists(trashedDraftDir)) &&
            !(await pathExists(liveDraftDir))
          ) {
            await movePath(trashedDraftDir, liveDraftDir);
          }
          return restoredRunIds;
        },
        fallbackDescriptor
      );
      // Include whole lineages whose descriptor was merged even if all runs
      // conflicted; otherwise include only lineages with a restored run.
      if (item.wholeLineage || result.restoredRuns > restoredRunsBeforeItem) {
        result.restoredWorkflowKeys.push(item.workflowKey);
      }
      if (item.wholeLineage) result.restoredLineages += 1;
      // For an existing lineage with real edits, its descriptor remains the
      // metadata source and its draft wins. Restore consumed the trashed draft
      // only when no live draft existed.
      if ((await listRunDirNames(source)).length === 0) {
        await fs.promises.rm(source, { recursive: true, force: true });
      }
    }

    const remaining = await this.describePayload(payloadDir);
    if (remaining.length === 0) {
      await fs.promises.rm(entryDir, { recursive: true, force: true });
    } else {
      await writeFileAtomic(
        path.join(entryDir, ENTRY_FILE_NAME),
        JSON.stringify(
          {
            ...entry,
            items: remaining,
            bytes: await directorySize(payloadDir),
          },
          null,
          2
        )
      );
    }
    Log.info(
      `${LOG_PREFIX} restored id=${entryId} lineages=${result.restoredLineages} runs=${result.restoredRuns} conflicts=${result.conflicts.length}`
    );
    this.refreshSearchIndex();
    return result;
  }

  /** Permanently deletes one entry. */
  async purge(entryId: string, reason: string): Promise<void> {
    const entryDir = WorkflowPaths.trashEntryDir(this.stateRoot, entryId);
    if (!(await pathExists(entryDir))) {
      throw new Error(TRASH_ENTRY_GONE_MESSAGE);
    }
    await fs.promises.rm(entryDir, { recursive: true, force: true });
    Log.info(`${LOG_PREFIX} purged id=${entryId} reason=${reason}`);
  }

  /** Permanently deletes every entry. Returns how many were removed. */
  async purgeAll(reason: string): Promise<number> {
    let count = 0;
    for (const entry of await this.list(0)) {
      await this.purge(entry.id, reason);
      count += 1;
    }
    return count;
  }

  /** Permanently deletes entries older than the retention window. */
  async purgeExpired(retentionDays: number, now = Date.now()): Promise<number> {
    let count = 0;
    for (const entry of await this.list(retentionDays)) {
      if (entry.expiresAt > now) continue;
      try {
        await this.purge(entry.id, "expired");
        count += 1;
      } catch (error) {
        Log.warn(
          `${LOG_PREFIX} could not purge expired entry ${entry.id}: ${getErrorMessage(error)}`
        );
      }
    }
    return count;
  }

  /**
   * Restored runs must reach search again. The index prunes runs it cannot
   * find, and an incremental pass picks up any run directory it has not seen.
   */
  private refreshSearchIndex(): void {
    void getSharedHistorySearchIndexService(this.stateRoot)
      .enqueueWorkspaceRefresh(this.stateRoot)
      .catch(() => {
        /* index refresh failures are logged inside the index service */
      });
  }
}

/** The Undo-toast message for a committed entry, sent to the requesting client. */
export function toHistoryTrashedMessage(
  entry: HistoryTrashEntry
): HistoryTrashedMessage {
  return {
    type: MESSAGE_TYPES.HISTORY_TRASHED,
    entryId: entry.id,
    kind: entry.kind,
    message: `Moved ${describeTrashEntry(entry)} to Recently deleted`,
    skippedLive: entry.skippedLive,
  };
}

/** Startup purge waits this long so it never competes with activation work. */
const TRASH_PURGE_STARTUP_DELAY_MS = 60_000;

/**
 * Purges expired Recently deleted entries shortly after startup and then once
 * a day while the host stays up. Also finishes any delete a crash interrupted.
 */
export function scheduleTrashPurge(
  stateRoot: string,
  getRetentionDays: () => number
): { dispose(): void } {
  const repository = new HistoryTrashRepository(stateRoot);
  const run = () => {
    void repository
      .purgeExpired(getRetentionDays())
      .catch((error: unknown) =>
        Log.warn(
          `${LOG_PREFIX} scheduled purge failed: ${getErrorMessage(error)}`
        )
      );
  };
  const startup = setTimeout(run, TRASH_PURGE_STARTUP_DELAY_MS);
  const daily = setInterval(run, DAY_MS);
  startup.unref?.();
  daily.unref?.();
  return {
    dispose: () => {
      clearTimeout(startup);
      clearInterval(daily);
    },
  };
}
