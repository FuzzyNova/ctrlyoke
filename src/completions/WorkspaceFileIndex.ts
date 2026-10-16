import * as fs from "fs/promises";
import * as path from "path";
import {
  COMPLETION_ALL_FILES_SKIP_DIRECTORIES,
  DEFAULT_SKIP_DIRECTORIES,
  isSearchPathIgnored,
  walkSearchFiles,
  type SearchWalkResult,
} from "../utils/WorkspaceSearchFileWalker";
import { getGitIgnoredPaths, getGitTrackedFiles } from "../utils/GitUtils";
import {
  WORKSPACE_FILE_INDEX_STATES,
  WORKSPACE_FILE_CHANGE_KINDS,
  type WorkspaceFileIndexState,
  type WorkspaceFileChangeKind,
  type WorkspaceFileTreeEntryKind,
} from "../types/DashboardConstants";
import { WorkspacePathQuery, type WorkspacePathQueryOptions, type WorkspacePathResult } from "./WorkspacePathQuery";
import { WorkspacePathStore } from "./WorkspacePathStore";
import { Worker } from "worker_threads";
import { findExistingWorkerPath } from "../utils/WorkerPath";
import { Log } from "../utils/Log";
import { notifyUserFeedback, type UserFeedbackSink } from "../core/UserFeedbackSink";
import { USER_FEEDBACK_SEVERITY } from "../types/DashboardConstants";
import * as pathModule from "path";

export interface WorkspaceFileIndexStatus {
  readonly state: WorkspaceFileIndexState;
  readonly indexed: number;
}

/** Host-neutral completion query port implemented by the file index. */
export interface WorkspaceFileQueries {
  queryFiles(query: string, options?: WorkspacePathQueryOptions): Promise<WorkspacePathResult[]>;
  queryPromptFiles(query: string, options?: WorkspacePathQueryOptions): Promise<WorkspacePathResult[]>;
  suggestPaths(typedPath: string, kind: WorkspaceFileTreeEntryKind, maxResults?: number, options?: WorkspacePathQueryOptions): Promise<WorkspacePathResult[]>;
  getStatus(): WorkspaceFileIndexStatus;
}

export interface WorkspaceFileIndexRoot {
  readonly path: string;
  readonly name: string;
}

export interface WorkspaceFileIndexBuildOptions {
  readonly roots?: readonly WorkspaceFileIndexRoot[];
  readonly respectGitignore?: boolean;
  readonly gitVisibleOnly?: boolean;
}

export interface WorkspaceFileChange {
  readonly root: string;
  readonly path: string;
  readonly kind: WorkspaceFileChangeKind;
}

export interface WorkspaceFileIndexDependencies {
  readonly getGitTrackedFiles: (root: string) => Promise<string[]>;
  readonly getGitIgnoredPaths: (root: string, absolutePaths: readonly string[]) => Promise<Set<string>>;
  readonly walkSearchFiles: (root: string, startedAt: number, maxFiles: number, maxDurationMs: number, skip: ReadonlySet<string>, excludeLogs?: boolean) => Promise<SearchWalkResult>;
  readonly stat: (absolutePath: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_DEPENDENCIES: WorkspaceFileIndexDependencies = {
  getGitTrackedFiles,
  getGitIgnoredPaths,
  walkSearchFiles,
  stat: (absolutePath) => fs.stat(absolutePath),
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

const CHANGE_BATCH_MS = 200;
const REBUILD_STALE_MS = 5 * 60_000;
export const FILE_INDEX_WORKER_HEAP_MB = 2048;
export const WORKSPACE_FILE_INDEX_MESSAGE_TYPES = {
  BUILD: "build",
  APPLY_CHANGES: "applyChanges",
  QUERY_FILES: "queryFiles",
  QUERY_PROMPT_FILES: "queryPromptFiles",
  SUGGEST_PATHS: "suggestPaths",
  CANCEL: "cancel",
  DISPOSE: "dispose",
  RESULT: "result",
  PROGRESS: "progress",
  STATUS: "status",
  LOG: "log",
  ERROR: "error",
} as const;
export const WORKSPACE_FILE_INDEX_LOG_LEVELS = { INFO: "info", WARN: "warn", ERROR: "error" } as const;
const WORKER_MEMORY_WARNING = "Workspace file index stopped at its 2 GB memory limit; ignored files may be missing from @ completions.";
let workerFailureWarningShown = false;

/**
 * Self-contained index pipeline. Its public methods form the message-shaped
 * API used by the worker host in the next phase.
 */
export class WorkspaceFileIndexPipeline implements WorkspaceFileQueries {
  private store = new WorkspacePathStore();
  private query = new WorkspacePathQuery(this.store);
  private status: WorkspaceFileIndexStatus = { state: WORKSPACE_FILE_INDEX_STATES.BUILDING, indexed: 0 };
  private lastBuildAt = 0;
  private started = false;
  private disposed = false;
  private buildPromise?: Promise<void>;
  private rebuildRequested = false;
  private pendingChanges: WorkspaceFileChange[] = [];
  private changeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private roots: readonly WorkspaceFileIndexRoot[],
    private respectGitignore: boolean,
    private readonly dependencies: WorkspaceFileIndexDependencies = DEFAULT_DEPENDENCIES
  ) {}

  /** Starts a build and resolves as soon as its Git-visible paths are queryable. */
  async build(options: WorkspaceFileIndexBuildOptions = {}): Promise<void> {
    if (this.disposed) return;
    this.started = true;
    if (options.roots) this.roots = options.roots;
    if (options.respectGitignore !== undefined) this.respectGitignore = options.respectGitignore;
    if (this.buildPromise) {
      this.rebuildRequested = true;
      return this.buildPromise;
    }
    const initialBuild = this.lastBuildAt === 0;
    this.status = { ...this.status, state: WORKSPACE_FILE_INDEX_STATES.BUILDING };
    const buildRoots = this.roots;
    const respectGitignore = this.respectGitignore;
    let markGitReady!: () => void;
    const gitReady = new Promise<void>((resolve) => { markGitReady = resolve; });
    this.buildPromise = this.performBuild(initialBuild, markGitReady, buildRoots, respectGitignore, options.gitVisibleOnly ?? false).finally(() => {
      this.buildPromise = undefined;
      if (this.rebuildRequested && !this.disposed) {
        this.rebuildRequested = false;
        void this.build();
      }
    });
    return gitReady;
  }

  async applyChanges(changes: readonly WorkspaceFileChange[]): Promise<void> {
    if (this.disposed || changes.length === 0) return;
    this.pendingChanges.push(...changes);
    if (this.changeTimer) this.dependencies.clearTimeout(this.changeTimer);
    this.changeTimer = this.dependencies.setTimeout(() => {
      this.changeTimer = undefined;
      void this.flushChanges();
    }, CHANGE_BATCH_MS);
  }

  async queryFiles(query: string, options?: WorkspacePathQueryOptions): Promise<WorkspacePathResult[]> {
    await this.ensureStarted();
    this.maybeRebuildStale();
    return this.query.queryFiles(query, options);
  }

  async queryPromptFiles(query: string, options?: WorkspacePathQueryOptions): Promise<WorkspacePathResult[]> {
    await this.ensureStarted();
    this.maybeRebuildStale();
    return this.query.queryPromptFiles(query, options);
  }

  async suggestPaths(typedPath: string, kind: WorkspaceFileTreeEntryKind, maxResults?: number, options?: WorkspacePathQueryOptions): Promise<WorkspacePathResult[]> {
    await this.ensureStarted();
    this.maybeRebuildStale();
    return this.query.suggestPaths(typedPath, kind, maxResults, options);
  }

  getStatus(): WorkspaceFileIndexStatus {
    return this.status;
  }

  markDegraded(): void {
    this.status = { ...this.status, state: WORKSPACE_FILE_INDEX_STATES.DEGRADED };
  }

  cancel(_queryId?: string): void {
    // The in-process adapter accepts the worker-shaped cancellation message.
    // Query cancellation is carried by the caller's AbortSignal in this phase.
  }

  dispose(): void {
    this.disposed = true;
    if (this.changeTimer) this.dependencies.clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    this.pendingChanges = [];
  }

  private maybeRebuildStale(): void {
    if (this.started && !this.buildPromise && this.lastBuildAt > 0 && this.dependencies.now() - this.lastBuildAt > REBUILD_STALE_MS) {
      void this.build();
    }
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) await this.build();
  }

  private async performBuild(
    initialBuild: boolean,
    markGitReady: () => void,
    roots: readonly WorkspaceFileIndexRoot[],
    respectGitignore: boolean,
    gitVisibleOnly: boolean
  ): Promise<void> {
    const staging = new WorkspacePathStore();
    const skip = respectGitignore ? DEFAULT_SKIP_DIRECTORIES : COMPLETION_ALL_FILES_SKIP_DIRECTORIES;
    let gitSucceeded = true;
    const gitByRoot = await Promise.all(roots.map(async (root) => {
      try {
        const paths = await this.dependencies.getGitTrackedFiles(root.path);
        return this.prefix(root, paths, roots);
      } catch {
        gitSucceeded = false;
        return [];
      }
    }));
    const gitPaths = gitByRoot.flat();

    if (gitSucceeded) {
      staging.replaceAll(gitPaths);
      if (initialBuild) this.activate(staging, WORKSPACE_FILE_INDEX_STATES.BUILDING);
      // Git-visible paths can be queried immediately while the optional full
      // walk continues in the background.
      markGitReady();
    }

    let walked: string[] = [];
    if ((!respectGitignore || !gitSucceeded) && !gitVisibleOnly) {
      const walkedByRoot = await Promise.all(roots.map(async (root) => {
        try {
          const result = await this.dependencies.walkSearchFiles(
            root.path,
            this.dependencies.now(),
            Number.POSITIVE_INFINITY,
            Number.POSITIVE_INFINITY,
            gitSucceeded ? skip : DEFAULT_SKIP_DIRECTORIES,
            !gitSucceeded || respectGitignore
          );
          return this.prefix(root, result.files, roots);
        } catch {
          // A partial walk remains useful; the index reports degraded below.
          return [];
        }
      }));
      walked = walkedByRoot.flat();
    }

    if (this.disposed) {
      if (!gitSucceeded) markGitReady();
      return;
    }
    if (gitSucceeded) staging.add(walked);
    else staging.replaceAll(walked);
    this.activate(staging, gitSucceeded ? WORKSPACE_FILE_INDEX_STATES.READY : WORKSPACE_FILE_INDEX_STATES.DEGRADED);
    this.lastBuildAt = this.dependencies.now();
    // Without a usable Git list, the fallback walk is the first queryable
    // snapshot, so don't release the initial request against an empty store.
    if (!gitSucceeded) markGitReady();
  }

  private activate(store: WorkspacePathStore, state: WorkspaceFileIndexState): void {
    this.store = store;
    this.query = new WorkspacePathQuery(store);
    this.status = { state, indexed: store.files.length };
  }

  private prefix(
    root: WorkspaceFileIndexRoot,
    paths: readonly string[],
    roots: readonly WorkspaceFileIndexRoot[] = this.roots
  ): string[] {
    const prefix = roots.length > 1 ? `${root.name}/` : "";
    return paths.map((file) => `${prefix}${file.replace(/\\/g, "/")}`);
  }

  private async flushChanges(): Promise<void> {
    const changes = this.pendingChanges;
    this.pendingChanges = [];
    if (this.disposed || changes.length === 0) return;
    const skip = this.respectGitignore ? DEFAULT_SKIP_DIRECTORIES : COMPLETION_ALL_FILES_SKIP_DIRECTORIES;
    const accepted: Array<{ root: WorkspaceFileIndexRoot; relative: string; kind: WorkspaceFileChangeKind }> = [];
    for (const change of changes) {
      const root = this.roots.find((candidate) => candidate.path === change.root);
      if (!root) continue;
      const relative = change.path.replace(/\\/g, "/").replace(/^\/+/, "");
      if (relative === ".gitignore" || relative.endsWith("/.gitignore") || relative === ".git/info/exclude") {
        void this.build();
        continue;
      }
      if (isSearchPathIgnored(relative, skip, this.respectGitignore)) continue;
      if (change.kind !== WORKSPACE_FILE_CHANGE_KINDS.CHANGE) accepted.push({ root, relative, kind: change.kind });
    }
    for (const change of accepted) {
      if (change.kind === WORKSPACE_FILE_CHANGE_KINDS.DELETE) {
        this.store.removeTree(this.prefix(change.root, [change.relative])[0]);
        continue;
      }
      const absolute = path.join(change.root.path, ...change.relative.split("/"));
      try {
        const info = await this.dependencies.stat(absolute);
        let paths: string[] = [];
        if (info.isFile()) paths = [change.relative];
        else if (info.isDirectory()) {
          const result = await this.dependencies.walkSearchFiles(absolute, this.dependencies.now(), Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, skip, this.respectGitignore);
          paths = result.files.map((file) => `${change.relative}/${file}`);
        }
        if (this.respectGitignore && paths.length > 0) {
          const ignored = await this.dependencies.getGitIgnoredPaths(change.root.path, paths.map((file) => path.resolve(change.root.path, file)));
          paths = paths.filter((file) => !ignored.has(path.resolve(change.root.path, file)));
        }
        this.store.add(this.prefix(change.root, paths));
      } catch {
        // Watcher races with deletion and inaccessible paths are expected.
      }
    }
    this.status = { ...this.status, indexed: this.store.files.length };
  }
}

type WorkerRequest = { id: number; type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.BUILD; options?: WorkspaceFileIndexBuildOptions } |
  { id: number; type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.APPLY_CHANGES; changes: readonly WorkspaceFileChange[] } |
  { id: number; type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES | typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES; query: string; queryId: string; limit?: number } |
  { id: number; type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS; query: string; queryId: string; kind: WorkspaceFileTreeEntryKind; maxResults?: number } |
  { id: number; type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.CANCEL; queryId: string } | { id: number; type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.DISPOSE };
type WorkerResponse = { id?: number; type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.RESULT; value?: unknown; status?: WorkspaceFileIndexStatus } |
  { type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.PROGRESS; queryId: string; progress: { scanned: number; total: number; results: WorkspacePathResult[] } } |
  { type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.STATUS; status: WorkspaceFileIndexStatus } |
  { type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.LOG; level: typeof WORKSPACE_FILE_INDEX_LOG_LEVELS[keyof typeof WORKSPACE_FILE_INDEX_LOG_LEVELS]; message: string } |
  { id?: number; type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.ERROR; message: string };
type WorkerRequestInput = WorkerRequest extends infer Request
  ? Request extends WorkerRequest ? Omit<Request, "id"> : never
  : never;

export interface WorkspaceFileIndexOptions {
  readonly workerHeapMb?: number;
  readonly userFeedbackSink?: UserFeedbackSink;
  readonly workerFactory?: (scriptPath: string, resourceLimits: { maxOldGenerationSizeMb: number }) => Worker;
}

/** Host transport for a per-workspace worker, with a bounded in-process fallback. */
export class WorkspaceFileIndex implements WorkspaceFileQueries {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; request: WorkerRequestInput }>();
  private readonly queryIds = new Map<string, number>();
  private nextId = 1;
  private worker?: Worker;
  private fallback?: WorkspaceFileIndexPipeline;
  private status: WorkspaceFileIndexStatus = { state: WORKSPACE_FILE_INDEX_STATES.BUILDING, indexed: 0 };
  private disposed = false;
  private failureStarted = false;
  private buildStarted = false;

  constructor(
    private readonly roots: readonly WorkspaceFileIndexRoot[],
    private readonly respectGitignore: boolean,
    dependencies?: WorkspaceFileIndexDependencies,
    private readonly options: WorkspaceFileIndexOptions = {}
  ) {
    // Injected pipeline dependencies keep deterministic unit tests in-process.
    if (dependencies) {
      this.fallback = new WorkspaceFileIndexPipeline(roots, respectGitignore, dependencies);
      return;
    }
    try {
      const candidates = [
        pathModule.join(__dirname, "..", "..", "workspaceFileIndexWorker.js"),
        pathModule.join(__dirname, "workspaceFileIndexWorker.js"),
      ];
      const scriptPath = findExistingWorkerPath(candidates);
      if (!scriptPath) throw new Error(`Unable to locate workspace file index worker; checked ${candidates.join(", ")}`);
      const factory = options.workerFactory ?? ((file, resourceLimits) => new Worker(file, { resourceLimits }));
      this.worker = factory(scriptPath, { maxOldGenerationSizeMb: options.workerHeapMb ?? FILE_INDEX_WORKER_HEAP_MB });
      this.worker.on("message", (message: WorkerResponse) => this.onMessage(message));
      this.worker.on("error", (error: Error & { code?: string }) => void this.fail(error));
      this.worker.on("exit", (code) => {
        if (!this.disposed && code !== 0) void this.fail(new Error(`Workspace file index worker exited with code ${code}`));
      });
    } catch (error) {
      void this.fail(error);
    }
  }

  async build(options: WorkspaceFileIndexBuildOptions = {}): Promise<void> {
    this.buildStarted = true;
    if (this.fallback) { await this.fallback.build(options); this.status = this.fallback.getStatus(); return; }
    await this.request({ type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.BUILD, options: { ...options, roots: options.roots ?? this.roots, respectGitignore: options.respectGitignore ?? this.respectGitignore } });
  }
  async applyChanges(changes: readonly WorkspaceFileChange[]): Promise<void> {
    if (this.fallback) { await this.fallback.applyChanges(changes); return; }
    await this.request({ type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.APPLY_CHANGES, changes });
  }
  async queryFiles(query: string, options: WorkspacePathQueryOptions = {}): Promise<WorkspacePathResult[]> {
    await this.ensureStarted();
    if (this.fallback) return this.fallback.queryFiles(query, options);
    return this.query(WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES, query, options);
  }
  async queryPromptFiles(query: string, options: WorkspacePathQueryOptions = {}): Promise<WorkspacePathResult[]> {
    await this.ensureStarted();
    if (this.fallback) return this.fallback.queryPromptFiles(query, options);
    return this.query(WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES, query, options);
  }
  async suggestPaths(typedPath: string, kind: WorkspaceFileTreeEntryKind, maxResults?: number, options: WorkspacePathQueryOptions = {}): Promise<WorkspacePathResult[]> {
    await this.ensureStarted();
    if (this.fallback) return this.fallback.suggestPaths(typedPath, kind, maxResults, options);
    return this.querySuggestions(typedPath, kind, maxResults, options);
  }
  getStatus(): WorkspaceFileIndexStatus { return this.fallback?.getStatus() ?? this.status; }
  private async ensureStarted(): Promise<void> {
    if (!this.buildStarted) await this.build();
  }
  cancel(queryId?: string): void {
    if (!queryId) return;
    if (this.fallback) { this.fallback.cancel(queryId); return; }
    const id = this.queryIds.get(queryId);
    if (id !== undefined) this.worker?.postMessage({ id: this.nextId++, type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.CANCEL, queryId } satisfies WorkerRequest);
  }
  dispose(): void {
    this.disposed = true;
    this.fallback?.dispose();
    const worker = this.worker;
    if (worker) {
      worker.postMessage({ id: this.nextId++, type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.DISPOSE } satisfies WorkerRequest);
      setTimeout(() => void worker.terminate(), 100);
    }
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error("Workspace file index disposed"));
    this.pending.clear();
  }

  private async query(type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES | typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES, query: string, options: WorkspacePathQueryOptions): Promise<WorkspacePathResult[]> {
    if (options.signal?.aborted) return [];
    const queryId = `${this.nextId}`;
    const request = this.request({ type, query, queryId, limit: options.limit });
    const id = Number(queryId);
    this.queryIds.set(queryId, id);
    const progressListener = (message: WorkerResponse): void => {
      if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.PROGRESS && message.queryId === queryId) options.onProgress?.(message.progress);
    };
    this.worker?.on("message", progressListener);
    const abort = (): void => this.cancel(queryId);
    options.signal?.addEventListener("abort", abort, { once: true });
    try { return await request as WorkspacePathResult[]; }
    finally { this.worker?.off("message", progressListener); options.signal?.removeEventListener("abort", abort); this.queryIds.delete(queryId); }
  }

  private async querySuggestions(typedPath: string, kind: WorkspaceFileTreeEntryKind, maxResults: number | undefined, options: WorkspacePathQueryOptions): Promise<WorkspacePathResult[]> {
    if (options.signal?.aborted) return [];
    const queryId = `${this.nextId}`;
    const request = this.request({ type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS, query: typedPath, queryId, kind, maxResults });
    const progressListener = (message: WorkerResponse): void => {
      if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.PROGRESS && message.queryId === queryId) options.onProgress?.(message.progress);
    };
    this.worker?.on("message", progressListener);
    const abort = (): void => this.cancel(queryId);
    options.signal?.addEventListener("abort", abort, { once: true });
    try { return await request as WorkspacePathResult[]; }
    finally { this.worker?.off("message", progressListener); options.signal?.removeEventListener("abort", abort); this.queryIds.delete(queryId); }
  }

  private request(message: WorkerRequestInput): Promise<unknown> {
    if (this.fallback) {
      const pipeline = this.fallback;
      if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.BUILD) return pipeline.build(message.options).then(() => undefined);
      if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.APPLY_CHANGES) return pipeline.applyChanges(message.changes).then(() => undefined);
      if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES) return pipeline.queryFiles(message.query, { limit: message.limit });
      if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES) return pipeline.queryPromptFiles(message.query, { limit: message.limit });
      if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS) return pipeline.suggestPaths(message.query, message.kind, message.maxResults);
      return Promise.resolve(undefined);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, request: message });
      this.worker?.postMessage({ ...message, id } as WorkerRequest);
    });
  }
  private onMessage(message: WorkerResponse): void {
    if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.STATUS) { this.status = message.status; return; }
    if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.LOG) {
      if (message.level === WORKSPACE_FILE_INDEX_LOG_LEVELS.WARN) Log.warn(message.message);
      else if (message.level === WORKSPACE_FILE_INDEX_LOG_LEVELS.ERROR) Log.error(message.message);
      else Log.info(message.message);
      return;
    }
    if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.PROGRESS) return;
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending || message.id === undefined) return;
    this.pending.delete(message.id);
    if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.ERROR) pending.reject(new Error(message.message));
    else { if (message.status) this.status = message.status; pending.resolve(message.value); }
  }
  private async fail(error: unknown): Promise<void> {
    if (this.failureStarted || this.fallback || this.disposed) return;
    this.failureStarted = true;
    this.worker?.removeAllListeners();
    this.worker?.terminate();
    this.worker = undefined;
    Log.warn(`Workspace file index worker failed${(error as NodeJS.ErrnoException)?.code === "ERR_WORKER_OUT_OF_MEMORY" ? " with ERR_WORKER_OUT_OF_MEMORY" : ""}: ${error instanceof Error ? error.message : String(error)}`);
    if (!workerFailureWarningShown && this.options.userFeedbackSink) {
      workerFailureWarningShown = true;
      notifyUserFeedback(this.options.userFeedbackSink, USER_FEEDBACK_SEVERITY.WARNING, WORKER_MEMORY_WARNING);
    }
    this.fallback = new WorkspaceFileIndexPipeline(this.roots, this.respectGitignore);
    await this.fallback.build({ gitVisibleOnly: true });
    this.fallback.markDegraded();
    this.status = this.fallback.getStatus();
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      try {
        const request = pending.request;
        let value: unknown;
        if (request.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.BUILD) value = undefined;
        else if (request.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES) value = await this.fallback.queryFiles(request.query);
        else if (request.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES) value = await this.fallback.queryPromptFiles(request.query);
        else if (request.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS) value = await this.fallback.suggestPaths(request.query, request.kind, request.maxResults);
        else if (request.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.APPLY_CHANGES) value = await this.fallback.applyChanges(request.changes);
        pending.resolve(value);
      } catch (fallbackError) {
        pending.reject(fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)));
      }
    }
  }
}
