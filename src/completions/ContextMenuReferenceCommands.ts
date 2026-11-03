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
import { getOutputChannelSlug } from "./CompletionHelpers";
import { mapSymbolKindToReferenceKind } from "./CompletionCore";
import { writeOutputSnapshotAttachment } from "../ui/OutputSnapshotService";
import type { OutputCaptureEntry } from "./OutputCaptureCache";
import { confirmExternalFileTrust } from "../ui/ExternalRootsApproval";
import type { UserInteractionPort } from "../ui/UserInteractionPort";
import { NullUserInteractionPort } from "../ui/UserInteractionPort";
import { getVsCodeTrustedWorkspaceRoots } from "../platform/VsCodeWorkspaceRoot";
import { VsCodeSymbolIndex } from "../platform/VsCodeSymbolIndex";
import { evaluateFileAccess } from "../utils/FileAccessPolicy";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { getInclusiveEndLine } from "../utils/InclusiveLineRange";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import { gitRefExists } from "../utils/GitUtils";
import { showWarningMessage } from "../platform/VsCodeMessages";

interface TimelineItemLike {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  detail?: unknown;
  tooltip?: unknown;
  contextValue?: unknown;
  command?: { arguments?: unknown[] };
}

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
/** Timeline "Open Commit" source paths end in `<parent>..<commit>`. */
const COMMIT_RANGE_PATH_PATTERN = /\.\.([0-9a-f]{7,40})$/i;

function asCommitHash(value: unknown): string | undefined {
  return typeof value === "string" && COMMIT_HASH_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

function readJsonQueryField(uri: vscode.Uri, field: string): unknown {
  try {
    const query: unknown = JSON.parse(uri.query);
    return query && typeof query === "object"
      ? (query as Record<string, unknown>)[field]
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The commit a git-backed editor shows, or `undefined` when the editor does
 * not show one commit. Accepts the resource of:
 * - a vscode.git text editor or diff side (`git:` with `{ ref: <hash> }`),
 *   as opened by clicking a Timeline or SCM Graph commit. Symbolic refs
 *   (`HEAD`, `~` for the index, `""` for the working tree) are rejected.
 * - a commit's multi-file diff (`scm-history-item:`): the SCM Graph's form
 *   carries `historyItemId` in a JSON query, the Timeline's "Open Commit"
 *   form ends its path in `<parent>..<commit>`.
 *
 * Keep the `ctrlyoke.addEditorCommitToPromptEditor` `when` clauses in
 * `package.json` in step with these shapes; a test checks them against it.
 */
export function extractCommitHashFromEditorUri(
  uri: vscode.Uri
): string | undefined {
  switch (uri.scheme) {
    case VSCODE_URI_SCHEMES.GIT:
      return asCommitHash(readJsonQueryField(uri, "ref"));
    case VSCODE_URI_SCHEMES.SCM_HISTORY_ITEM:
      return (
        asCommitHash(readJsonQueryField(uri, "historyItemId")) ??
        asCommitHash(COMMIT_RANGE_PATH_PATTERN.exec(uri.path)?.[1])
      );
    default:
      return undefined;
  }
}

export interface ContextMenuPromptEditorInsertSink {
  enqueuePromptEditorInsert(request: PromptEditorInsertRequest): Promise<void>;
}

type WorkspaceRelativeReferencePathResolver = (
  uri: vscode.Uri
) => string | null;

type WorkspaceCommitChecker = (
  workspaceRoot: string,
  commitHash: string
) => Promise<boolean>;

/** Same check the prompt editor's `~<hash>` lint marker uses. */
const workspaceHasCommit: WorkspaceCommitChecker = async (
  workspaceRoot,
  commitHash
) => (await gitRefExists(workspaceRoot, commitHash)).exists;

const FOREIGN_COMMIT_WARNING =
  "ctrlyoke: Commit {shortHash} is not in this workspace's repository, so a ~ reference can't attach it.";

export class ContextMenuReferenceCommands {
  constructor(
    private readonly webviewProvider: ContextMenuPromptEditorInsertSink,
    private readonly getWorkspaceRoot: () => string,
    private readonly workspaceRelativeReferencePathResolver: WorkspaceRelativeReferencePathResolver = toWorkspaceRelativeReferencePath,
    private readonly prepareTrustPrompt: () => Promise<UserInteractionPort> = async () =>
      new NullUserInteractionPort(),
    private readonly workspaceCommitChecker: WorkspaceCommitChecker = workspaceHasCommit
  ) {}

  async addFileToPromptEditor(uri: vscode.Uri): Promise<void> {
    if (!uri) {
      return;
    }

    const referencePath = await this.resolveReferencePath(uri);
    if (!referencePath) {
      void showWarningMessage(
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
      void showWarningMessage(
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
      void showWarningMessage(
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
      editor && !editor.selection.isEmpty
        ? getInclusiveEndLine(
            editor.selection.start.line,
            editor.selection.end.line,
            editor.selection.end.character
          )
        : 1;

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
      void showWarningMessage(
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
        endLine: getInclusiveEndLine(
          editor.selection.start.line,
          editor.selection.end.line,
          editor.selection.end.character
        ),
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
      void showWarningMessage(
        "ctrlyoke: No selected SCM resources are inside the workspace."
      );
      return;
    }

    await this.insertReferences(references);
  }

  /**
   * Handler for `ctrlyoke.addTimelineCommitToPromptEditor`. Its
   * `timeline/item/context` menu entry and `contributes.commands` declaration
   * were removed from `package.json` because VS Code (1.144 at the latest)
   * resolves the right-clicked timeline item only for extensions that enable
   * the proposed `timeline` API. Every other extension receives `undefined`.
   * The command stays registered so the ID keeps working. Restore the manifest
   * entries once the item reaches stable-API extensions again: see
   * `dev/backlog/VSCODE_PROPOSED_API_CONTEXT_MENUS.md`.
   */
  async addTimelineCommitToPromptEditor(item: unknown): Promise<void> {
    await this.insertCommitReference(
      this.extractTimelineCommitHash(item),
      "the selected timeline item"
    );
  }

  /**
   * Handler for `ctrlyoke.addEditorCommitToPromptEditor`, on the editor title
   * bar's "..." menu and the tab context menu of a commit's diff. Both menus
   * pass the editor's resource (a diff editor's modified side, a multi-diff
   * editor's source URI). Without one, the active tab is used.
   */
  async addEditorCommitToPromptEditor(uri?: vscode.Uri): Promise<void> {
    const candidates =
      uri instanceof vscode.Uri ? [uri] : this.activeTabResources();
    await this.insertCommitReference(
      candidates
        .map((candidate) => extractCommitHashFromEditorUri(candidate))
        .find((hash) => hash !== undefined),
      "this editor",
      true
    );
  }

  private async insertCommitReference(
    commitHash: string | undefined,
    source: string,
    checkWorkspaceRepository = false
  ): Promise<void> {
    if (!commitHash) {
      this.showCommitReferenceWarning(
        `ctrlyoke: Could not resolve a commit hash from ${source}.`
      );
      return;
    }

    if (
      checkWorkspaceRepository &&
      !(await this.workspaceCommitChecker(this.getWorkspaceRoot(), commitHash))
    ) {
      this.showCommitReferenceWarning(
        FOREIGN_COMMIT_WARNING.replace("{shortHash}", commitHash.slice(0, 7))
      );
      return;
    }

    await this.insertReferences([buildGitReference(commitHash)]);
  }

  private showCommitReferenceWarning(message: string): void {
    void showWarningMessage(message);
  }

  private activeTabResources(): vscode.Uri[] {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) {
      return [input.modified];
    }
    if (input instanceof vscode.TabInputText) {
      return [input.uri];
    }
    return [];
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
    _uri: vscode.Uri,
    lineNumber: number,
    referencePath: string
  ): Promise<string | undefined> {
    try {
      const symbols = await new VsCodeSymbolIndex().documentSymbols(
        referencePath
      );
      if (!symbols?.length) {
        return undefined;
      }

      const targetLine = lineNumber;
      const symbol = symbols
        .filter(
          (candidate) =>
            targetLine >= candidate.startLine && targetLine <= candidate.endLine
        )
        .sort(
          (left, right) =>
            left.endLine - left.startLine - (right.endLine - right.startLine)
        )[0];
      if (!symbol) {
        return undefined;
      }

      return buildSymbolReference(
        referencePath,
        symbol.name,
        symbol.startLine,
        symbol.endLine,
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
