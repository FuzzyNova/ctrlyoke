import * as path from "path";
import { watch, type FSWatcher } from "chokidar";
import { minimatch } from "minimatch";
import { DEFAULT_FILE_WATCHER_EXCLUDES } from "../types/DashboardConstants";
import type {
  Disposable,
  FileWatcher,
  FileWatcherFactory,
} from "../core/HostPorts";

function normalizeAbsolutePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

/** Node implementation of the host-neutral file watcher contract. */
class NodeFileWatcher implements FileWatcher {
  private readonly subscriptions = new Set<Disposable>();
  private readonly watcher: FSWatcher;
  private disposed = false;

  constructor(basePath: string, glob: string) {
    const normalizedBasePath = normalizeAbsolutePath(basePath);
    const segments = glob.split("/");
    const hasRecursiveGlob = glob.includes("**");
    const isLiteralBasename =
      segments.length === 1 &&
      ![...glob].some((character) => "*?[]{}".includes(character));
    const depth = hasRecursiveGlob
      ? undefined
      : Math.max(0, segments.length - 1);
    const excluded = (relativePath: string): boolean =>
      DEFAULT_FILE_WATCHER_EXCLUDES.some(
        (pattern) =>
          minimatch(relativePath, pattern, { dot: true }) ||
          minimatch(`${relativePath}/sentinel`, pattern, { dot: true })
      );
    this.watcher = watch(
      isLiteralBasename
        ? path.join(normalizedBasePath, glob)
        : normalizedBasePath,
      {
        ignoreInitial: true,
        ...(depth === undefined ? {} : { depth }),
        followSymlinks: false,
        ignored: (watchedPath, stats) => {
          const absolutePath = normalizeAbsolutePath(watchedPath);
          const relativePath = path
            .relative(normalizedBasePath, absolutePath)
            .split(path.sep)
            .join("/");
          if (!relativePath || relativePath === ".") return false;
          if (excluded(relativePath)) return true;
          if (!stats?.isDirectory()) return false;
          return !minimatch(relativePath, glob, { dot: true, partial: true });
        },
      }
    );
    this.watcher.on("all", (eventName, watchedPath) => {
      const absolutePath = normalizeAbsolutePath(watchedPath);
      const relativePath = path
        .relative(normalizedBasePath, absolutePath)
        .split(path.sep)
        .join("/");
      if (!relativePath || !minimatch(relativePath, glob)) return;

      const listeners = (
        {
          add: this.listeners.create,
          addDir: this.listeners.create,
          change: this.listeners.change,
          unlink: this.listeners.delete,
          unlinkDir: this.listeners.delete,
        } as Partial<Record<typeof eventName, Set<(filePath: string) => void>>>
      )[eventName];
      for (const listener of listeners ?? []) listener(absolutePath);
    });
  }

  private readonly listeners: Record<
    "create" | "change" | "delete",
    Set<(filePath: string) => void>
  > = { create: new Set(), change: new Set(), delete: new Set() };

  onDidCreate(listener: (filePath: string) => void): Disposable {
    return this.subscribe("create", listener);
  }

  onDidChange(listener: (filePath: string) => void): Disposable {
    return this.subscribe("change", listener);
  }

  onDidDelete(listener: (filePath: string) => void): Disposable {
    return this.subscribe("delete", listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.clear();
    void this.watcher.close();
  }

  private subscribe(
    event: "create" | "change" | "delete",
    listener: (filePath: string) => void
  ): Disposable {
    if (this.disposed) return { dispose: () => undefined };
    this.listeners[event].add(listener);
    const subscription: Disposable = {
      dispose: () => {
        if (!this.listeners[event].delete(listener)) return;
        this.subscriptions.delete(subscription);
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }
}

export class NodeFileWatcherFactory implements FileWatcherFactory {
  create(basePath: string, glob: string): FileWatcher {
    return new NodeFileWatcher(basePath, glob);
  }
}
