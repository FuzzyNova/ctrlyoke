import * as vscode from "vscode";
import {
  buildDirectoryReference,
  buildFileReference,
  buildGitReference,
  buildSelectionReference,
  buildSymbolReference,
} from "./ContextReferenceBuilder";
import { toWorkspaceRelativeReferencePath } from "./WorkspaceReferencePaths";
import {
  PROMPT_EDITOR_INSERT_MODES,
  VSCODE_URI_SCHEMES,
} from "../types/DashboardConstants";
import type { PromptEditorInsertRequest } from "../types/WebviewMessageTypes";
import { Log } from "../utils/Log";
import {
  getOutputChannelSlug,
  mapSymbolKindToReferenceKind,
} from "./CompletionHelpers";
import { writeOutputSnapshotAttachment } from "../ui/OutputSnapshotService";
import type { OutputCaptureEntry } from "./OutputCaptureCache";
import { confirmExternalFileTrust } from "../ui/ExternalFileTrustPrompt";
import type { UserInteractionPort } from "../ui/UserInteractionPort";
import { NullUserInteractionPort } from "../ui/UserInteractionPort";
import { getVsCodeTrustedWorkspaceRoots } from "../platform/VsCodeWorkspaceRoot";
import { evaluateFileAccess } from "../utils/FileAccessPolicy";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";

interface TimelineItemLike {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  detail?: unknown;
  tooltip?: unknown;
  contextValue?: unknown;
  command?: { arguments?: unknown[] };
}

export interface ContextMenuPromptEditorInsertSink {
  enqueuePromptEditorInsert(request: PromptEditorInsertRequest): Promise<void>;
}

type WorkspaceRelativeReferencePathResolver = (
  uri: vscode.Uri
) => string | null;

export class ContextMenuReferenceCommands {
  constructor(
    private readonly webviewProvider: ContextMenuPromptEditorInsertSink,
    private readonly getWorkspaceRoot: () => string,
    private readonly workspaceRelativeReferencePathResolver: WorkspaceRelativeReferencePathResolver = toWorkspaceRelativeReferencePath,
    private readonly prepareTrustPrompt: () => Promise<UserInteractionPort> =
      async () => new NullUserInteractionPort()
  ) {}

  async addFileToPromptEditor(uri: vscode.Uri): Promise<void> {
    if (!uri) {
      return;
    }

    const referencePath = await this.resolveReferencePath(uri);
    if (!referencePath) {
      void vscode.window.showWarningMessage(
        "ctrlyoke: Selected file is outside the workspace."
      );
      return;
    }

    await this.insertReferences([buildFileReference(referencePath)]);
  }

  async addDirectoryToPromptEditor(uri: vscode.Uri): Promise<void> {
    if (!uri) {
      return;
    }

    const referencePath = await this.resolveReferencePath(uri);
    if (!referencePath) {
      void vscode.window.showWarningMessage(
        "ctrlyoke: Selected directory is outside the workspace."
      );
      return;
    }

    await this.insertReferences([buildDirectoryReference(referencePath)]);
  }

  async addSelectionToPromptEditor(uri: vscode.Uri): Promise<void> {
    if (!uri) {
      return;
    }

    const referencePath = await this.resolveReferencePath(uri);
    if (!referencePath) {
      void vscode.window.showWarningMessage(
        "ctrlyoke: Selected file is outside the workspace."
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
      buildSelectionReference(referencePath, startLine, endLine),
    ]);
  }

  async addSymbolToPromptEditor(
    uri: vscode.Uri,
    lineNumber?: number
  ): Promise<void> {
    if (!uri) {
      return;
    }

    const referencePath = await this.resolveReferencePath(uri);
    if (!referencePath) {
      void vscode.window.showWarningMessage(
        "ctrlyoke: Selected file is outside the workspace."
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
    const symbolReference = await this.tryBuildSymbolReference(
      uri,
      targetLine,
      referencePath
    );
    if (symbolReference) {
      await this.insertReferences([symbolReference]);
      return;
    }

    await this.insertReferences([
      buildSelectionReference(referencePath, targetLine, targetLine),
    ]);
  }

  /**
   * Resolve a context-menu target to the reference path that may be inserted.
   * Workspace targets keep the existing relative-reference behavior. External
   * targets use an absolute path only when the same effective external-root
   * policy used by file-link flows allows it, or after the shared trust prompt
   * grants access.
   */
  private async resolveReferencePath(
    uri: vscode.Uri
  ): Promise<string | undefined> {
    const relativePath = this.workspaceRelativeReferencePathResolver(uri);
    if (relativePath) {
      return relativePath;
    }

    if (uri.scheme !== VSCODE_URI_SCHEMES.FILE || !uri.fsPath) {
      return undefined;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return undefined;
    }

    const workspaceIdentity =
      ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
    const decision = evaluateFileAccess(uri.fsPath, {
      workspaceRoots: getVsCodeTrustedWorkspaceRoots(),
      approvedExternalRoots:
        ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
          workspaceIdentity
        ),
    });
    if (decision.allowed) {
      return uri.fsPath;
    }

    const port = await this.prepareTrustPrompt();
    return (await confirmExternalFileTrust(uri.fsPath, {
      port,
      workspaceRoot,
    }))
      ? uri.fsPath
      : undefined;
  }

  async addOutputSelectionToPromptEditor(uri?: vscode.Uri): Promise<void> {
    const editor = this.activeOutputEditor(uri);
    if (!editor || editor.selection.isEmpty) {
      return;
    }

    await this.captureOutputToPromptEditor(
      editor,
      editor.document.getText(editor.selection),
      {
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
      }
    );
  }

  async addOutputChannelToPromptEditor(uri?: vscode.Uri): Promise<void> {
    const editor = this.activeOutputEditor(uri);
    if (!editor) {
      return;
    }

    await this.captureOutputToPromptEditor(
      editor,
      editor.document.getText(),
      undefined
    );
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
        "ctrlyoke: No selected SCM resources are inside the workspace."
      );
      return;
    }

    await this.insertReferences(references);
  }

  async addTimelineCommitToPromptEditor(item: unknown): Promise<void> {
    const commitHash = this.extractTimelineCommitHash(item);
    if (!commitHash) {
      void vscode.window.showWarningMessage(
        "ctrlyoke: Could not resolve a commit hash from the selected timeline item."
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

  private activeOutputEditor(uri?: vscode.Uri): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }

    if (uri && editor.document.uri.toString() !== uri.toString()) {
      return undefined;
    }

    return editor;
  }

  private async captureOutputToPromptEditor(
    editor: vscode.TextEditor,
    text: string,
    range: OutputCaptureEntry["range"]
  ): Promise<void> {
    const entry: OutputCaptureEntry = {
      text,
      channel: getOutputChannelSlug(editor.document),
      range,
    };
    // writeOutputSnapshotAttachment already returns a quoted/normalized
    // reference value (same contract as savePendingOutputSnapshot, whose only
    // other caller prepends '@' itself) — do not re-run it through
    // buildFileReference, which would quote an already-quoted path a second
    // time whenever the channel name contains a space.
    const referenceValue = await writeOutputSnapshotAttachment(
      this.getWorkspaceRoot,
      entry
    );
    await this.insertReferences([`@${referenceValue}`]);
  }

  private async tryBuildSymbolReference(
    uri: vscode.Uri,
    lineNumber: number,
    referencePath: string
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

      return buildSymbolReference(
        referencePath,
        symbol.name,
        symbol.range.start.line + 1,
        symbol.range.end.line + 1,
        mapSymbolKindToReferenceKind(symbol.kind)
      );
    } catch (error) {
      Log.warn(
        "[ContextMenuReferenceCommands] ctrlyoke: Failed to resolve symbol for editor context",
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
