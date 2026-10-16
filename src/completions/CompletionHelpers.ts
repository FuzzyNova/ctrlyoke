import * as vscode from "vscode";
import * as path from "node:path";
import { configService } from "../config/CtrlYokeConfigService";
import { getSourceFiles } from "../utils/CompletionFileDiscovery";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import {
  getVsCodeNamedWorkspaceRoots,
  getVsCodeWorkspaceRoot,
  isMultiRootWorkspace,
} from "../platform/VsCodeWorkspaceRoot";
import { VsCodeSymbolIndex } from "../platform/VsCodeSymbolIndex";
import { RegexSymbolIndex } from "./RegexSymbolIndex";
import {
  WorkspaceFileIndex,
  type WorkspaceFileChange,
} from "./WorkspaceFileIndex";
import { FallbackSymbolIndex } from "./FallbackSymbolIndex";
import { VsCodeEditorContextSource } from "../platform/VsCodeEditorContextSource";
import {
  fromViewerPath,
  rootForViewerPath,
} from "../platform/WorkspaceViewerPath";
import { clearSlashTokenCompletionCache } from "./SlashTokenCompletionHelpers";
import type { InsertTextEscape } from "./WorkflowInsertEscape";
import { CompletionCore, type PlainCompletionItem } from "./CompletionCore";
import {
  CAPTURING_OUTPUT_PLACEHOLDER,
  COMPLETION_ITEM_KINDS,
  WORKSPACE_FILE_CHANGE_KINDS,
  VSCODE_COMMANDS,
} from "../types/DashboardConstants";
import type { UserFeedbackSink } from "../core/UserFeedbackSink";
import { VsCodeUserFeedbackSink } from "../platform/VsCodeUserFeedbackSink";

let completionCore: CompletionCore | undefined;
let vsCodeSymbolIndex: VsCodeSymbolIndex | undefined;
let workspaceFileIndex: WorkspaceFileIndex | undefined;
const feedbackSink: UserFeedbackSink = new VsCodeUserFeedbackSink();
let buildTimer: ReturnType<typeof setTimeout> | undefined;

function roots(): Array<{ path: string; name: string }> {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    path: folder.uri.fsPath,
    name: folder.name,
  }));
}

function getWorkspaceFileIndex(): WorkspaceFileIndex {
  if (!workspaceFileIndex) {
    workspaceFileIndex = new WorkspaceFileIndex(
      roots(),
      ConfigurationUtils.shouldRespectGitignoreForCompletions(),
      undefined,
      { userFeedbackSink: feedbackSink }
    );
  }
  return workspaceFileIndex;
}

/** VS Code composition root for the host-neutral completion engine. */
export function getCompletionCore(): CompletionCore {
  if (!completionCore) {
    const sourceFiles = async (): Promise<string[]> => {
      const results: string[] = [];
      const folders = vscode.workspace.workspaceFolders ?? [];
      for (const folder of folders) {
        const files = await getSourceFiles(folder.uri.fsPath);
        results.push(
          ...files.map((file) =>
            folders.length > 1 ? `${folder.name}/${file}` : file
          )
        );
      }
      return results;
    };
    vsCodeSymbolIndex = new VsCodeSymbolIndex(sourceFiles);
    completionCore = new CompletionCore({
      isMultiRoot: isMultiRootWorkspace,
      files: getWorkspaceFileIndex(),
      symbols: new FallbackSymbolIndex(
        vsCodeSymbolIndex,
        new RegexSymbolIndex(
          getVsCodeWorkspaceRoot,
          sourceFiles,
          (viewerPath) => {
            const primaryRoot = getVsCodeWorkspaceRoot();
            if (!primaryRoot) return undefined;
            const namedRoots = getVsCodeNamedWorkspaceRoots();
            const namedRoot = rootForViewerPath(viewerPath, namedRoots);
            const workspaceRoot = namedRoot?.fsPath ?? primaryRoot;
            const absolutePath = fromViewerPath(viewerPath, {
              primaryRoot,
              namedRoots,
            });
            const relative = path.relative(workspaceRoot, absolutePath);
            return relative === ".." || relative.startsWith(`..${path.sep}`)
              ? undefined
              : { absolutePath, workspaceRoot };
          }
        )
      ),
      editorContext: new VsCodeEditorContextSource(),
    });
  }
  return completionCore;
}

/** Rebuild the shared workspace file index for the current roots and setting. */
export function clearFilesCache(): void {
  void workspaceFileIndex?.build({
    roots: roots(),
    respectGitignore: ConfigurationUtils.shouldRespectGitignoreForCompletions(),
  });
  vsCodeSymbolIndex?.invalidateWarmupCache();
}

/** Subscribe VS Code cache invalidation to shared configuration changes. */
export function initializeCompletionHelpers(
  context: vscode.ExtensionContext
): void {
  const currentRespectGitignore = (): boolean =>
    ConfigurationUtils.shouldRespectGitignoreForCompletions();
  let respectGitignore = currentRespectGitignore();
  const index = getWorkspaceFileIndex();
  const startBuild = (): void => {
    void index.build({ roots: roots(), respectGitignore });
  };
  buildTimer = setTimeout(() => {
    buildTimer = undefined;
    startBuild();
  }, 2000);
  context.subscriptions.push({
    dispose: () => {
      if (buildTimer) clearTimeout(buildTimer);
      buildTimer = undefined;
    },
  });
  context.subscriptions.push({ dispose: () => index.dispose() });
  const unsubscribe = configService.subscribe(() => {
    const nextRespectGitignore = currentRespectGitignore();
    if (nextRespectGitignore !== respectGitignore) {
      respectGitignore = nextRespectGitignore;
      startBuild();
    }
    clearSlashTokenCompletionCache();
  });
  context.subscriptions.push({ dispose: unsubscribe });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      startBuild();
      vsCodeSymbolIndex?.invalidateWarmupCache();
    })
  );
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const change =
    (kind: WorkspaceFileChange["kind"]) =>
    (uri: vscode.Uri): void => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const root = folders.find((folder) => {
        const relative = path.relative(folder.uri.fsPath, uri.fsPath);
        return (
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      });
      if (!root) return;
      const relative = path
        .relative(root.uri.fsPath, uri.fsPath)
        .split(path.sep)
        .join("/");
      void index.applyChanges([
        { root: root.uri.fsPath, path: relative, kind },
      ]);
    };
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(change(WORKSPACE_FILE_CHANGE_KINDS.CREATE)),
    watcher.onDidChange(change(WORKSPACE_FILE_CHANGE_KINDS.CHANGE)),
    watcher.onDidDelete(change(WORKSPACE_FILE_CHANGE_KINDS.DELETE))
  );
}

/** Stable workspace-relative slug for an output document. */
export function getOutputChannelSlug(document: vscode.TextDocument): string {
  return vscode.workspace.asRelativePath(document.uri, isMultiRootWorkspace());
}

function toVSCodeCompletionItemKind(kind: number): vscode.CompletionItemKind {
  switch (kind) {
    case COMPLETION_ITEM_KINDS.REFERENCE:
      return vscode.CompletionItemKind.Reference;
    case COMPLETION_ITEM_KINDS.KEYWORD:
      return vscode.CompletionItemKind.Keyword;
    case COMPLETION_ITEM_KINDS.MODULE:
      return vscode.CompletionItemKind.Module;
    default:
      return kind as vscode.CompletionItemKind;
  }
}

/** Convert a core completion to the native VS Code completion contract. */
export function toVSCodeCompletionItem(
  item: PlainCompletionItem,
  _triggerChar: "@" | "#" | "~" | "$" | "/" | "!",
  range?: vscode.Range,
  escape?: InsertTextEscape
): vscode.CompletionItem {
  const insertText = item.captureId
    ? CAPTURING_OUTPUT_PLACEHOLDER
    : item.insertText ?? item.label;
  const vscodeItem = toVSCodeWorkflowCompletionItem(
    {
      ...item,
      insertText: escape ? escape(insertText) : insertText,
    },
    range
  );
  if (item.captureId) {
    vscodeItem.command = {
      command: VSCODE_COMMANDS.RESOLVE_OUTPUT_CAPTURE,
      title: "Resolve output capture",
      arguments: [item.captureId],
    };
  }
  return vscodeItem;
}

/**
 * Convert a workflow-file key or value completion. Unlike prompt-token items
 * these arrive already escaped for their document (the core quotes JSON keys
 * and values itself), so the insert text is used as given.
 */
export function toVSCodeWorkflowCompletionItem(
  item: PlainCompletionItem,
  range?: vscode.Range
): vscode.CompletionItem {
  const vscodeItem = new vscode.CompletionItem(
    item.label,
    toVSCodeCompletionItemKind(item.kind)
  );
  vscodeItem.insertText = item.insertText;
  // Multi-line inserts arrive already indented to the key's column, so VS
  // Code must not add the line's leading whitespace to them again.
  vscodeItem.keepWhitespace = true;
  vscodeItem.detail = item.detail;
  if (item.documentation) {
    vscodeItem.documentation = new vscode.MarkdownString(item.documentation);
  }
  if (item.sortText) vscodeItem.sortText = item.sortText;
  if (item.filterText) vscodeItem.filterText = item.filterText;
  if (range) vscodeItem.range = range;
  return vscodeItem;
}
