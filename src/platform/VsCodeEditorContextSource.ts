import * as vscode from "vscode";
import type {
  EditorContextSource,
  EditorSelection,
  VisibleOutputChannel,
} from "../completions/EditorContextSource";
import {
  getVsCodeNamedWorkspaceRoots,
  getVsCodeWorkspaceRoot,
} from "./VsCodeWorkspaceRoot";
import { toViewerPath } from "./WorkspaceViewerPath";
import { VSCODE_URI_SCHEMES } from "../types/DashboardConstants";
import { outputCaptureCache } from "../completions/OutputCaptureCache";
import * as crypto from "crypto";

function viewerPath(document: vscode.TextDocument): string {
  if (document.uri.scheme === VSCODE_URI_SCHEMES.OUTPUT) {
    return document.uri.path.replace(/^\//, "");
  }
  const primaryRoot = getVsCodeWorkspaceRoot();
  // With no folder open there is nothing to be relative to.
  if (!primaryRoot) return document.uri.fsPath;
  return toViewerPath(document.uri.fsPath, {
    primaryRoot,
    namedRoots: getVsCodeNamedWorkspaceRoots(),
  });
}

export class VsCodeEditorContextSource implements EditorContextSource {
  getSelections(): EditorSelection[] {
    const editors = vscode.window.visibleTextEditors;
    const seen = new Set<string>();
    const selections: EditorSelection[] = [];
    for (const editor of editors) {
      if (editor.selection.isEmpty) continue;
      const file = viewerPath(editor.document);
      const startLine = editor.selection.start.line + 1;
      const endLine = editor.selection.end.line + 1;
      const key = `${file}:${startLine}-${endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = editor.document.getText(editor.selection);
      const isOutput = editor.document.uri.scheme === VSCODE_URI_SCHEMES.OUTPUT;
      const outputChannel = isOutput ? file : undefined;
      const captureId = isOutput ? crypto.randomUUID() : undefined;
      if (captureId)
        outputCaptureCache.set(captureId, {
          text,
          channel: file,
          range: { startLine, endLine },
        });
      selections.push({
        viewerPath: file,
        startLine,
        endLine,
        text,
        isOutput,
        outputChannel,
        captureId,
        visibleEditorCount: editors.length,
      });
    }
    return selections;
  }

  getVisibleOutputChannels(): VisibleOutputChannel[] {
    return vscode.window.visibleTextEditors
      .filter(
        (editor) => editor.document.uri.scheme === VSCODE_URI_SCHEMES.OUTPUT
      )
      .map((editor) => {
        const channel = viewerPath(editor.document);
        const captureId = crypto.randomUUID();
        outputCaptureCache.set(captureId, {
          text: editor.document.getText(),
          channel,
        });
        return {
          viewerPath: channel,
          channel,
          text: editor.document.getText(),
          captureId,
        };
      });
  }
}
