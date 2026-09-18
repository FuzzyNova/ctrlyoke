import * as path from "path";
import * as vscode from "vscode";
import type {
  Disposable,
  FileWatcher,
  FileWatcherFactory,
} from "../core/HostPorts";

function normalizeAbsolutePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

/** VS Code implementation of the host-neutral file watcher contract. */
class VsCodeFileWatcher implements FileWatcher {
  private readonly subscriptions = new Set<vscode.Disposable>();
  private disposed = false;

  private readonly watcher: vscode.FileSystemWatcher;

  constructor(basePath: string, glob: string) {
    const normalizedBasePath = normalizeAbsolutePath(basePath);
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(normalizedBasePath), glob)
    );
  }

  onDidCreate(listener: (filePath: string) => void): Disposable {
    return this.subscribe(this.watcher.onDidCreate, listener);
  }

  onDidChange(listener: (filePath: string) => void): Disposable {
    return this.subscribe(this.watcher.onDidChange, listener);
  }

  onDidDelete(listener: (filePath: string) => void): Disposable {
    return this.subscribe(this.watcher.onDidDelete, listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.clear();
    this.watcher.dispose();
  }

  private subscribe(
    event: vscode.Event<vscode.Uri>,
    listener: (filePath: string) => void
  ): Disposable {
    if (this.disposed) {
      return { dispose: () => undefined };
    }

    const subscription = event((uri) => {
      listener(normalizeAbsolutePath(uri.fsPath));
    });
    this.subscriptions.add(subscription);

    return {
      dispose: () => {
        if (!this.subscriptions.delete(subscription)) return;
        subscription.dispose();
      },
    };
  }
}

export class VsCodeFileWatcherFactory implements FileWatcherFactory {
  create(basePath: string, glob: string): FileWatcher {
    return new VsCodeFileWatcher(basePath, glob);
  }
}
