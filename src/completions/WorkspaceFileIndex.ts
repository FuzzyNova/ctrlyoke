import * as fs from "fs/promises";
import * as path from "path";
import { Worker } from "worker_threads";
import {
  COMPLETION_ALL_FILES_SKIP_DIRECTORIES,
  DEFAULT_SKIP_DIRECTORIES,
  isSearchPathIgnored,
  walkSearchFiles,
  type SearchWalkResult,
} from "../utils/WorkspaceSearchFileWalker";
import { getGitIgnoredPaths, getGitTrackedFiles } from "../utils/GitUtils";
import {
  USER_FEEDBACK_SEVERITY,
  WORKSPACE_ENTRY_KINDS,
  WORKSPACE_FILE_CHANGE_KINDS,
  WORKSPACE_FILE_INDEX_STATES,
  type WorkspaceFileChangeKind,
  type WorkspaceFileIndexState,
  type WorkspaceFileTreeEntryKind,
} from "../types/DashboardConstants";
import {
  WorkspacePathQuery,
  type WorkspacePathQueryOptions,
  type WorkspacePathResult,
} from "./WorkspacePathQuery";
import { WorkspacePathStore } from "./WorkspacePathStore";
import { findExistingWorkerPath } from "../utils/WorkerPath";
import { Log } from "../utils/Log";
import {
  notifyUserFeedback,
  type UserFeedbackSink,
} from "../core/UserFeedbackSink";

export interface WorkspaceFileIndexStatus {
  readonly state: WorkspaceFileIndexState;
  readonly indexed: number;
}

/** Host-neutral completion query port implemented by the file index. */
export interface WorkspaceFileQueries {
  queryFiles(
    query: string,
    options?: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]>;
  queryPromptFiles(
    query: string,
    options?: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]>;
  suggestPaths(
    typedPath: string,
    kind: WorkspaceFileTreeEntryKind,
    maxResults?: number,
    options?: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]>;
  getStatus(): WorkspaceFileIndexStatus;
}

export interface WorkspaceFileIndexRoot {
  readonly path: string;
  readonly name: string;
}

export interface WorkspaceFileIndexBuildOptions {
  readonly roots?: readonly WorkspaceFileIndexRoot[];
  readonly respectGitignore?: boolean;
}

export interface WorkspaceFileChange {
  readonly root: string;
  readonly path: string;
  readonly kind: WorkspaceFileChangeKind;
}

export interface WorkspaceFileIndexDependencies {
  readonly getGitTrackedFiles: (root: string) => Promise<string[]>;
  readonly getGitIgnoredPaths: (
    root: string,
    absolutePaths: readonly string[]
  ) => Promise<Set<string>>;
  readonly walkSearchFiles: (
    root: string,
    startedAt: number,
    maxFiles: number,
    maxDurationMs: number,
    skip: ReadonlySet<string>,
    excludeLogs?: boolean,
    onFiles?: (files: readonly string[]) => void
  ) => Promise<SearchWalkResult>;
  readonly stat: (
    absolutePath: string
  ) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  readonly now: () => number;
  readonly setTimeout: (
    callback: () => void,
    delay: number
  ) => ReturnType<typeof setTimeout>;
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

export interface WorkspaceFileIndexPipelineOptions {
  /**
   * Index only the Git-visible list, never walking ignored trees. This is the
   * in-process fallback after a worker failure, where walking would put the
   * whole tree on the extension-host heap.
   */
  readonly gitVisibleOnly?: boolean;
  /** Called whenever the state or indexed count changes. */
  readonly onStatus?: (status: WorkspaceFileIndexStatus) => void;
}

const CHANGE_BATCH_MS = 200;
const REBUILD_STALE_MS = 5 * 60_000;
/** How often the initial walk publishes what it has found so far. */
const BUILD_PROGRESS_MS = 250;
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
export const WORKSPACE_FILE_INDEX_LOG_LEVELS = {
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;
const WORKER_MEMORY_WARNING =
  "Workspace file index stopped at its 2 GB memory limit; ignored files may be missing from @ completions.";
let workerFailureWarningShown = false;

function isIgnoreRuleFile(relative: string): boolean {
  return (
    relative === ".gitignore" ||
    relative.endsWith("/.gitignore") ||
    relative === ".git/info/exclude"
  );
}

/**
 * Self-contained index pipeline. Its public methods form the message-shaped
 * API that `workspaceFileIndexWorker` exposes; in-process mode (tests and the
 * worker-failure fallback) calls them directly.
 */
export class WorkspaceFileIndexPipeline implements WorkspaceFileQueries {
  private store = new WorkspacePathStore();
  private query = new WorkspacePathQuery(this.store);
  private status: WorkspaceFileIndexStatus = {
    state: WORKSPACE_FILE_INDEX_STATES.BUILDING,
    indexed: 0,
  };
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
    private readonly dependencies: WorkspaceFileIndexDependencies = DEFAULT_DEPENDENCIES,
    private readonly options: WorkspaceFileIndexPipelineOptions = {}
  ) {}

  /** Starts a build and resolves as soon as its Git-visible paths are queryable. */
  async build(options: WorkspaceFileIndexBuildOptions = {}): Promise<void> {
    if (this.disposed) return;
    this.started = true;
    if (options.roots) this.roots = options.roots;
    if (options.respectGitignore !== undefined) {
      this.respectGitignore = options.respectGitignore;
    }
    if (this.buildPromise) {
      this.rebuildRequested = true;
      return this.buildPromise;
    }
    const initialBuild = this.lastBuildAt === 0;
    // A rebuild answers from the complete previous store until it swaps, so
    // only the first build reports "building" (and the dashboard's row).
    if (initialBuild) {
      this.setStatus({
        ...this.status,
        state: WORKSPACE_FILE_INDEX_STATES.BUILDING,
      });
    }
    let markGitReady!: () => void;
    const gitReady = new Promise<void>((resolve) => {
      markGitReady = resolve;
    });
    this.buildPromise = this.performBuild(
      initialBuild,
      markGitReady,
      this.roots,
      this.respectGitignore
    )
      .catch((error: unknown) => {
        markGitReady();
        throw error;
      })
      .finally(() => {
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

  async queryFiles(
    query: string,
    options?: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]> {
    await this.beforeQuery();
    return this.query.queryFiles(query, options);
  }

  async queryPromptFiles(
    query: string,
    options?: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]> {
    await this.beforeQuery();
    return this.query.queryPromptFiles(query, options);
  }

  async suggestPaths(
    typedPath: string,
    kind: WorkspaceFileTreeEntryKind,
    maxResults?: number,
    options?: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]> {
    await this.beforeQuery();
    return this.query.suggestPaths(typedPath, kind, maxResults, options);
  }

  getStatus(): WorkspaceFileIndexStatus {
    return this.status;
  }

  dispose(): void {
    this.disposed = true;
    if (this.changeTimer) this.dependencies.clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    this.pendingChanges = [];
  }

  private async beforeQuery(): Promise<void> {
    if (!this.started) {
      await this.build();
      return;
    }
    // D11: a query against a stale index starts a background rebuild but is
    // answered from the current store.
    if (
      !this.buildPromise &&
      this.lastBuildAt > 0 &&
      this.dependencies.now() - this.lastBuildAt > REBUILD_STALE_MS
    ) {
      void this.build();
    }
  }

  private setStatus(status: WorkspaceFileIndexStatus): void {
    this.status = status;
    this.options.onStatus?.(status);
  }

  private skipDirectories(respectGitignore: boolean): ReadonlySet<string> {
    return respectGitignore
      ? DEFAULT_SKIP_DIRECTORIES
      : COMPLETION_ALL_FILES_SKIP_DIRECTORIES;
  }

  private async performBuild(
    initialBuild: boolean,
    markGitReady: () => void,
    roots: readonly WorkspaceFileIndexRoot[],
    respectGitignore: boolean
  ): Promise<void> {
    const staging = new WorkspacePathStore();
    let gitSucceeded = true;
    const gitByRoot = await Promise.all(
      roots.map(async (root) => {
        try {
          return this.prefix(
            root,
            await this.dependencies.getGitTrackedFiles(root.path),
            roots
          );
        } catch {
          gitSucceeded = false;
          return [];
        }
      })
    );

    if (gitSucceeded) {
      staging.replaceAll(gitByRoot.flat());
      if (initialBuild) {
        this.activate(staging, WORKSPACE_FILE_INDEX_STATES.BUILDING);
      }
      // Git-visible paths are queryable now; the walk continues behind them.
      markGitReady();
    }

    const walk =
      (!respectGitignore || !gitSucceeded) && !this.options.gitVisibleOnly;
    if (walk) {
      // The first build has nothing better to show, so it publishes the walk
      // as it goes. A rebuild keeps answering from the old store and swaps.
      const progressive = initialBuild && gitSucceeded;
      let buffered: string[] = [];
      let publishedAt = this.dependencies.now();
      const publish = (): void => {
        if (buffered.length === 0 || this.disposed) return;
        staging.add(buffered);
        buffered = [];
        publishedAt = this.dependencies.now();
        this.setStatus({ ...this.status, indexed: staging.files.length });
      };
      await Promise.all(
        roots.map(async (root) => {
          try {
            const result = await this.dependencies.walkSearchFiles(
              root.path,
              this.dependencies.now(),
              Number.POSITIVE_INFINITY,
              Number.POSITIVE_INFINITY,
              gitSucceeded
                ? this.skipDirectories(respectGitignore)
                : DEFAULT_SKIP_DIRECTORIES,
              !gitSucceeded || respectGitignore,
              progressive
                ? (files) => {
                    buffered.push(...this.prefix(root, files, roots));
                    if (
                      this.dependencies.now() - publishedAt >=
                      BUILD_PROGRESS_MS
                    ) {
                      publish();
                    }
                  }
                : undefined
            );
            // `add` skips paths already published progressively.
            if (gitSucceeded)
              staging.add(this.prefix(root, result.files, roots));
            else buffered.push(...this.prefix(root, result.files, roots));
          } catch {
            // A failed walk of one root still leaves the others useful.
          }
        })
      );
      if (!gitSucceeded) {
        staging.replaceAll(buffered);
        buffered = [];
      }
      publish();
    }

    if (this.disposed) {
      markGitReady();
      return;
    }
    this.activate(
      staging,
      gitSucceeded
        ? WORKSPACE_FILE_INDEX_STATES.READY
        : WORKSPACE_FILE_INDEX_STATES.DEGRADED
    );
    if (this.options.gitVisibleOnly) {
      this.setStatus({
        ...this.status,
        state: WORKSPACE_FILE_INDEX_STATES.DEGRADED,
      });
    }
    this.lastBuildAt = this.dependencies.now();
    // Without a usable Git list, the fallback walk is the first queryable
    // snapshot, so don't release the initial request against an empty store.
    markGitReady();
  }

  private activate(
    store: WorkspacePathStore,
    state: WorkspaceFileIndexState
  ): void {
    if (store !== this.store) {
      this.store = store;
      this.query = new WorkspacePathQuery(store);
    }
    this.setStatus({ state, indexed: store.files.length });
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
    const skip = this.skipDirectories(this.respectGitignore);
    const removed: string[] = [];
    const created: Array<{ root: WorkspaceFileIndexRoot; relative: string }> =
      [];
    let rebuild = false;
    for (const change of changes) {
      const root = this.roots.find(
        (candidate) => candidate.path === change.root
      );
      if (!root) continue;
      const relative = change.path.replace(/\\/g, "/").replace(/^\/+/, "");
      if (isIgnoreRuleFile(relative)) {
        rebuild = true;
        continue;
      }
      if (isSearchPathIgnored(relative, skip, this.respectGitignore)) continue;
      if (change.kind === WORKSPACE_FILE_CHANGE_KINDS.DELETE) {
        removed.push(this.prefix(root, [relative])[0]);
      } else if (change.kind === WORKSPACE_FILE_CHANGE_KINDS.CREATE) {
        created.push({ root, relative });
      }
    }
    if (rebuild) void this.build();

    const added: string[] = [];
    for (const { root, relative } of created) {
      const absolute = path.join(root.path, ...relative.split("/"));
      try {
        const info = await this.dependencies.stat(absolute);
        let paths: string[] = [];
        if (info.isFile()) paths = [relative];
        else if (info.isDirectory()) {
          const result = await this.dependencies.walkSearchFiles(
            absolute,
            this.dependencies.now(),
            Number.POSITIVE_INFINITY,
            Number.POSITIVE_INFINITY,
            skip,
            this.respectGitignore
          );
          paths = result.files.map(
            (file) => `${relative}/${file.replace(/\\/g, "/")}`
          );
        }
        if (this.respectGitignore && paths.length > 0) {
          const absolutes = paths.map((file) => path.resolve(root.path, file));
          const ignored = await this.dependencies.getGitIgnoredPaths(
            root.path,
            absolutes
          );
          paths = paths.filter((_, i) => !ignored.has(absolutes[i]));
        }
        added.push(...this.prefix(root, paths));
      } catch {
        // Watcher races with deletion and inaccessible paths are expected.
      }
    }
    if (this.disposed) return;
    this.store.removeTrees(removed);
    this.store.add(added);
    this.setStatus({ ...this.status, indexed: this.store.files.length });
  }
}

type QueryMessageType =
  | typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES
  | typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES
  | typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS;

export type WorkspaceFileIndexRequest =
  | {
      id: number;
      type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.BUILD;
      options?: WorkspaceFileIndexBuildOptions;
    }
  | {
      id: number;
      type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.APPLY_CHANGES;
      changes: readonly WorkspaceFileChange[];
    }
  | {
      id: number;
      type: QueryMessageType;
      query: string;
      queryId: string;
      limit?: number;
      kind?: WorkspaceFileTreeEntryKind;
      maxResults?: number;
    }
  | {
      id: number;
      type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.CANCEL;
      queryId: string;
    }
  | { id: number; type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.DISPOSE };

export type WorkspaceFileIndexResponse =
  | {
      id?: number;
      type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.RESULT;
      value?: unknown;
      status?: WorkspaceFileIndexStatus;
    }
  | {
      type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.PROGRESS;
      queryId: string;
      progress: {
        scanned: number;
        total: number;
        results: WorkspacePathResult[];
      };
    }
  | {
      type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.STATUS;
      status: WorkspaceFileIndexStatus;
    }
  | {
      type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.LOG;
      level: (typeof WORKSPACE_FILE_INDEX_LOG_LEVELS)[keyof typeof WORKSPACE_FILE_INDEX_LOG_LEVELS];
      message: string;
    }
  | {
      id?: number;
      type: typeof WORKSPACE_FILE_INDEX_MESSAGE_TYPES.ERROR;
      message: string;
    };

type WorkerRequestInput = WorkspaceFileIndexRequest extends infer Request
  ? Request extends WorkspaceFileIndexRequest
    ? Omit<Request, "id">
    : never
  : never;

/** Runs one query-shaped request against a pipeline (worker or in-process). */
export function runPipelineQuery(
  pipeline: WorkspaceFileIndexPipeline,
  request: {
    type: QueryMessageType;
    query: string;
    limit?: number;
    kind?: WorkspaceFileTreeEntryKind;
    maxResults?: number;
  },
  options: WorkspacePathQueryOptions = {}
): Promise<WorkspacePathResult[]> {
  const queryOptions = { ...options, limit: request.limit ?? options.limit };
  switch (request.type) {
    case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES:
      return pipeline.queryFiles(request.query, queryOptions);
    case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES:
      return pipeline.queryPromptFiles(request.query, queryOptions);
    case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS:
      return pipeline.suggestPaths(
        request.query,
        request.kind ?? WORKSPACE_ENTRY_KINDS.FILE,
        request.maxResults,
        queryOptions
      );
  }
}

export interface WorkspaceFileIndexOptions {
  readonly workerHeapMb?: number;
  readonly userFeedbackSink?: UserFeedbackSink;
  readonly workerFactory?: (
    scriptPath: string,
    resourceLimits: { maxOldGenerationSizeMb: number }
  ) => Worker;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  request: WorkerRequestInput;
  onProgress?: WorkspacePathQueryOptions["onProgress"];
}

/** Host transport for a per-workspace worker, with a bounded in-process fallback. */
export class WorkspaceFileIndex implements WorkspaceFileQueries {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly queryRequestIds = new Map<string, number>();
  private nextId = 1;
  private worker?: Worker;
  private fallback?: WorkspaceFileIndexPipeline;
  private status: WorkspaceFileIndexStatus = {
    state: WORKSPACE_FILE_INDEX_STATES.BUILDING,
    indexed: 0,
  };
  private disposed = false;
  private failureStarted = false;
  private buildStarted = false;
  private roots: readonly WorkspaceFileIndexRoot[];
  private respectGitignore: boolean;

  constructor(
    roots: readonly WorkspaceFileIndexRoot[],
    respectGitignore: boolean,
    dependencies?: WorkspaceFileIndexDependencies,
    private readonly options: WorkspaceFileIndexOptions = {}
  ) {
    this.roots = roots;
    this.respectGitignore = respectGitignore;
    // Injected pipeline dependencies keep deterministic unit tests in-process.
    if (dependencies) {
      this.fallback = new WorkspaceFileIndexPipeline(
        roots,
        respectGitignore,
        dependencies
      );
      return;
    }
    try {
      const candidates = [
        path.join(__dirname, "..", "..", "workspaceFileIndexWorker.js"),
        path.join(__dirname, "workspaceFileIndexWorker.js"),
      ];
      const scriptPath = findExistingWorkerPath(candidates);
      if (!scriptPath) {
        throw new Error(
          `Unable to locate workspace file index worker; checked ${candidates.join(", ")}`
        );
      }
      const factory =
        options.workerFactory ??
        ((file, resourceLimits) => new Worker(file, { resourceLimits }));
      this.worker = factory(scriptPath, {
        maxOldGenerationSizeMb:
          options.workerHeapMb ?? FILE_INDEX_WORKER_HEAP_MB,
      });
      this.worker.on("message", (message: WorkspaceFileIndexResponse) =>
        this.onMessage(message)
      );
      this.worker.on("error", (error: Error) => void this.fail(error));
      this.worker.on("exit", (code) => {
        if (!this.disposed && code !== 0) {
          void this.fail(
            new Error(`Workspace file index worker exited with code ${code}`)
          );
        }
      });
    } catch (error) {
      void this.fail(error);
    }
  }

  async build(options: WorkspaceFileIndexBuildOptions = {}): Promise<void> {
    this.buildStarted = true;
    if (options.roots) this.roots = options.roots;
    if (options.respectGitignore !== undefined) {
      this.respectGitignore = options.respectGitignore;
    }
    await this.request({
      type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.BUILD,
      options: { roots: this.roots, respectGitignore: this.respectGitignore },
    });
  }

  async applyChanges(changes: readonly WorkspaceFileChange[]): Promise<void> {
    await this.request({
      type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.APPLY_CHANGES,
      changes,
    });
  }

  queryFiles(
    query: string,
    options: WorkspacePathQueryOptions = {}
  ): Promise<WorkspacePathResult[]> {
    return this.runQuery(
      { type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES, query },
      options
    );
  }

  queryPromptFiles(
    query: string,
    options: WorkspacePathQueryOptions = {}
  ): Promise<WorkspacePathResult[]> {
    return this.runQuery(
      { type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES, query },
      options
    );
  }

  suggestPaths(
    typedPath: string,
    kind: WorkspaceFileTreeEntryKind,
    maxResults?: number,
    options: WorkspacePathQueryOptions = {}
  ): Promise<WorkspacePathResult[]> {
    return this.runQuery(
      {
        type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS,
        query: typedPath,
        kind,
        maxResults,
      },
      options
    );
  }

  getStatus(): WorkspaceFileIndexStatus {
    return this.fallback?.getStatus() ?? this.status;
  }

  cancel(queryId: string): void {
    const id = this.queryRequestIds.get(queryId);
    if (id === undefined || !this.worker) return;
    this.worker.postMessage({
      id: this.nextId++,
      type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.CANCEL,
      queryId,
    } satisfies WorkspaceFileIndexRequest);
  }

  dispose(): void {
    this.disposed = true;
    this.fallback?.dispose();
    const worker = this.worker;
    if (worker) {
      worker.postMessage({
        id: this.nextId++,
        type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.DISPOSE,
      } satisfies WorkspaceFileIndexRequest);
      setTimeout(() => void worker.terminate(), 100);
    }
    this.worker = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Workspace file index disposed"));
    }
    this.pending.clear();
  }

  private async runQuery(
    request: {
      type: QueryMessageType;
      query: string;
      kind?: WorkspaceFileTreeEntryKind;
      maxResults?: number;
    },
    options: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]> {
    if (!this.buildStarted) await this.build();
    if (options.signal?.aborted) return [];
    if (this.fallback) return runPipelineQuery(this.fallback, request, options);
    const id = this.nextId++;
    const queryId = String(id);
    this.queryRequestIds.set(queryId, id);
    const abort = (): void => this.cancel(queryId);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      return (await this.request(
        { ...request, queryId, limit: options.limit },
        id,
        options.onProgress
      )) as WorkspacePathResult[];
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.queryRequestIds.delete(queryId);
    }
  }

  private request(
    message: WorkerRequestInput,
    id = this.nextId++,
    onProgress?: WorkspacePathQueryOptions["onProgress"]
  ): Promise<unknown> {
    if (this.fallback) return this.runInProcess(this.fallback, message);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, request: message, onProgress });
      this.worker?.postMessage({ ...message, id } as WorkspaceFileIndexRequest);
    });
  }

  private async runInProcess(
    pipeline: WorkspaceFileIndexPipeline,
    message: WorkerRequestInput
  ): Promise<unknown> {
    switch (message.type) {
      case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.BUILD:
        return pipeline.build(message.options);
      case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.APPLY_CHANGES:
        return pipeline.applyChanges(message.changes);
      case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES:
      case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES:
      case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS:
        return runPipelineQuery(pipeline, message);
      default:
        return undefined;
    }
  }

  private onMessage(message: WorkspaceFileIndexResponse): void {
    switch (message.type) {
      case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.STATUS:
        this.status = message.status;
        return;
      case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.LOG:
        if (message.level === WORKSPACE_FILE_INDEX_LOG_LEVELS.WARN) {
          Log.warn(message.message);
        } else if (message.level === WORKSPACE_FILE_INDEX_LOG_LEVELS.ERROR) {
          Log.error(message.message);
        } else Log.info(message.message);
        return;
      case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.PROGRESS: {
        const id = this.queryRequestIds.get(message.queryId);
        if (id !== undefined)
          this.pending.get(id)?.onProgress?.(message.progress);
        return;
      }
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.ERROR) {
      pending.reject(new Error(message.message));
      return;
    }
    if (message.status) this.status = message.status;
    pending.resolve(message.value);
  }

  private async fail(error: unknown): Promise<void> {
    if (this.failureStarted || this.fallback || this.disposed) return;
    this.failureStarted = true;
    this.worker?.removeAllListeners();
    void this.worker?.terminate();
    this.worker = undefined;
    const outOfMemory =
      (error as NodeJS.ErrnoException)?.code === "ERR_WORKER_OUT_OF_MEMORY";
    Log.warn(
      `Workspace file index worker failed${outOfMemory ? " with ERR_WORKER_OUT_OF_MEMORY" : ""}: ${error instanceof Error ? error.message : String(error)}`
    );
    if (!workerFailureWarningShown && this.options.userFeedbackSink) {
      workerFailureWarningShown = true;
      notifyUserFeedback(
        this.options.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.WARNING,
        WORKER_MEMORY_WARNING
      );
    }
    // D4: no respawn. The in-process fallback holds only the Git-visible
    // list, so it can never walk ignored trees onto the extension-host heap.
    const fallback = new WorkspaceFileIndexPipeline(
      this.roots,
      this.respectGitignore,
      DEFAULT_DEPENDENCIES,
      { gitVisibleOnly: true }
    );
    this.fallback = fallback;
    await fallback.build();
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.queryRequestIds.clear();
    for (const entry of pending) {
      this.runInProcess(fallback, entry.request).then(
        entry.resolve,
        (fallbackError: unknown) =>
          entry.reject(
            fallbackError instanceof Error
              ? fallbackError
              : new Error(String(fallbackError))
          )
      );
    }
  }
}
