import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fuzzyMatches } from "./FuzzyRanking";
import type { IndexedSymbol, SymbolIndex } from "./SymbolIndex";
import { LspSymbolKind } from "./SymbolIndex";
import { normalizeReferencePath } from "./ContextReferenceBuilder";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hh",
  ".hpp",
  ".py",
]);

interface Declaration {
  name: string;
  kind: LspSymbolKind;
  offset: number;
  line: number;
  usesIndentation: boolean;
}

interface FileCacheEntry {
  mtimeMs: number;
  symbols: IndexedSymbol[];
}

/** Lightweight, dependency-free workspace symbols for headless hosts. */
export class RegexSymbolIndex implements SymbolIndex {
  private readonly fileCache = new Map<string, FileCacheEntry>();
  private readonly realWorkspaceRoots = new Map<string, Promise<string>>();
  private readonly getWorkspaceRoot: () => string | undefined;

  constructor(
    /** A getter returning `undefined` means no folder is open: no symbols. */
    workspaceRoot: string | (() => string | undefined),
    private readonly sourceFiles: () => Promise<string[]>,
    private readonly resolveViewerPath?: (
      viewerPath: string
    ) => { absolutePath: string; workspaceRoot: string } | undefined
  ) {
    this.getWorkspaceRoot =
      typeof workspaceRoot === "function" ? workspaceRoot : () => workspaceRoot;
  }

  getSourceFiles(): Promise<string[]> {
    return this.sourceFiles();
  }

  async workspaceSymbols(
    query: string,
    maxResults: number,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]> {
    const files = await this.getSourceFiles();
    const symbols: IndexedSymbol[] = [];
    for (const relativePath of files) {
      if (signal?.aborted) break;
      if (!SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase()))
        continue;
      symbols.push(...(await this.symbolsForFile(relativePath, signal)));
    }
    const filtered = query
      ? symbols.filter((symbol) =>
          fuzzyMatches(`${symbol.name} ${symbol.viewerPath}`, query)
        )
      : symbols;
    return filtered.slice(0, Math.max(0, maxResults));
  }

  async documentSymbols(
    viewerPath: string,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]> {
    if (signal?.aborted) return [];
    return this.symbolsForFile(viewerPath, signal);
  }

  private async symbolsForFile(
    inputPath: string,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]> {
    const viewerPath = normalizeReferencePath(inputPath).replace(/^\.\//, "");
    if (
      !viewerPath ||
      viewerPath.startsWith("../") ||
      path.isAbsolute(viewerPath)
    )
      return [];
    const resolved = this.resolveViewerPath?.(viewerPath);
    if (this.resolveViewerPath && !resolved) return [];
    const workspaceRoot = resolved?.workspaceRoot ?? this.getWorkspaceRoot();
    if (!workspaceRoot) return [];
    const absolutePath =
      resolved?.absolutePath ?? path.resolve(workspaceRoot, viewerPath);
    const relativeCheck = path.relative(workspaceRoot, absolutePath);
    if (relativeCheck === ".." || relativeCheck.startsWith(`..${path.sep}`))
      return [];

    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) return [];
      const realPath = await fs.realpath(absolutePath);
      let realWorkspaceRoot = this.realWorkspaceRoots.get(workspaceRoot);
      if (!realWorkspaceRoot) {
        realWorkspaceRoot = fs.realpath(workspaceRoot);
        this.realWorkspaceRoots.set(workspaceRoot, realWorkspaceRoot);
      }
      const realRelative = path.relative(await realWorkspaceRoot, realPath);
      if (
        realRelative === ".." ||
        realRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelative)
      )
        return [];
      // A file can have a different workspace-prefixed display path after a
      // folder is renamed, even though its absolute path and mtime are stable.
      const cacheKey = JSON.stringify([absolutePath, viewerPath]);
      const cached = this.fileCache.get(cacheKey);
      if (cached?.mtimeMs === stat.mtimeMs) return cached.symbols;
      const source = await fs.readFile(absolutePath, "utf8");
      if (signal?.aborted) return [];
      const symbols = extractDeclarations(source, viewerPath);
      this.fileCache.set(cacheKey, { mtimeMs: stat.mtimeMs, symbols });
      return symbols;
    } catch {
      this.fileCache.delete(JSON.stringify([absolutePath, viewerPath]));
      return [];
    }
  }
}

function extractDeclarations(
  source: string,
  viewerPath: string
): IndexedSymbol[] {
  const declarations = findDeclarations(
    source,
    path.extname(viewerPath).toLowerCase()
  );
  return declarations.map((declaration) => {
    const endLine = declaration.usesIndentation
      ? findPythonEndLine(source, declaration.line)
      : findBraceEndLine(source, declaration.offset, declaration.line);
    return {
      name: declaration.name,
      kind: declaration.kind,
      viewerPath,
      startLine: declaration.line,
      endLine,
    };
  });
}

function findDeclarations(source: string, extension: string): Declaration[] {
  const python = extension === ".py";
  const lines = source.split(/\r?\n/);
  const declarations: Declaration[] = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const patterns = python
      ? ([
          [
            /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
            LspSymbolKind.Function,
          ],
          [/^\s*class\s+([A-Za-z_]\w*)\b/, LspSymbolKind.Class],
          [/^\s*([A-Z][A-Z0-9_]*)\s*=/, LspSymbolKind.Constant],
          [/^\s*([A-Za-z_]\w*)\s*=/, LspSymbolKind.Variable],
        ] as const)
      : ([
          [
            /^\s*(?:(?:export|default|declare|abstract|async|public|private|protected|static|virtual|override|pub|unsafe|extern|inline|constexpr|consteval|friend)\s+)*(?:class|struct|record)\s+([A-Za-z_$][\w$]*)\b/,
            LspSymbolKind.Class,
          ],
          [
            /^\s*(?:(?:export|default|declare|public|private|protected|pub)\s+)*(?:interface|trait)\s+([A-Za-z_$][\w$]*)\b/,
            LspSymbolKind.Interface,
          ],
          [
            /^\s*(?:(?:export|default|declare|public|private|protected|pub)\s+)*(?:enum)\s+([A-Za-z_$][\w$]*)\b/,
            LspSymbolKind.Enum,
          ],
          [
            /^\s*(?:(?:export|default|declare|async|pub|unsafe|extern)\s+)*(?:function|fn|func)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/,
            LspSymbolKind.Function,
          ],
          [
            /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|virtual|override|inline|extern|pub|unsafe)\s+)*(?:[A-Za-z_$][\w$]*(?:<[^;{}]+>)?(?:\[\])?[\s*&]+)+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws\s+[^;{]+)?\s*\{?\s*$/,
            LspSymbolKind.Method,
          ],
          [
            /^\s*(?:(?:public|private|protected|static|async|virtual|override|pub)\s+)*(constructor)\s*\(/,
            LspSymbolKind.Constructor,
          ],
          [
            /^\s*(?:(?:export|default|declare|public|private|protected|static|async|virtual|override|pub)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^;{]+)?\s*\{?\s*$/,
            LspSymbolKind.Method,
          ],
          [
            /^\s*(?:(?:export|pub)\s+)?(?:const|static|constexpr)\s+([A-Za-z_$][\w$]*)\b/,
            LspSymbolKind.Constant,
          ],
          [
            /^\s*(?:(?:export|declare)\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)\b/,
            LspSymbolKind.Variable,
          ],
          [
            /^\s*(?:type)\s+([A-Za-z_$][\w$]*)\s+(?:=|struct\b|interface\b)/,
            LspSymbolKind.TypeParameter,
          ],
          [
            /^\s*(?:mod|namespace)\s+([A-Za-z_$][\w$]*)\b/,
            LspSymbolKind.Namespace,
          ],
        ] as const);
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("#")) {
      for (const [pattern, kind] of patterns) {
        const match = pattern.exec(line);
        if (match?.[1]) {
          declarations.push({
            name: match[1],
            kind,
            offset,
            line: index + 1,
            usesIndentation: python,
          });
          break;
        }
      }
    }
    offset += line.length + 1;
  });
  return declarations;
}

function findPythonEndLine(source: string, startLine: number): number {
  const lines = source.split(/\r?\n/);
  const declaration = lines[startLine - 1] ?? "";
  const baseIndent = indentation(declaration);
  let lastLine = startLine;
  for (let index = startLine; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (indentation(line) <= baseIndent) break;
    lastLine = index + 1;
  }
  return lastLine;
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
}

function findBraceEndLine(
  source: string,
  offset: number,
  startLine: number
): number {
  const opening = source.indexOf("{", offset);
  const semicolon = source.indexOf(";", offset);
  const nextLine = source.indexOf("\n", offset);
  if (
    opening < 0 ||
    (semicolon >= 0 && semicolon < opening) ||
    (nextLine >= 0 && nextLine < opening && opening - nextLine > 300)
  )
    return startLine;
  const closing = matchingBrace(source, opening);
  if (closing < 0) return startLine;
  return startLine + (source.slice(offset, closing).match(/\n/g)?.length ?? 0);
}

function matchingBrace(source: string, opening: number): number {
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = opening; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index++;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}
