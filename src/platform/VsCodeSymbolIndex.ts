import * as vscode from "vscode";
import * as path from "node:path";
import type { IndexedSymbol, SymbolIndex } from "../completions/SymbolIndex";
import { LspSymbolKind } from "../completions/SymbolIndex";
import {
  getVsCodeNamedWorkspaceRoots,
  getVsCodeWorkspaceRoot,
} from "./VsCodeWorkspaceRoot";
import { fromViewerPath, toViewerPath } from "./WorkspaceViewerPath";

interface LanguageFamily {
  extensions: readonly string[];
  configMarkers: readonly string[];
  languageIds: readonly string[];
}

const LANGUAGE_FAMILIES: readonly LanguageFamily[] = [
  {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    configMarkers: ["tsconfig.json", "jsconfig.json"],
    languageIds: [
      "typescript",
      "typescriptreact",
      "javascript",
      "javascriptreact",
    ],
  },
];

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
  constructor(
    private readonly getFiles: () => Promise<string[]> = async () => []
  ) {}

  async workspaceSymbols(
    query: string,
    _maxResults: number
  ): Promise<IndexedSymbol[]> {
    await this.warmLanguageFamilies();
    const root = getVsCodeWorkspaceRoot();
    const namedRoots = getVsCodeNamedWorkspaceRoots();
    const symbols = await vscode.commands.executeCommand<
      vscode.SymbolInformation[]
    >("vscode.executeWorkspaceSymbolProvider", query);
    return (symbols ?? []).map((symbol) =>
      indexedSymbol(symbol, root, namedRoots)
    );
  }

  private async warmLanguageFamilies(): Promise<void> {
    const documents = vscode.workspace.textDocuments;
    const families = LANGUAGE_FAMILIES.filter(
      (family) =>
        !documents.some((document) =>
          family.languageIds.includes(document.languageId)
        )
    );
    if (families.length === 0) return;

    const files = await this.getFiles();
    const roots = getVsCodeNamedWorkspaceRoots();
    const primaryRoot = getVsCodeWorkspaceRoot();
    for (const family of families) {
      const configDirectories = files
        .filter((viewerPath) =>
          family.configMarkers.includes(path.basename(viewerPath))
        )
        .map((viewerPath) =>
          path.dirname(
            fromViewerPath(viewerPath, { primaryRoot, namedRoots: roots })
          )
        );
      if (configDirectories.length === 0) continue;

      const anchor = files.find((viewerPath) => {
        const absolutePath = fromViewerPath(viewerPath, {
          primaryRoot,
          namedRoots: roots,
        });
        if (
          !family.extensions.includes(path.extname(absolutePath).toLowerCase())
        )
          return false;
        return configDirectories.some((directory) => {
          const relative = path.relative(directory, absolutePath);
          return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) && relative !== "..")
          );
        });
      });
      if (anchor) {
        await vscode.workspace.openTextDocument(
          vscode.Uri.file(
            fromViewerPath(anchor, { primaryRoot, namedRoots: roots })
          )
        );
      }
    }
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
