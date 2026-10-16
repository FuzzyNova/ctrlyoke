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

/**
 * Self-contained index pipeline. Its public methods form the message-shaped
 * API used by the worker host in the next phase.
 */
export class WorkspaceFileIndex implements WorkspaceFileQueries {
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
    this.buildPromise = this.performBuild(initialBuild, markGitReady, buildRoots, respectGitignore).finally(() => {
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
    respectGitignore: boolean
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
    }
    markGitReady();

    let walked: string[] = [];
    if (!respectGitignore || !gitSucceeded) {
      const walkedByRoot = await Promise.all(roots.map(async (root) => {
        try {
          const result = await this.dependencies.walkSearchFiles(
            root.path,
            this.dependencies.now(),
            Number.POSITIVE_INFINITY,
            Number.POSITIVE_INFINITY,
            gitSucceeded ? skip : DEFAULT_SKIP_DIRECTORIES,
            true
          );
          return this.prefix(root, result.files, roots);
        } catch {
          // A partial walk remains useful; the index reports degraded below.
          return [];
        }
      }));
      walked = walkedByRoot.flat();
    }

    if (this.disposed) return;
    if (gitSucceeded) staging.add(walked);
    else staging.replaceAll(walked);
    this.activate(staging, gitSucceeded ? WORKSPACE_FILE_INDEX_STATES.READY : WORKSPACE_FILE_INDEX_STATES.DEGRADED);
    this.lastBuildAt = this.dependencies.now();
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
      if (isSearchPathIgnored(relative, skip, true)) continue;
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
          const result = await this.dependencies.walkSearchFiles(absolute, this.dependencies.now(), Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, skip, true);
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
