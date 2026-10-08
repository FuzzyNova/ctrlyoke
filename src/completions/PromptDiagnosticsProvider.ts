import * as vscode from "vscode";
import { getCtrlYokeFileKind } from "./CtrlYokeFileKind";
import { getWorkflowPromptDiagnostics } from "./WorkflowPromptDiagnostics";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  PROMPT_DIAGNOSTIC_DEBOUNCE_MS,
  PROMPT_DIAGNOSTICS_SOURCE,
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

/**
 * Squiggles for the prompt-text lint rules the dashboard editor already runs
 * (unresolved or code-suppressed references, prior-context and condition-output
 * misuse), in ctrlyoke prompt and workflow files.
 *
 * Runs on open, on change (debounced), on save, and again for every open file
 * when workspace files are created, deleted or renamed, so "file not found"
 * clears when the file appears. Spelling is deliberately left to spell-check
 * extensions.
 */
export class PromptDiagnosticsProvider implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(
    PROMPT_DIAGNOSTICS_SOURCE
  );
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [this.collection];

  constructor(private readonly validateReferences: PromptReferenceValidator) {
    const refreshFiles = () => this.refreshAll();
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => void this.refresh(doc)),
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.schedule(event.document)
      ),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.refresh(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.clear(doc)),
      vscode.workspace.onDidCreateFiles(refreshFiles),
      vscode.workspace.onDidDeleteFiles(refreshFiles),
      vscode.workspace.onDidRenameFiles(refreshFiles)
    );
    this.refreshAll();
  }

  /** Diagnostics currently published for a document (used by tests). */
  getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
    return this.collection.get(uri) ?? [];
  }

  /** Recompute now, bypassing the debounce. */
  async refresh(document: vscode.TextDocument): Promise<void> {
    const kind = getCtrlYokeFileKind(document.fileName);
    if (!kind) return;
    this.cancelTimer(document);
    const version = document.version;
    try {
      const diagnostics = await getWorkflowPromptDiagnostics(
        document.getText(),
        kind,
        (references) => this.validateReferences(references, document.fileName)
      );
      // The text moved on while references resolved; the newer pass owns the result.
      if (document.version !== version || document.isClosed) return;
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
    for (const disposable of this.disposables) disposable.dispose();
  }

  private refreshAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      void this.refresh(document);
    }
  }

  private schedule(document: vscode.TextDocument): void {
    if (!getCtrlYokeFileKind(document.fileName)) return;
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
