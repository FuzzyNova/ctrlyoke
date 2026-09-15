/**
 * Minimal no-op shim for the `vscode` module.
 *
 * Used exclusively in the esbuild CLI bundle (out/cli.js). The CLI binary runs
 * in plain Node.js where the real `vscode` module is unavailable. By aliasing
 * "vscode" to this file in esbuild's CLI config, all vscode imports compile
 * cleanly and the APIs degrade gracefully:
 *
 *  - Direct UI APIs used by shared code (showMessage, createTerminal) are
 *    no-ops or return undefined; operational feedback is injected separately
 *    through UserFeedbackSink.
 *  - workspace.getConfiguration() returns defaults for every key (or delegate to
 *    the registered CliAdapter so CLI flags reach ConfigurationUtils callers)
 *  - workspace.fs and openTextDocument delegate to Node.js fs
 *  - File system watchers are no-ops
 *  - lm.selectChatModels() returns an empty array
 *
 * This shim is NOT imported by extension.ts or any VS Code-only code.
 */
import * as fsNode from "fs";
import * as pathNode from "path";

// ---------------------------------------------------------------------------
// CLI adapter registration
// ---------------------------------------------------------------------------
/** Registered CLI adapter that handles configuration lookups. */
let _registeredAdapter:
  { getConfig<T>(key: string, defaultValue: T): T } | undefined;

/**
 * Register a CLI adapter so that `workspace.getConfiguration().get(key, default)`
 * delegates to `adapter.getConfig(key, default)` instead of always returning the
 * default. Must be called in cli.ts immediately after constructing `CliAdapter`.
 *
 * This makes every `ConfigurationUtils` call inside CLI provider code (e.g.
 * `getCliAllowedTools()`, `getCliToolPermissions()`) transparently reflect the
 * flags the user passed on the command line.
 */
export function registerCliAdapter(adapter: {
  getConfig<T>(key: string, defaultValue: T): T;
}): void {
  _registeredAdapter = adapter;
}

/** Unregister the CLI adapter (test / teardown only). */
export function unregisterCliAdapter(): void {
  _registeredAdapter = undefined;
}

// ---------------------------------------------------------------------------
// Types / interfaces
// ---------------------------------------------------------------------------
export interface Disposable {
  dispose(): void;
}

interface VscodeEventEmitter<T> {
  readonly event: (listener: (e: T) => unknown) => Disposable;
  fire(data: T): void;
  dispose(): void;
}

const noopDisposable: Disposable = { dispose: () => {} };

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------
export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_msg: string) => {},
    append: (_msg: string) => {},
    show: () => {},
    dispose: () => {},
  }),
  showErrorMessage: (
    _msg: string,
    ..._items: string[]
  ): Promise<string | undefined> => Promise.resolve(undefined),
  showWarningMessage: (
    _msg: string,
    ..._items: string[]
  ): Promise<string | undefined> => Promise.resolve(undefined),
  showInformationMessage: (
    _msg: string,
    ..._items: string[]
  ): Promise<string | undefined> => Promise.resolve(undefined),
  setStatusBarMessage: (_msg: string, _timeout?: number): Disposable =>
    noopDisposable,
  /** createTerminal is VS Code-only and never called in CLI/headless mode */
  createTerminal: (_options: unknown): never => {
    throw new Error(
      "[vscode-shim] createTerminal() is not available in CLI mode"
    );
  },
  onDidChangeActiveTextEditor: (_listener: unknown): Disposable =>
    noopDisposable,
  showQuickPick: (_items: unknown, _options?: unknown): Promise<undefined> =>
    Promise.resolve(undefined),
  showTextDocument: (_doc: unknown, _options?: unknown): Promise<void> =>
    Promise.resolve(),
};

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------
export const workspace = {
  /**
   * Return a configuration-like object. Values are delegated to the registered
   * CliAdapter (when running as the standalone CLI binary) so that CLI flag
   * values reach callers like ConfigurationUtils. Falls back to `defaultValue`
   * when no adapter is registered (VS Code extension path — the real vscode
   * module is used there, not this shim).
   */
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue: T): T =>
      _registeredAdapter
        ? _registeredAdapter.getConfig(key, defaultValue)
        : defaultValue,
    has: (_key: string): boolean => false,
    inspect: (_key: string) => undefined,
    update: (_key: string, _value: unknown, _target?: unknown): Promise<void> =>
      Promise.resolve(),
  }),

  workspaceFolders: undefined as undefined,

  /**
   * There is no VS Code workspace-folder model in the standalone CLI. Shared
   * code uses this lookup only to discover optional workspace-local resources,
   * so report no match rather than making the headless bundle fail at runtime.
   */
  getWorkspaceFolder: (_uri: { fsPath?: string }) => undefined,

  /** Use Node.js fs to fulfill basic file-system operations. */
  fs: {
    async stat(uri: { fsPath: string }) {
      const s = await fsNode.promises.stat(uri.fsPath);
      return {
        type: s.isDirectory()
          ? 2 /* Directory */
          : s.isFile()
            ? 1 /* File */
            : 0,
        size: s.size,
        ctime: s.ctimeMs,
        mtime: s.mtimeMs,
      };
    },
    async readFile(uri: { fsPath: string }): Promise<Uint8Array> {
      const buf = await fsNode.promises.readFile(uri.fsPath);
      return new Uint8Array(buf);
    },
    async writeFile(
      uri: { fsPath: string },
      content: Uint8Array
    ): Promise<void> {
      await fsNode.promises.writeFile(uri.fsPath, content);
    },
    async createDirectory(uri: { fsPath: string }): Promise<void> {
      await fsNode.promises.mkdir(uri.fsPath, { recursive: true });
    },
    async readDirectory(uri: {
      fsPath: string;
    }): Promise<Array<[string, number]>> {
      const entries = await fsNode.promises.readdir(uri.fsPath, {
        withFileTypes: true,
      });
      return entries.map((e) => [
        e.name,
        e.isDirectory() ? 2 : e.isFile() ? 1 : 0,
      ]);
    },
  },

  async openTextDocument(uri: { fsPath?: string } | string): Promise<{
    getText(): string;
    fileName: string;
    languageId: string;
  }> {
    const fsPath = typeof uri === "string" ? uri : (uri.fsPath ?? String(uri));
    try {
      const content = await fsNode.promises.readFile(fsPath, "utf-8");
      return {
        getText: () => content,
        fileName: fsPath,
        languageId: "plaintext",
      };
    } catch {
      return { getText: () => "", fileName: fsPath, languageId: "plaintext" };
    }
  },

  createFileSystemWatcher: (
    _pattern: unknown
  ): {
    onDidChange(l: unknown): Disposable;
    onDidCreate(l: unknown): Disposable;
    onDidDelete(l: unknown): Disposable;
    dispose(): void;
  } => ({
    onDidChange: (_l: unknown) => noopDisposable,
    onDidCreate: (_l: unknown) => noopDisposable,
    onDidDelete: (_l: unknown) => noopDisposable,
    dispose: () => {},
  }),
};

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
export const commands = {
  executeCommand: (_command: string, ..._args: unknown[]): Promise<undefined> =>
    Promise.resolve(undefined),
};

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------
export const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: "file", path: fsPath }),
  joinPath: (uri: { fsPath: string }, ...pathSegments: string[]) => {
    const joined = pathNode.join(uri.fsPath, ...pathSegments);
    return { fsPath: joined, scheme: "file", path: joined };
  },
  parse: (uriString: string) => ({
    fsPath: uriString,
    scheme: "file",
    path: uriString,
  }),
};

// ---------------------------------------------------------------------------
// RelativePattern
// ---------------------------------------------------------------------------
export class RelativePattern {
  constructor(
    public readonly base: string | { uri: { fsPath: string } },
    public readonly pattern: string
  ) {}
}

// ---------------------------------------------------------------------------
// FileType enum (values must match VS Code exactly)
// ---------------------------------------------------------------------------
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

// ---------------------------------------------------------------------------
// ConfigurationTarget enum
// ---------------------------------------------------------------------------
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// ---------------------------------------------------------------------------
// Position / Range
// ---------------------------------------------------------------------------
export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position
  ) {}
}

// ---------------------------------------------------------------------------
// EventEmitter  (vscode.EventEmitter<T>)
// ---------------------------------------------------------------------------
export class EventEmitter<T> implements VscodeEventEmitter<T> {
  private listeners: Array<(e: T) => unknown> = [];

  readonly event = (listener: (e: T) => unknown): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(data: T): void {
    this.listeners.forEach((l) => l(data));
  }

  dispose(): void {
    this.listeners = [];
  }
}

// ---------------------------------------------------------------------------
// lm (Language Model API)
// ---------------------------------------------------------------------------
export const lm = {
  selectChatModels: (_selector?: unknown): Promise<unknown[]> =>
    Promise.resolve([]),
};

// ---------------------------------------------------------------------------
// languages (minimal stub for document symbol provider etc.)
// ---------------------------------------------------------------------------
export const languages = {
  createDiagnosticCollection: (_name?: string) => ({
    set: () => {},
    delete: () => {},
    clear: () => {},
    dispose: () => {},
  }),
};

// ---------------------------------------------------------------------------
// extensions (minimal stub)
// ---------------------------------------------------------------------------
export const extensions = {
  getExtension: (_id: string) => undefined,
};
