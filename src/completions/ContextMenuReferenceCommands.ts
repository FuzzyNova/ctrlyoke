import * as vscode from "vscode";
import {
  buildDirectoryReference,
  buildFileReference,
  buildGitReference,
  buildSelectionReference,
  buildSymbolReference,
  toWorkspaceRelativeReferencePath,
} from "./ContextReferenceBuilder";
import type { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import { PROMPT_EDITOR_INSERT_MODES } from "../types/DashboardConstants";
import type { PromptEditorInsertRequest } from "../types/WebviewMessageTypes";
import { Log } from "../utils/Log";

interface TimelineItemLike {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  detail?: unknown;
  tooltip?: unknown;
  contextValue?: unknown;
  command?: { arguments?: unknown[] };
}

export class ContextMenuReferenceCommands {
  constructor(private readonly webviewProvider: FlightPathWebviewProvider) {}

  async addFileToPromptEditor(uri: vscode.Uri): Promise<void> {
    if (!uri) {
      return;
    }

    const relativePath = toWorkspaceRelativeReferencePath(uri);
    if (!relativePath) {
      void vscode.window.showWarningMessage(
        "FlightPath: Selected file is outside the workspace."
      );
      return;
    }

    await this.insertReferences([buildFileReference(relativePath)]);
  }

  async addDirectoryToPromptEditor(uri: vscode.Uri): Promise<void> {
    if (!uri) {
      return;
    }

    const relativePath = toWorkspaceRelativeReferencePath(uri);
    if (!relativePath) {
      void vscode.window.showWarningMessage(
        "FlightPath: Selected directory is outside the workspace."
      );
      return;
    }

    await this.insertReferences([buildDirectoryReference(relativePath)]);
  }

  async addSelectionToPromptEditor(uri: vscode.Uri): Promise<void> {
    if (!uri) {
      return;
    }

    const relativePath = toWorkspaceRelativeReferencePath(uri);
    if (!relativePath) {
      void vscode.window.showWarningMessage(
        "FlightPath: Selected file is outside the workspace."
      );
      return;
    }

    const editor =
      vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()
        ? vscode.window.activeTextEditor
        : undefined;

    const startLine =
      editor && !editor.selection.isEmpty ? editor.selection.start.line + 1 : 1;
    const endLine =
      editor && !editor.selection.isEmpty ? editor.selection.end.line + 1 : 1;

    await this.insertReferences([
      buildSelectionReference(relativePath, startLine, endLine),
    ]);
  }

  async addSymbolToPromptEditor(
    uri: vscode.Uri,
    lineNumber?: number
  ): Promise<void> {
    if (!uri) {
      return;
    }

    const relativePath = toWorkspaceRelativeReferencePath(uri);
    if (!relativePath) {
      void vscode.window.showWarningMessage(
        "FlightPath: Selected file is outside the workspace."
      );
      return;
    }

    const editor =
      vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()
        ? vscode.window.activeTextEditor
        : undefined;

    const targetLine = Math.max(
      1,
      lineNumber ?? (editor?.selection.active.line ?? 0) + 1
    );
    const symbolReference = await this.tryBuildSymbolReference(uri, targetLine);
    if (symbolReference) {
      await this.insertReferences([symbolReference]);
      return;
    }

    await this.insertReferences([
      buildSelectionReference(relativePath, targetLine, targetLine),
    ]);
  }

  async addScmResourcesToPromptEditor(...args: unknown[]): Promise<void> {
    const resources = this.extractScmResourceUris(args);
    if (resources.length === 0) {
      return;
    }

    const references = resources
      .map((resource) => {
        const relativePath = toWorkspaceRelativeReferencePath(resource);
        return relativePath ? buildFileReference(relativePath) : null;
      })
      .filter((reference): reference is string => reference !== null);

    if (references.length === 0) {
      void vscode.window.showWarningMessage(
        "FlightPath: No selected SCM resources are inside the workspace."
      );
      return;
    }

    await this.insertReferences(references);
  }

  async addTimelineCommitToPromptEditor(item: unknown): Promise<void> {
    const commitHash = this.extractTimelineCommitHash(item);
    if (!commitHash) {
      void vscode.window.showWarningMessage(
        "FlightPath: Could not resolve a commit hash from the selected timeline item."
      );
      return;
    }

    await this.insertReferences([buildGitReference(commitHash)]);
  }

  private async insertReferences(references: string[]): Promise<void> {
    if (references.length === 0) {
      return;
    }

    const request: PromptEditorInsertRequest = {
      requestId: `context-menu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      references,
      mode: PROMPT_EDITOR_INSERT_MODES.INSERT,
    };

    await this.webviewProvider.enqueuePromptEditorInsert(request);
  }

  private async tryBuildSymbolReference(
    uri: vscode.Uri,
    lineNumber: number
  ): Promise<string | undefined> {
    try {
      const symbols = (await vscode.commands.executeCommand(
        "vscode.executeDocumentSymbolProvider",
        uri
      )) as vscode.DocumentSymbol[] | undefined;
      if (!symbols?.length) {
        return undefined;
      }

      const targetLine = lineNumber - 1;
      const symbol = this.findInnermostSymbolAtLine(symbols, targetLine);
      if (!symbol) {
        return undefined;
      }

      const relativePath = toWorkspaceRelativeReferencePath(uri);
      if (!relativePath) {
        return undefined;
      }

      return buildSymbolReference(
        relativePath,
        symbol.name,
        symbol.range.start.line + 1
      );
    } catch (error) {
      Log.warn(
        "FlightPath: Failed to resolve symbol for editor context",
        error
      );
      return undefined;
    }
  }

  private findInnermostSymbolAtLine(
    symbols: vscode.DocumentSymbol[],
    targetLine: number
  ): vscode.DocumentSymbol | undefined {
    for (const symbol of symbols) {
      if (
        targetLine < symbol.range.start.line ||
        targetLine > symbol.range.end.line
      ) {
        continue;
      }

      const childMatch = this.findInnermostSymbolAtLine(
        symbol.children,
        targetLine
      );
      return childMatch ?? symbol;
    }

    return undefined;
  }

  private extractScmResourceUris(args: unknown[]): vscode.Uri[] {
    const flattened = args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg]));
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];

    for (const entry of flattened) {
      const resourceUri = this.extractResourceUri(entry);
      if (!resourceUri) {
        continue;
      }

      const key = resourceUri.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      uris.push(resourceUri);
    }

    return uris;
  }

  private extractResourceUri(value: unknown): vscode.Uri | undefined {
    if (value instanceof vscode.Uri) {
      return value;
    }

    if (value && typeof value === "object") {
      const resourceState = value as { resourceUri?: unknown };
      if (resourceState.resourceUri instanceof vscode.Uri) {
        return resourceState.resourceUri;
      }
    }

    return undefined;
  }

  private extractTimelineCommitHash(item: unknown): string | undefined {
    const hashes = this.collectTimelineCommitCandidates(item)
      .map((candidate) => candidate.match(/\b[0-9a-f]{7,40}\b/gi) ?? [])
      .flat()
      .sort((left, right) => right.length - left.length);

    return hashes[0]?.toLowerCase();
  }

  private collectTimelineCommitCandidates(item: unknown): string[] {
    const candidates: string[] = [];
    const pushValue = (value: unknown) => {
      if (typeof value === "string") {
        candidates.push(value);
        return;
      }

      if (value && typeof value === "object") {
        const markdownValue = value as { value?: unknown };
        if (typeof markdownValue.value === "string") {
          candidates.push(markdownValue.value);
        }
      }
    };

    const visitItem = (value: unknown) => {
      if (!value || typeof value !== "object") {
        pushValue(value);
        return;
      }

      const itemLike = value as TimelineItemLike;
      pushValue(itemLike.id);
      pushValue(itemLike.label);
      pushValue(itemLike.description);
      pushValue(itemLike.detail);
      pushValue(itemLike.tooltip);
      pushValue(itemLike.contextValue);

      for (const argument of itemLike.command?.arguments ?? []) {
        pushValue(argument);
      }
    };

    if (Array.isArray(item)) {
      item.forEach(visitItem);
    } else {
      visitItem(item);
    }

    return candidates;
  }
}
