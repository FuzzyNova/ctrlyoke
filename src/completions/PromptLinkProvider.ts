import * as vscode from "vscode";
import * as path from "path";
import { getVsCodeWorkspaceRoot } from "../platform/VsCodeWorkspaceRoot";

/**
 * Provides clickable links for ctrlyoke context references
 *
 * Supported patterns:
 * - @path/to/file.ts       → Open file
 * - @path/to/dir/          → Reveal directory
 * - #selection:path:10-20  → Open file with line selection
 * - #sym:path:symbol:42-58 → Open file at symbol range
 *
 * Enables Ctrl+Click (Cmd+Click on Mac) navigation from prompts back to source code.
 * Complements PromptCompletionProvider for bidirectional context flow.
 */
export class PromptLinkProvider implements vscode.DocumentLinkProvider {
  // Regex patterns for detecting context references.
  // Each pattern has a quoted variant (for paths with spaces) and an unquoted variant.
  // Note: Patterns are recreated for each call to ensure proper state reset.
  private readonly patterns = {
    // @"path with spaces/file.ext" (quoted path, full file)
    fullFileQuoted: /@"([^"]+\.[a-zA-Z0-9]+)"/g,

    // @file.ext (unquoted, no trailing slash, has extension)
    // Matches: @src/extension.ts, @docs/plan.md
    fullFile: /@([^\s@#"]+\.[a-zA-Z0-9]+)/g,

    // @"path with spaces/dir/" (quoted path, directory with trailing slash)
    directoryQuoted: /@"([^"]+\/)"/g,

    // @dir/ (unquoted, trailing slash)
    // Matches: @src/ui/, @docs/
    directory: /@([^\s@#"]+\/)/g,

    // #selection:"path with spaces/file":10-20 (quoted path, line range)
    lineRangeQuoted: /#selection:"([^"]+)":(\d+)-(\d+)/g,

    // #selection:path:10-20 (unquoted, line range)
    // Matches: #selection:src/extension.ts:10-20
    lineRange: /#selection:([^\s:]+):(\d+)-(\d+)/g,

    // #sym:"path with spaces/file":symbol:42-58 (quoted path, symbol reference)
    symbolQuoted: /#sym:"([^"]+)":([^:]+):(\d+)-(\d+)/g,

    // #sym:path:symbol:42-58 (unquoted, symbol reference)
    // Matches: #sym:src/extension.ts:activate:14-36
    symbol: /#sym:([^\s:]+):([^:]+):(\d+)-(\d+)/g,
  };

  /**
   * Provide document links for prompt files
   */
  provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.DocumentLink[] | undefined {
    // Only provide links for prompt files
    if (!this.isPromptFile(document)) {
      return undefined;
    }

    const links: vscode.DocumentLink[] = [];
    const text = document.getText();
    const workspaceRoot = this.getWorkspaceRoot();

    if (!workspaceRoot) {
      return undefined; // No workspace, can't resolve relative paths
    }

    // 1. Detect full file references (@file.ext and @"path with spaces/file.ext")
    links.push(...this.findFileLinks(document, text, workspaceRoot));

    // 2. Detect directory references (@dir/ and @"path with spaces/dir/")
    links.push(...this.findDirectoryLinks(document, text, workspaceRoot));

    // 3. Detect line range references (#selection:path:10-20 and #selection:"path with spaces/file":10-20)
    links.push(...this.findLineRangeLinks(document, text, workspaceRoot));

    // 4. Detect symbol references with encoded line ranges
    links.push(...this.findSymbolLinks(document, text, workspaceRoot));

    // 5. Detect git change references (~diff, ~staged, ~stash:N, ~<hash>)
    links.push(...this.findGitChangeLinks(document, text));

    return links;
  }

  /**
   * Check if document is a prompt file
   */
  private isPromptFile(document: vscode.TextDocument): boolean {
    const fileName = path.basename(document.fileName);
    return (
      fileName.endsWith(".ctrlyoke.json") ||
      fileName.endsWith(".ctrlyoke.yaml") ||
      fileName.endsWith(".ctrlyoke.yml") ||
      fileName.endsWith(".prompt.md") ||
      document.languageId === "prompt" ||
      document.languageId === "markdown" ||
      document.languageId === "yaml" ||
      document.languageId === "yml"
    );
  }

  /**
   * Get workspace root folder path
   */
  private getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? getVsCodeWorkspaceRoot() : undefined;
  }

  /**
   * Find full file reference links (@path/to/file.ts and @"path with spaces/file.ts")
   */
  private findFileLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    // Helper to add a file link from a regex match
    const addFileLink = (match: RegExpExecArray): void => {
      const relativePath = match[1];
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      const absolutePath = path.join(workspaceRoot, relativePath);
      const fileUri = vscode.Uri.file(absolutePath);

      const link = new vscode.DocumentLink(range, fileUri);
      link.tooltip = `Open ${relativePath}`;
      links.push(link);
    };

    // Match quoted paths first (@"path with spaces/file.ext")
    const quotedPattern = new RegExp(this.patterns.fullFileQuoted.source, "g");
    let match: RegExpExecArray | null;
    while ((match = quotedPattern.exec(text)) !== null) {
      addFileLink(match);
    }

    // Match plain unquoted paths (@file.ext)
    const plainPattern = new RegExp(this.patterns.fullFile.source, "g");
    while ((match = plainPattern.exec(text)) !== null) {
      addFileLink(match);
    }

    return links;
  }

  /**
   * Find directory reference links (@path/to/dir/ and @"path with spaces/dir/")
   */
  private findDirectoryLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    // Helper to add a directory link from a regex match
    const addDirLink = (match: RegExpExecArray): void => {
      const relativePath = match[1];
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      const absolutePath = path.join(workspaceRoot, relativePath);
      const dirUri = vscode.Uri.file(absolutePath);

      const commandUri = vscode.Uri.parse(
        `command:revealInExplorer?${encodeURIComponent(JSON.stringify(dirUri.toString()))}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Reveal ${relativePath} in File Explorer`;
      links.push(link);
    };

    // Match quoted directory paths first (@"path with spaces/dir/")
    const quotedPattern = new RegExp(this.patterns.directoryQuoted.source, "g");
    let match: RegExpExecArray | null;
    while ((match = quotedPattern.exec(text)) !== null) {
      addDirLink(match);
    }

    // Match plain unquoted directory paths (@dir/)
    const plainPattern = new RegExp(this.patterns.directory.source, "g");
    while ((match = plainPattern.exec(text)) !== null) {
      addDirLink(match);
    }

    return links;
  }

  /**
   * Find line range reference links (#selection:path:10-20 and #selection:"path with spaces":10-20)
   */
  private findLineRangeLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    // Helper to add a line range link from a regex match
    const addLineRangeLink = (match: RegExpExecArray): void => {
      const relativePath = match[1];
      const startLine = parseInt(match[2], 10);
      const endLine = parseInt(match[3], 10);

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      const absolutePath = path.join(workspaceRoot, relativePath);
      const fileUri = vscode.Uri.file(absolutePath);

      const commandUri = vscode.Uri.parse(
        `command:ctrlyoke.openFileWithSelection?${encodeURIComponent(
          JSON.stringify({ uri: fileUri.toString(), startLine, endLine })
        )}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Open ${relativePath} at lines ${startLine}-${endLine}`;
      links.push(link);
    };

    // Match quoted paths first (#selection:"path with spaces/file":10-20)
    const quotedPattern = new RegExp(this.patterns.lineRangeQuoted.source, "g");
    let match: RegExpExecArray | null;
    while ((match = quotedPattern.exec(text)) !== null) {
      addLineRangeLink(match);
    }

    // Match plain unquoted paths (#selection:path:10-20)
    const plainPattern = new RegExp(this.patterns.lineRange.source, "g");
    while ((match = plainPattern.exec(text)) !== null) {
      addLineRangeLink(match);
    }

    return links;
  }

  /**
   * Find git change reference links (~diff, ~staged, ~stash:N, ~<hash>)
   * Opens a new untitled editor with the live diff output.
   */
  private findGitChangeLinks(
    document: vscode.TextDocument,
    text: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    const gitPatterns = [
      // ~diff and ~staged (fixed keywords)
      { pattern: /~(diff|staged)/g, getRef: (m: RegExpExecArray) => m[1] },
      // ~stash:N
      { pattern: /~(stash:\d+)/g, getRef: (m: RegExpExecArray) => m[1] },
      // ~<7-40 hex chars> (commit hash)
      { pattern: /~([0-9a-f]{7,40})/gi, getRef: (m: RegExpExecArray) => m[1] },
    ];

    for (const { pattern, getRef } of gitPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const ref = getRef(match);
        const startPos = document.positionAt(match.index);
        const endPos = document.positionAt(match.index + match[0].length);
        const range = new vscode.Range(startPos, endPos);

        const commandUri = vscode.Uri.parse(
          `command:ctrlyoke.openGitChange?${encodeURIComponent(
            JSON.stringify({ ref: ref.toLowerCase() })
          )}`
        );

        const link = new vscode.DocumentLink(range, commandUri);
        link.tooltip = `Open git ${ref} diff`;
        links.push(link);
      }
    }

    return links;
  }

  /**
   * Find symbol reference links with encoded line ranges.
   */
  private findSymbolLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    // Helper to add a symbol link from a regex match
    const addSymbolLink = (match: RegExpExecArray): void => {
      const relativePath = match[1];
      const symbolName = match[2];
      const startLine = parseInt(match[3], 10);
      const endLine = parseInt(match[4], 10);

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      const absolutePath = path.join(workspaceRoot, relativePath);
      const fileUri = vscode.Uri.file(absolutePath);

      const commandUri = vscode.Uri.parse(
        `command:ctrlyoke.openFileWithSelection?${encodeURIComponent(
          JSON.stringify({
            uri: fileUri.toString(),
            startLine,
            endLine,
          })
        )}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Go to ${symbolName} in ${relativePath}:${startLine}-${endLine}`;
      links.push(link);
    };

    // Match quoted paths first.
    const quotedPattern = new RegExp(this.patterns.symbolQuoted.source, "g");
    let match: RegExpExecArray | null;
    while ((match = quotedPattern.exec(text)) !== null) {
      addSymbolLink(match);
    }

    // Match plain unquoted paths.
    const plainPattern = new RegExp(this.patterns.symbol.source, "g");
    while ((match = plainPattern.exec(text)) !== null) {
      addSymbolLink(match);
    }

    return links;
  }
}
