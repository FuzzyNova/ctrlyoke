import * as vscode from "vscode";
import type { IndexedSymbol, SymbolIndex } from "../completions/SymbolIndex";
import { LspSymbolKind } from "../completions/SymbolIndex";
import {
  getVsCodeNamedWorkspaceRoots,
  getVsCodeWorkspaceRoot,
} from "./VsCodeWorkspaceRoot";
import { fromViewerPath, toViewerPath } from "./WorkspaceViewerPath";

function indexedSymbol(
  symbol: vscode.SymbolInformation,
  root: string,
  namedRoots: ReturnType<typeof getVsCodeNamedWorkspaceRoots>
): IndexedSymbol {
  return {
    name: symbol.name,
    kind: (symbol.kind + 1) as LspSymbolKind,
    viewerPath: toViewerPath(symbol.location.uri.fsPath, {
      primaryRoot: root,
      namedRoots,
    }),
    startLine: symbol.location.range.start.line + 1,
    endLine: symbol.location.range.end.line + 1,
    containerName: symbol.containerName,
  };
}

export class VsCodeSymbolIndex implements SymbolIndex {
  async workspaceSymbols(
    query: string,
    _maxResults: number
  ): Promise<IndexedSymbol[]> {
    const root = getVsCodeWorkspaceRoot();
    const namedRoots = getVsCodeNamedWorkspaceRoots();
    const symbols = await vscode.commands.executeCommand<
      vscode.SymbolInformation[]
    >("vscode.executeWorkspaceSymbolProvider", query);
    return (symbols ?? []).map((symbol) =>
      indexedSymbol(symbol, root, namedRoots)
    );
  }

  async documentSymbols(viewerPath: string): Promise<IndexedSymbol[]> {
    const root = getVsCodeWorkspaceRoot();
    const roots = getVsCodeNamedWorkspaceRoots();
    const uri = vscode.Uri.file(
      fromViewerPath(viewerPath, { primaryRoot: root, namedRoots: roots })
    );
    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[]
    >("vscode.executeDocumentSymbolProvider", uri);
    const indexed: IndexedSymbol[] = [];
    const visit = (
      items: vscode.DocumentSymbol[],
      containerName?: string
    ): void => {
      for (const symbol of items) {
        indexed.push({
          name: symbol.name,
          kind: (symbol.kind + 1) as LspSymbolKind,
          viewerPath,
          startLine: symbol.range.start.line + 1,
          endLine: symbol.range.end.line + 1,
          containerName,
        });
        visit(symbol.children, symbol.name);
      }
    };
    visit(symbols ?? []);
    return indexed;
  }
}
