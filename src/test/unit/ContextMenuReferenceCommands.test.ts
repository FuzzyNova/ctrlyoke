import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { afterEach, suite, test } from "mocha";
import {
  ContextMenuPromptEditorInsertSink,
  ContextMenuReferenceCommands,
} from "../../completions/ContextMenuReferenceCommands";
import type { PromptEditorInsertRequest } from "../../types/WebviewMessageTypes";

class RecordingPromptEditorInsertSink implements ContextMenuPromptEditorInsertSink {
  readonly requests: PromptEditorInsertRequest[] = [];

  async enqueuePromptEditorInsert(
    request: PromptEditorInsertRequest
  ): Promise<void> {
    this.requests.push(request);
  }
}

class MockOutputEditor implements Pick<
  vscode.TextEditor,
  "document" | "selection"
> {
  constructor(
    readonly document: vscode.TextDocument,
    public selection: vscode.Selection
  ) {}
}

suite("ContextMenuReferenceCommands", () => {
  const workspaceRoots: string[] = [];
  const originalActiveEditor = vscode.window.activeTextEditor;

  afterEach(async () => {
    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: originalActiveEditor,
    });
    for (const workspaceRoot of workspaceRoots.splice(0)) {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  async function createOutputEditor(): Promise<MockOutputEditor> {
    const document = await vscode.workspace.openTextDocument({
      language: "log",
      content: "first output\nsecond output\nthird output",
    });
    return new MockOutputEditor(
      document,
      new vscode.Selection(
        new vscode.Position(0, 0),
        new vscode.Position(1, 13)
      )
    );
  }

  function createCommands(
    sink: RecordingPromptEditorInsertSink,
    workspaceRoot: string
  ): ContextMenuReferenceCommands {
    return new ContextMenuReferenceCommands(sink, () => workspaceRoot);
  }

  function setActiveEditor(editor: MockOutputEditor): void {
    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: editor,
    });
  }

  test("captures the active output selection with a 1-based line range", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-context-menu-")
    );
    workspaceRoots.push(workspaceRoot);
    const editor = await createOutputEditor();
    setActiveEditor(editor);
    const sink = new RecordingPromptEditorInsertSink();

    await createCommands(sink, workspaceRoot).addOutputSelectionToPromptEditor(
      editor.document.uri
    );

    assert.strictEqual(sink.requests.length, 1);
    assert.match(
      sink.requests[0].references[0],
      /^@\.ctrlyoke\/attachments\/output-/
    );
    const referencePath = sink.requests[0].references[0].slice(1);
    assert.strictEqual(
      await fs.promises.readFile(
        path.join(workspaceRoot, referencePath),
        "utf8"
      ),
      "first output\nsecond output"
    );
    assert.match(referencePath, /-1-2-[0-9a-f]{12}\.log$/);
  });

  test("captures the whole active output channel from the toolbar invocation", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-context-menu-")
    );
    workspaceRoots.push(workspaceRoot);
    const editor = await createOutputEditor();
    editor.selection = new vscode.Selection(
      editor.document.positionAt(0),
      editor.document.positionAt(0)
    );
    setActiveEditor(editor);
    const sink = new RecordingPromptEditorInsertSink();

    await createCommands(sink, workspaceRoot).addOutputChannelToPromptEditor();

    assert.strictEqual(sink.requests.length, 1);
    const referencePath = sink.requests[0].references[0].slice(1);
    assert.strictEqual(
      await fs.promises.readFile(
        path.join(workspaceRoot, referencePath),
        "utf8"
      ),
      "first output\nsecond output\nthird output"
    );
    assert.match(referencePath, /-full-[0-9a-f]{12}\.log$/);
  });

  test("builds a single, non-double-quoted reference when the channel name has a space", async () => {
    // Real output channels commonly have spaces in their display name (e.g.
    // "Extension Host", "GitHub Copilot Chat"), which getOutputChannelSlug
    // carries into the attachment filename. writeOutputSnapshotAttachment
    // already returns a quoted reference value, so re-quoting it would
    // produce a malformed "@""..."" token instead of a single "@"..."".
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-context-menu-")
    );
    workspaceRoots.push(workspaceRoot);
    const editor = await createOutputEditor();
    editor.selection = new vscode.Selection(
      editor.document.positionAt(0),
      editor.document.positionAt(0)
    );
    setActiveEditor(editor);
    const sink = new RecordingPromptEditorInsertSink();

    const originalAsRelativePath = vscode.workspace.asRelativePath;
    Object.defineProperty(vscode.workspace, "asRelativePath", {
      configurable: true,
      value: () => "My Channel Name",
    });
    try {
      await createCommands(
        sink,
        workspaceRoot
      ).addOutputChannelToPromptEditor();
    } finally {
      Object.defineProperty(vscode.workspace, "asRelativePath", {
        configurable: true,
        value: originalAsRelativePath,
      });
    }

    assert.strictEqual(sink.requests.length, 1);
    const reference = sink.requests[0].references[0];
    assert.ok(
      !reference.includes('""'),
      `reference must not be double-quoted: ${reference}`
    );
    assert.match(reference, /^@"[^"]+"$/);
    const referencePath = reference.slice(2, -1);
    assert.strictEqual(
      await fs.promises.readFile(
        path.join(workspaceRoot, referencePath),
        "utf8"
      ),
      "first output\nsecond output\nthird output"
    );
  });

  test("does not capture when the passed editor URI is not active", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-context-menu-")
    );
    workspaceRoots.push(workspaceRoot);
    const editor = await createOutputEditor();
    setActiveEditor(editor);
    const sink = new RecordingPromptEditorInsertSink();

    await createCommands(sink, workspaceRoot).addOutputChannelToPromptEditor(
      vscode.Uri.parse("output://different-channel")
    );

    assert.strictEqual(sink.requests.length, 0);
  });
});
