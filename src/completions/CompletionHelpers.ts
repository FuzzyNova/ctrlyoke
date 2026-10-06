import * as vscode from "vscode";
import { configService } from "../config/CtrlYokeConfigService";
import { Log } from "../utils/Log";
import { getGitTrackedFiles } from "../utils/GitUtils";
import { walkSearchFiles } from "../utils/WorkspaceSearchFileWalker";
import { isMultiRootWorkspace } from "../platform/VsCodeWorkspaceRoot";
import { VsCodeSymbolIndex } from "../platform/VsCodeSymbolIndex";
import { VsCodeEditorContextSource } from "../platform/VsCodeEditorContextSource";
import { clearSlashTokenCompletionCache } from "./SlashTokenCompletionHelpers";
import { CompletionCore, type PlainCompletionItem } from "./CompletionCore";
import {
  CAPTURING_OUTPUT_PLACEHOLDER,
  COMPLETION_ITEM_KINDS,
  PROMPT_FILE_LANGUAGE_IDS,
  VSCODE_COMMANDS,
} from "../types/DashboardConstants";

let completionCore: CompletionCore | undefined;

/** VS Code composition root for the host-neutral completion engine. */
export function getCompletionCore(): CompletionCore {
  if (!completionCore) {
    completionCore = new CompletionCore({
      isMultiRoot: isMultiRootWorkspace,
      getFiles: async () => {
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
              await walkSearchFiles(
                folder.uri.fsPath,
                Date.now(),
                100_000,
                10_000
              )
            ).files;
          }
          for (const file of paths) {
            results.push(folders.length > 1 ? `${folder.name}/${file}` : file);
          }
        }
        return results;
      },
      symbols: new VsCodeSymbolIndex(),
      editorContext: new VsCodeEditorContextSource(),
    });
  }
  return completionCore;
}

/** Clear the shared completion engine's workspace-file cache. */
export function clearFilesCache(): void {
  completionCore?.clearCache();
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
  const vscodeItem = new vscode.CompletionItem(
    item.label,
    toVSCodeCompletionItemKind(item.kind)
  );
  const insertText = item.captureId
    ? CAPTURING_OUTPUT_PLACEHOLDER
    : item.insertText;
  vscodeItem.insertText =
    document?.languageId === PROMPT_FILE_LANGUAGE_IDS.JSON ||
    document?.languageId === PROMPT_FILE_LANGUAGE_IDS.JSONC
      ? insertText.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      : insertText;
  vscodeItem.detail = item.detail;

  if (item.captureId) {
    vscodeItem.command = {
      command: VSCODE_COMMANDS.RESOLVE_OUTPUT_CAPTURE,
      title: "Resolve output capture",
      arguments: [item.captureId],
    };
  }
  if (item.documentation) {
    vscodeItem.documentation = new vscode.MarkdownString(item.documentation);
  }
  if (item.sortText) vscodeItem.sortText = item.sortText;
  if (item.filterText) vscodeItem.filterText = item.filterText;
  if (range) vscodeItem.range = range;
  return vscodeItem;
}
