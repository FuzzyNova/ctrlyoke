import * as vscode from "vscode";
import type { FileWatcherContractDriver } from "../helpers/fileWatcherContract";
import { VsCodeFileWatcherFactory } from "../../platform/VsCodeFileWatcher";
import { registerFileWatcherContractTests } from "../helpers/fileWatcherContract";

class FakeFileSystemWatcher implements vscode.FileSystemWatcher {
  readonly ignoreCreateEvents = false;
  readonly ignoreChangeEvents = false;
  readonly ignoreDeleteEvents = false;

  private readonly createEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly deleteEmitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidCreate: vscode.Event<vscode.Uri> = (listener) =>
    this.createEmitter.event(listener);
  readonly onDidChange: vscode.Event<vscode.Uri> = (listener) =>
    this.changeEmitter.event(listener);
  readonly onDidDelete: vscode.Event<vscode.Uri> = (listener) =>
    this.deleteEmitter.event(listener);

  dispose(): void {
    this.createEmitter.dispose();
    this.changeEmitter.dispose();
    this.deleteEmitter.dispose();
  }

  fireCreate(filePath: string): void {
    this.createEmitter.fire(vscode.Uri.file(filePath));
  }

  fireChange(filePath: string): void {
    this.changeEmitter.fire(vscode.Uri.file(filePath));
  }

  fireDelete(filePath: string): void {
    this.deleteEmitter.fire(vscode.Uri.file(filePath));
  }
}

function createVsCodeContractDriver(_root: string): FileWatcherContractDriver {
  const originalCreateFileSystemWatcher =
    vscode.workspace.createFileSystemWatcher;
  let watcher: FakeFileSystemWatcher | undefined;
  Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
    configurable: true,
    value: () => {
      watcher = new FakeFileSystemWatcher();
      return watcher;
    },
  });

  return {
    factory: new VsCodeFileWatcherFactory(),
    emitCreate: async (filePath) => {
      if (!watcher) throw new Error("VS Code watcher was not created");
      watcher.fireCreate(filePath);
    },
    emitChange: async (filePath) => {
      if (!watcher) throw new Error("VS Code watcher was not created");
      watcher.fireChange(filePath);
    },
    emitDelete: async (filePath) => {
      if (!watcher) throw new Error("VS Code watcher was not created");
      watcher.fireDelete(filePath);
    },
    dispose: () => {
      Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
        configurable: true,
        value: originalCreateFileSystemWatcher,
      });
    },
  };
}

registerFileWatcherContractTests(
  "VS Code file watcher",
  createVsCodeContractDriver
);
