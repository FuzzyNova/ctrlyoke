import * as vscode from "vscode";

type StubbedDocumentMembers =
  | "uri"
  | "version"
  | "fileName"
  | "languageId"
  | "getText"
  | "offsetAt"
  | "positionAt"
  | "lineAt";

/** Unique per stub, so per-version caches never serve one test's text to another. */
let nextVersion = 1;

/** A text document with real line/offset arithmetic, for provider tests. */
export class PromptDocumentStub implements Pick<
  vscode.TextDocument,
  StubbedDocumentMembers
> {
  private readonly lines: string[];
  readonly uri: vscode.Uri;
  readonly version = nextVersion++;

  constructor(
    readonly fileName: string,
    readonly languageId: string,
    private readonly text: string
  ) {
    this.lines = text.split("\n");
    this.uri = vscode.Uri.file(fileName);
  }

  getText(): string {
    return this.text;
  }

  offsetAt(position: vscode.Position): number {
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
      offset += this.lines[line].length + 1;
    }
    return offset + position.character;
  }

  positionAt(offset: number): vscode.Position {
    let remaining = offset;
    for (let line = 0; line < this.lines.length; line++) {
      if (remaining <= this.lines[line].length) {
        return new vscode.Position(line, remaining);
      }
      remaining -= this.lines[line].length + 1;
    }
    return new vscode.Position(this.lines.length - 1, remaining);
  }

  lineAt(line: number): vscode.TextLine;
  lineAt(position: vscode.Position): vscode.TextLine;
  lineAt(lineOrPosition: number | vscode.Position): vscode.TextLine {
    const line =
      typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    return { text: this.lines[line] } as vscode.TextLine;
  }

  /** The offset just after the first occurrence of `marker`. */
  offsetAfter(marker: string): number {
    const index = this.text.indexOf(marker);
    if (index < 0) throw new Error(`marker not found: ${marker}`);
    return index + marker.length;
  }

  asDocument(): vscode.TextDocument {
    return this as unknown as vscode.TextDocument;
  }
}
