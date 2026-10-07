import type { FileWatcher, FileWatcherFactory } from "../../core/HostPorts";

class NoopFileWatcher implements FileWatcher {
  private readonly created = new Set<(filePath: string) => void>();
  private readonly changed = new Set<(filePath: string) => void>();
  private readonly deleted = new Set<(filePath: string) => void>();

  onDidChange(listener: (filePath: string) => void): { dispose(): void } {
    this.changed.add(listener);
    return { dispose: () => this.changed.delete(listener) };
  }

  onDidDelete(listener: (filePath: string) => void): { dispose(): void } {
    this.deleted.add(listener);
    return { dispose: () => this.deleted.delete(listener) };
  }

  onDidCreate(listener: (filePath: string) => void): { dispose(): void } {
    this.created.add(listener);
    return { dispose: () => this.created.delete(listener) };
  }

  dispose(): void {
    this.created.clear();
    this.changed.clear();
    this.deleted.clear();
  }

  fireChange(filePath: string): void {
    for (const listener of this.changed) listener(filePath);
  }
}

export class NoopFileWatcherFactory implements FileWatcherFactory {
  readonly watchers: NoopFileWatcher[] = [];

  create(): FileWatcher {
    const watcher = new NoopFileWatcher();
    this.watchers.push(watcher);
    return watcher;
  }

  fireChange(filePath: string): void {
    for (const watcher of this.watchers) watcher.fireChange(filePath);
  }
}
