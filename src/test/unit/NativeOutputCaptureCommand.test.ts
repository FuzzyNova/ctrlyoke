import * as assert from "assert";
import * as vscode from "vscode";
import {
  CAPTURING_OUTPUT_PLACEHOLDER,
  VSCODE_COMMANDS,
} from "../../types/DashboardConstants";
import {
  executeNativeOutputCaptureCommand,
  registerNativeOutputCaptureCommand,
} from "../../ui/NativeOutputCaptureCommand";

interface RecordedEdit {
  range: vscode.Range;
  replacement: string;
}

class MockNativeTextEditor implements Pick<
  vscode.TextEditor,
  "document" | "selection" | "edit"
> {
  public readonly document: vscode.TextDocument;
  public selection: vscode.Selection;
  public currentText: string;
  public readonly edits: RecordedEdit[] = [];

  private constructor(document: vscode.TextDocument, cursorOffset: number) {
    this.document = document;
    this.currentText = document.getText();
    const cursor = document.positionAt(cursorOffset);
    this.selection = new vscode.Selection(cursor, cursor);
  }

  static async create(text: string, cursorOffset: number) {
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: text,
    });
    return new MockNativeTextEditor(document, cursorOffset);
  }

  async edit(
    callback: (editBuilder: vscode.TextEditorEdit) => void
  ): Promise<boolean> {
    let edit: RecordedEdit | undefined;
    callback({
      replace: (range, replacement) => {
        edit = { range: range as vscode.Range, replacement };
      },
    } as vscode.TextEditorEdit);
    if (!edit) {
      return false;
    }

    const start = this.document.offsetAt(edit.range.start);
    const end = this.document.offsetAt(edit.range.end);
    this.currentText =
      this.currentText.slice(0, start) +
      edit.replacement +
      this.currentText.slice(end);
    this.edits.push(edit);
    return true;
  }
}

suite("NativeOutputCaptureCommand", () => {
  test("replaces the latest placeholder before the cursor, consuming the leading @ trigger", async () => {
    const text = `before @${CAPTURING_OUTPUT_PLACEHOLDER} @${CAPTURING_OUTPUT_PLACEHOLDER} after`;
    const secondStart = text.lastIndexOf(CAPTURING_OUTPUT_PLACEHOLDER);
    const editor = await MockNativeTextEditor.create(
      text,
      secondStart + CAPTURING_OUTPUT_PLACEHOLDER.length
    );
    let capturedId: string | undefined;

    await executeNativeOutputCaptureCommand(
      "capture-1",
      editor,
      async (captureId) => {
        capturedId = captureId;
        return "attachments/output.log";
      },
      async () => undefined
    );

    assert.strictEqual(capturedId, "capture-1");
    assert.strictEqual(
      editor.currentText,
      `before @${CAPTURING_OUTPUT_PLACEHOLDER} @attachments/output.log  after`
    );
    assert.strictEqual(editor.edits.length, 1);
    assert.strictEqual(editor.edits[0].replacement, "@attachments/output.log ");
  });

  test("replaces a leading # trigger too, converting it to a single @ reference", async () => {
    const text = `prefix #${CAPTURING_OUTPUT_PLACEHOLDER} suffix`;
    const editor = await MockNativeTextEditor.create(
      text,
      text.indexOf(CAPTURING_OUTPUT_PLACEHOLDER) +
        CAPTURING_OUTPUT_PLACEHOLDER.length
    );
    let capturedId: string | undefined;

    await executeNativeOutputCaptureCommand(
      "capture-hash",
      editor,
      async (captureId) => {
        capturedId = captureId;
        return "attachments/output.log";
      },
      async () => undefined
    );

    assert.strictEqual(capturedId, "capture-hash");
    assert.strictEqual(
      editor.currentText,
      "prefix @attachments/output.log  suffix"
    );
  });

  test("removes the placeholder and its leading trigger, and reports a save failure", async () => {
    const text = `prefix @${CAPTURING_OUTPUT_PLACEHOLDER} suffix`;
    const editor = await MockNativeTextEditor.create(
      text,
      text.indexOf(CAPTURING_OUTPUT_PLACEHOLDER) +
        CAPTURING_OUTPUT_PLACEHOLDER.length
    );
    const messages: string[] = [];

    await executeNativeOutputCaptureCommand(
      "capture-2",
      editor,
      async () => {
        throw new Error("disk is full");
      },
      async (message) => {
        messages.push(message);
      }
    );

    assert.strictEqual(editor.currentText, "prefix  suffix");
    assert.strictEqual(editor.edits.length, 1);
    assert.strictEqual(editor.edits[0].replacement, "");
    assert.deepStrictEqual(messages, [
      "ctrlyoke: Failed to capture output: disk is full",
    ]);
  });

  test("reports a missing placeholder without attempting an edit", async () => {
    const editor = await MockNativeTextEditor.create("no placeholder", 14);
    const messages: string[] = [];

    await executeNativeOutputCaptureCommand(
      "capture-3",
      editor,
      async () => "attachments/output.log",
      async (message) => {
        messages.push(message);
      }
    );

    assert.strictEqual(editor.currentText, "no placeholder");
    assert.strictEqual(editor.edits.length, 0);
    assert.deepStrictEqual(messages, [
      "ctrlyoke: Failed to capture output: Output capture placeholder was not found",
    ]);
  });

  test("registers the command and uses the active editor at invocation time", async () => {
    const text = `prompt @${CAPTURING_OUTPUT_PLACEHOLDER}`;
    const editor = await MockNativeTextEditor.create(text, text.length);
    const originalActiveEditor = vscode.window.activeTextEditor;
    const originalRegisterCommand = vscode.commands.registerCommand;
    let registeredCommand: string | undefined;
    let registeredHandler: ((captureId: unknown) => Promise<void>) | undefined;

    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: editor,
    });
    Object.defineProperty(vscode.commands, "registerCommand", {
      configurable: true,
      value: (
        command: string,
        handler: (captureId: unknown) => Promise<void>
      ) => {
        registeredCommand = command;
        registeredHandler = handler;
        return { dispose: () => undefined };
      },
    });

    try {
      const disposable = registerNativeOutputCaptureCommand(
        () => "workspace",
        async () => undefined,
        async () => "attachments/output.log"
      );
      assert.ok(disposable);
      assert.strictEqual(
        registeredCommand,
        VSCODE_COMMANDS.RESOLVE_OUTPUT_CAPTURE
      );
      await registeredHandler?.("capture-4");
      assert.strictEqual(editor.currentText, "prompt @attachments/output.log ");
    } finally {
      Object.defineProperty(vscode.window, "activeTextEditor", {
        configurable: true,
        value: originalActiveEditor,
      });
      Object.defineProperty(vscode.commands, "registerCommand", {
        configurable: true,
        value: originalRegisterCommand,
      });
    }
  });
});
