import * as vscode from "vscode";
import * as path from "node:path";
import { configService } from "../config/CtrlYokeConfigService";
import { Log } from "../utils/Log";
import { getGitTrackedFiles } from "../utils/GitUtils";
import {
  isSearchPathIgnored,
  walkSearchFiles,
} from "../utils/WorkspaceSearchFileWalker";
import {
  getVsCodeNamedWorkspaceRoots,
  getVsCodeWorkspaceRoot,
  isMultiRootWorkspace,
} from "../platform/VsCodeWorkspaceRoot";
import { VsCodeSymbolIndex } from "../platform/VsCodeSymbolIndex";
import { RegexSymbolIndex } from "./RegexSymbolIndex";
import { FallbackSymbolIndex } from "./FallbackSymbolIndex";
import { VsCodeEditorContextSource } from "../platform/VsCodeEditorContextSource";
import {
  fromViewerPath,
  rootForViewerPath,
} from "../platform/WorkspaceViewerPath";
import { clearSlashTokenCompletionCache } from "./SlashTokenCompletionHelpers";
import { escapeJsonStringFragment } from "../utils/JsonStringEscape";
import { CompletionCore, type PlainCompletionItem } from "./CompletionCore";
import {
  CAPTURING_OUTPUT_PLACEHOLDER,
  COMPLETION_ITEM_KINDS,
  PROMPT_FILE_LANGUAGE_IDS,
  VSCODE_COMMANDS,
} from "../types/DashboardConstants";

let completionCore: CompletionCore | undefined;
let vsCodeSymbolIndex: VsCodeSymbolIndex | undefined;
let cachedCompletionFiles: string[] | undefined;
let completionFilesAt = 0;

async function getCompletionFiles(): Promise<string[]> {
  if (cachedCompletionFiles && Date.now() - completionFilesAt < 5000)
    return cachedCompletionFiles;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const results: string[] = [];
  for (const folder of folders) {
    let paths: string[];
    try {
      paths = await getGitTrackedFiles(folder.uri.fsPath);
    } catch (error) {
      Log.warn(
        `[Completions] git ls-files failed for ${folder.name}, falling back to workspace walk:`,
        error
      );
      paths = (
        await walkSearchFiles(folder.uri.fsPath, Date.now(), 100_000, 10_000)
      ).files;
    }
    for (const file of paths) {
      results.push(folders.length > 1 ? `${folder.name}/${file}` : file);
    }
  }
  cachedCompletionFiles = results;
  completionFilesAt = Date.now();
  return results;
}

/** VS Code composition root for the host-neutral completion engine. */
export function getCompletionCore(): CompletionCore {
  if (!completionCore) {
    const root = getVsCodeWorkspaceRoot();
    const roots = getVsCodeNamedWorkspaceRoots();
    vsCodeSymbolIndex = new VsCodeSymbolIndex(getCompletionFiles);
    completionCore = new CompletionCore({
      isMultiRoot: isMultiRootWorkspace,
      getFiles: getCompletionFiles,
      symbols: new FallbackSymbolIndex(
        vsCodeSymbolIndex,
        new RegexSymbolIndex(root, getCompletionFiles, (viewerPath) => {
          const namedRoot = rootForViewerPath(viewerPath, roots);
          const workspaceRoot = namedRoot?.fsPath ?? root;
          const absolutePath = fromViewerPath(viewerPath, {
            primaryRoot: root,
            namedRoots: roots,
          });
          const relative = path.relative(workspaceRoot, absolutePath);
          return relative === ".." || relative.startsWith(`..${path.sep}`)
            ? undefined
            : { absolutePath, workspaceRoot };
        })
      ),
      editorContext: new VsCodeEditorContextSource(),
    });
  }
  return completionCore;
}

/** Clear the shared completion engine's workspace-file cache. */
export function clearFilesCache(): void {
  cachedCompletionFiles = undefined;
  completionFilesAt = 0;
  completionCore?.clearCache();
  vsCodeSymbolIndex?.invalidateWarmupCache();
}

/** Subscribe VS Code cache invalidation to shared configuration changes. */
export function initializeCompletionHelpers(
  context: vscode.ExtensionContext
): void {
  const unsubscribe = configService.subscribe(() => {
    clearFilesCache();
    clearSlashTokenCompletionCache();
    Log.debug("[Completions] Cache cleared due to config change");
  });
  context.subscriptions.push({ dispose: unsubscribe });
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const invalidate = (uri: vscode.Uri): void => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const relevant = folders.some((folder) => {
      const relative = path.relative(folder.uri.fsPath, uri.fsPath);
      return (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        !isSearchPathIgnored(relative)
      );
    });
    if (relevant) clearFilesCache();
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(invalidate),
    watcher.onDidChange(invalidate),
    watcher.onDidDelete(invalidate)
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
  document?: vscode.TextDocument
): vscode.CompletionItem {
  const insertText = item.captureId
    ? CAPTURING_OUTPUT_PLACEHOLDER
    : item.insertText;
  const vscodeItem = toVSCodeWorkflowCompletionItem(
    {
      ...item,
      insertText:
        document?.languageId === PROMPT_FILE_LANGUAGE_IDS.JSON ||
        document?.languageId === PROMPT_FILE_LANGUAGE_IDS.JSONC
          ? escapeJsonStringFragment(insertText)
          : insertText,
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
  vscodeItem.detail = item.detail;
  if (item.documentation) {
    vscodeItem.documentation = new vscode.MarkdownString(item.documentation);
  }
  if (item.sortText) vscodeItem.sortText = item.sortText;
  if (item.filterText) vscodeItem.filterText = item.filterText;
  if (range) vscodeItem.range = range;
  return vscodeItem;
}
