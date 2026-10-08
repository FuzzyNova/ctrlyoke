import * as vscode from "vscode";
import { getCtrlYokeFileKind } from "./CtrlYokeFileKind";
import { getWorkflowPromptDiagnostics } from "./WorkflowPromptDiagnostics";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  PROMPT_DIAGNOSTIC_DEBOUNCE_MS,
  PROMPT_DIAGNOSTICS_SOURCE,
  VSCODE_URI_SCHEMES,
  type CtrlYokeFileKind,
  type PromptDiagnosticSeverity,
} from "../types/DashboardConstants";
import type {
  ContextReferenceValidationResult,
  IdentifiedContextReference,
  PromptDiagnostic,
} from "../utils/PromptDiagnosticRules";
import { Log } from "../utils/Log";

/** Resolves references the way the dashboard editor does; `documentPath` anchors `./` references. */
export type PromptReferenceValidator = (
  references: IdentifiedContextReference[],
  documentPath: string
) => Promise<ContextReferenceValidationResult[]>;

/**
 * Something whose change can alter how references resolve (trusted roots,
 * settings). Registers `listener` and returns its unsubscribe, the shape of
 * `configService.subscribe`.
 */
export type PromptDiagnosticsRefreshTrigger = (
  listener: () => void
) => () => void;

export interface PromptDiagnosticsProviderOptions {
  /** Each change re-lints every open document (debounced). */
  refreshTriggers?: readonly PromptDiagnosticsRefreshTrigger[];
}

// A function, not a module-level table: the bundle is loaded against a stub
// `vscode` in the packaging test, where enums are undefined at load time.
function toVsCodeSeverity(
  severity: PromptDiagnosticSeverity
): vscode.DiagnosticSeverity {
  switch (severity) {
    case COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR:
      return vscode.DiagnosticSeverity.Error;
    case COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING:
      return vscode.DiagnosticSeverity.Warning;
    case COMPATIBILITY_DIAGNOSTIC_SEVERITIES.INFO:
      return vscode.DiagnosticSeverity.Information;
  }
}

/** The ctrlyoke kind of an on-disk document, or null when it is not linted. */
function lintableKind(document: vscode.TextDocument): CtrlYokeFileKind | null {
  return document.uri.scheme === VSCODE_URI_SCHEMES.FILE
    ? getCtrlYokeFileKind(document.fileName)
    : null;
}

/**
 * Squiggles for the prompt-text lint rules the dashboard editor already runs
 * (unresolved or code-suppressed references, prior-context and condition-output
 * misuse), in ctrlyoke prompt and workflow files.
 *
 * Runs on open, on change (debounced), on save, and again (debounced) for
 * every open file when any workspace file is created or deleted, so "file not
 * found" clears when the file appears. That uses a file system watcher, not
 * `onDidCreateFiles`, because those events only fire for edits made through
 * VS Code and the usual writer here is a harness. The host's
 * `refreshTriggers` (trust decisions, settings) re-run every open file the
 * same way, so approving an external root clears its warning without an
 * edit. Only `file:` documents are linted, so a `git:` diff side does not
 * duplicate every entry. Spelling is deliberately left to spell-check
 * extensions.
 */
export class PromptDiagnosticsProvider implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(
    PROMPT_DIAGNOSTICS_SOURCE
  );
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Latest refresh per document; an older pass that finishes late is dropped. */
  private readonly generations = new Map<string, number>();
  private refreshAllTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [this.collection];

  constructor(
    private readonly validateReferences: PromptReferenceValidator,
    options: PromptDiagnosticsProviderOptions = {}
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const refreshAllSoon = () => this.scheduleRefreshAll();
    for (const trigger of options.refreshTriggers ?? []) {
      this.disposables.push({ dispose: trigger(refreshAllSoon) });
    }
    this.disposables.push(
      watcher,
      watcher.onDidCreate(refreshAllSoon),
      watcher.onDidDelete(refreshAllSoon),
      vscode.workspace.onDidOpenTextDocument((doc) => void this.refresh(doc)),
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.schedule(event.document)
      ),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.refresh(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.clear(doc))
    );
    this.refreshAll();
  }

  /** Diagnostics currently published for a document (used by tests). */
  getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
    return this.collection.get(uri) ?? [];
  }

  /** Recompute now, bypassing the debounce. */
  async refresh(document: vscode.TextDocument): Promise<void> {
    const kind = lintableKind(document);
    if (!kind) return;
    this.cancelTimer(document);
    const key = document.uri.toString();
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const version = document.version;
    try {
      const diagnostics = await getWorkflowPromptDiagnostics(
        document.getText(),
        kind,
        (references) => this.validateReferences(references, document.fileName)
      );
      // The text moved on while references resolved; the newer pass owns the result.
      if (
        document.version !== version ||
        document.isClosed ||
        this.generations.get(key) !== generation
      ) {
        return;
      }
      this.collection.set(
        document.uri,
        diagnostics.map((diagnostic) => this.toDiagnostic(document, diagnostic))
      );
    } catch (error) {
      Log.warn(
        "[PromptDiagnosticsProvider] Failed to compute diagnostics",
        error
      );
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.refreshAllTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  private refreshAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      void this.refresh(document);
    }
  }

  /** Coalesces a burst of file events (a harness writing many files) into one pass. */
  private scheduleRefreshAll(): void {
    clearTimeout(this.refreshAllTimer);
    this.refreshAllTimer = setTimeout(
      () => this.refreshAll(),
      PROMPT_DIAGNOSTIC_DEBOUNCE_MS
    );
  }

  private schedule(document: vscode.TextDocument): void {
    if (!lintableKind(document)) return;
    this.cancelTimer(document);
    this.timers.set(
      document.uri.toString(),
      setTimeout(
        () => void this.refresh(document),
        PROMPT_DIAGNOSTIC_DEBOUNCE_MS
      )
    );
  }

  private cancelTimer(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  private clear(document: vscode.TextDocument): void {
    this.cancelTimer(document);
    this.generations.delete(document.uri.toString());
    this.collection.delete(document.uri);
  }

  private toDiagnostic(
    document: vscode.TextDocument,
    diagnostic: PromptDiagnostic
  ): vscode.Diagnostic {
    const range = new vscode.Range(
      document.positionAt(diagnostic.from),
      document.positionAt(diagnostic.to)
    );
    const result = new vscode.Diagnostic(
      range,
      diagnostic.detail
        ? `${diagnostic.message}\n${diagnostic.detail}`
        : diagnostic.message,
      toVsCodeSeverity(diagnostic.severity)
    );
    result.source = PROMPT_DIAGNOSTICS_SOURCE;
    result.code = diagnostic.code;
    return result;
  }
}
