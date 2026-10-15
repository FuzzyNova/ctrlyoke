import * as vscode from "vscode";
import * as path from "node:path";
import { Log } from "../utils/Log";
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
  private warmup?: Promise<void>;
  constructor(
    private readonly getFiles: () => Promise<string[]> = async () => []
  ) {}

  async workspaceSymbols(
    query: string,
    _maxResults: number
  ): Promise<IndexedSymbol[]> {
    const root = getVsCodeWorkspaceRoot();
    if (!root) return [];
    await this.warmupLanguageFamilies();
    const namedRoots = getVsCodeNamedWorkspaceRoots();
    const symbols = await vscode.commands.executeCommand<
      vscode.SymbolInformation[]
    >("vscode.executeWorkspaceSymbolProvider", query);
    return (symbols ?? []).map((symbol) =>
      indexedSymbol(symbol, root, namedRoots)
    );
  }

  invalidateWarmupCache(): void {
    this.warmup = undefined;
  }

  private warmupLanguageFamilies(): Promise<void> {
    if (!this.warmup) {
      const pending = this.warmLanguageFamilies();
      const tracked = pending.catch((error: unknown) => {
        if (this.warmup === tracked) this.warmup = undefined;
        throw error;
      });
      this.warmup = tracked;
    }
    return this.warmup;
  }

  private async warmLanguageFamilies(): Promise<void> {
    const documents = vscode.workspace.textDocuments;
    const families = LANGUAGE_FAMILIES.filter(
      (family) =>
        !documents.some((document) =>
          family.languageIds.includes(document.languageId)
        )
    );
    const primaryRoot = getVsCodeWorkspaceRoot();
    if (families.length === 0 || !primaryRoot) return;

    let files: string[];
    try {
      files = await this.getFiles();
    } catch (error) {
      Log.warn(
        "[Completions] Could not discover files for language-server warm-up; continuing with workspace symbols:",
        error
      );
      return;
    }
    const roots = getVsCodeNamedWorkspaceRoots();
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

      const anchors = files.filter((viewerPath) => {
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
      for (const anchor of anchors) {
        try {
          await vscode.workspace.openTextDocument(
            vscode.Uri.file(
              fromViewerPath(anchor, { primaryRoot, namedRoots: roots })
            )
          );
          break;
        } catch (error) {
          Log.warn(
            `[Completions] Could not open language-server warm-up file ${anchor}; trying another candidate:`,
            error
          );
        }
      }
    }
  }

  async documentSymbols(viewerPath: string): Promise<IndexedSymbol[]> {
    const root = getVsCodeWorkspaceRoot();
    // An absolute path (an external file) needs no workspace to resolve.
    if (!root && !path.isAbsolute(viewerPath)) return [];
    const uri = vscode.Uri.file(
      root
        ? fromViewerPath(viewerPath, {
            primaryRoot: root,
            namedRoots: getVsCodeNamedWorkspaceRoots(),
          })
        : viewerPath
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
