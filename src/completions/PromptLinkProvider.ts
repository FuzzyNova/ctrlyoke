import * as vscode from "vscode";
import * as path from "path";

/**
 * Provides clickable links for FlightPath context references
 *
 * Supported patterns:
 * - @path/to/file.ts       → Open file
 * - @path/to/dir/          → Reveal directory
 * - #selection:path:10-20  → Open file with line selection
 * - #sym:path:symbol:42    → Open file at symbol line
 *
 * Enables Ctrl+Click (Cmd+Click on Mac) navigation from prompts back to source code.
 * Complements PromptCompletionProvider for bidirectional context flow.
 */
export class PromptLinkProvider implements vscode.DocumentLinkProvider {
  // Regex patterns for detecting context references
  // Note: Patterns are recreated for each call to ensure proper state reset
  private readonly patterns = {
    // @file.ext (no trailing slash, has extension)
    // Matches: @src/extension.ts, @docs/plan.md
    fullFile: /@([^\s@#]+\.[a-zA-Z0-9]+)/g,

    // @dir/ (trailing slash)
    // Matches: @src/ui/, @docs/
    directory: /@([^\s@#]+\/)/g,

    // #selection:path:10-20 (line range)
    // Matches: #selection:src/extension.ts:10-20
    lineRange: /#selection:([^\s:]+):(\d+)-(\d+)/g,

    // #sym:path:symbol:42 (symbol reference)
    // Matches: #sym:src/extension.ts:activate:14
    symbol: /#sym:([^\s:]+):([^:]+):(\d+)/g,
  };

  /**
   * Provide document links for prompt files
   */
  provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
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

    // 1. Detect full file references (@file.ext)
    links.push(...this.findFileLinks(document, text, workspaceRoot));

    // 2. Detect directory references (@dir/)
    links.push(...this.findDirectoryLinks(document, text, workspaceRoot));

    // 3. Detect line range references (#selection:path:10-20)
    links.push(...this.findLineRangeLinks(document, text, workspaceRoot));

    // 4. Detect symbol references (#sym:path:symbol:42)
    links.push(...this.findSymbolLinks(document, text, workspaceRoot));

    return links;
  }

  /**
   * Check if document is a prompt file
   */
  private isPromptFile(document: vscode.TextDocument): boolean {
    const fileName = path.basename(document.fileName);
    return (
      fileName.endsWith(".flightpath.json") ||
      fileName.endsWith(".flightpath.yaml") ||
      fileName.endsWith(".flightpath.yml") ||
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
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  /**
   * Find full file reference links (@path/to/file.ts)
   */
  private findFileLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    // Create fresh regex instance to avoid state issues
    const pattern = new RegExp(this.patterns.fullFile.source, "g");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const relativePath = match[1];
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      // Resolve to absolute path
      const absolutePath = path.join(workspaceRoot, relativePath);
      const fileUri = vscode.Uri.file(absolutePath);

      const link = new vscode.DocumentLink(range, fileUri);
      link.tooltip = `Open ${relativePath}`;
      links.push(link);
    }

    return links;
  }

  /**
   * Find directory reference links (@path/to/dir/)
   */
  private findDirectoryLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    // Create fresh regex instance to avoid state issues
    const pattern = new RegExp(this.patterns.directory.source, "g");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const relativePath = match[1];
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      // Resolve to absolute path
      const absolutePath = path.join(workspaceRoot, relativePath);
      const dirUri = vscode.Uri.file(absolutePath);

      // Use command URI to reveal in Explorer
      const commandUri = vscode.Uri.parse(
        `command:revealInExplorer?${encodeURIComponent(JSON.stringify(dirUri.toString()))}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Reveal ${relativePath} in File Explorer`;
      links.push(link);
    }

    return links;
  }

  /**
   * Find line range reference links (#selection:path:10-20)
   */
  private findLineRangeLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    // Create fresh regex instance to avoid state issues
    const pattern = new RegExp(this.patterns.lineRange.source, "g");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const relativePath = match[1];
      const startLine = parseInt(match[2], 10);
      const endLine = parseInt(match[3], 10);

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      // Resolve to absolute path
      const absolutePath = path.join(workspaceRoot, relativePath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Use custom command to open with selection
      const commandUri = vscode.Uri.parse(
        `command:flightpath.openFileWithSelection?${encodeURIComponent(
          JSON.stringify({ uri: fileUri.toString(), startLine, endLine })
        )}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Open ${relativePath} at lines ${startLine}-${endLine}`;
      links.push(link);
    }

    return links;
  }

  /**
   * Find symbol reference links (#sym:path:symbol:42)
   */
  private findSymbolLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    // Create fresh regex instance to avoid state issues
    const pattern = new RegExp(this.patterns.symbol.source, "g");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const relativePath = match[1];
      const symbolName = match[2];
      const line = parseInt(match[3], 10);

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      // Resolve to absolute path
      const absolutePath = path.join(workspaceRoot, relativePath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Use custom command to open with selection (single line)
      const commandUri = vscode.Uri.parse(
        `command:flightpath.openFileWithSelection?${encodeURIComponent(
          JSON.stringify({
            uri: fileUri.toString(),
            startLine: line,
            endLine: line,
          })
        )}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Go to ${symbolName} in ${relativePath}:${line}`;
      links.push(link);
    }

    return links;
  }
}
