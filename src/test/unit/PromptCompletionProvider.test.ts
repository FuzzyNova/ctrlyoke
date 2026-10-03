import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { afterEach, suite, test } from "mocha";
import { PromptCompletionProvider } from "../../completions/PromptCompletionProvider";
import { clearFilesCache } from "../../completions/CompletionHelpers";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

interface SelectionEditorLike {
  selection: vscode.Selection;
  document: Pick<vscode.TextDocument, "uri" | "getText">;
}

class MockSelectionEditor implements SelectionEditorLike {
  constructor(
    readonly selection: vscode.Selection,
    readonly document: Pick<vscode.TextDocument, "uri" | "getText">
  ) {}
}

class MockCancellationToken implements vscode.CancellationToken {
  isCancellationRequested = false;
  onCancellationRequested = new vscode.EventEmitter<void>().event;
}

suite("PromptCompletionProvider", () => {
  const originalFindFiles = vscode.workspace.findFiles;
  const originalAsRelativePath = vscode.workspace.asRelativePath;
  const originalVisibleTextEditors = vscode.window.visibleTextEditors;
  const originalExecuteCommand = vscode.commands.executeCommand;
  const originalShouldRespectGitignore =
    ConfigurationUtils.shouldRespectGitignoreForCompletions;

  afterEach(() => {
    clearFilesCache();
    Object.defineProperty(vscode.workspace, "findFiles", {
      configurable: true,
      value: originalFindFiles,
    });
    Object.defineProperty(vscode.workspace, "asRelativePath", {
      configurable: true,
      value: originalAsRelativePath,
    });
    Object.defineProperty(vscode.window, "visibleTextEditors", {
      configurable: true,
      value: originalVisibleTextEditors,
    });
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: originalExecuteCommand,
    });
    ConfigurationUtils.shouldRespectGitignoreForCompletions =
      originalShouldRespectGitignore;
  });

  test("JSON prompt completions escape quoted paths for @, #selection, and #sym", async () => {
    clearFilesCache();
    ConfigurationUtils.shouldRespectGitignoreForCompletions = () => false;
    const root = path.join(path.sep, "workspace");
    const fileUri = vscode.Uri.file(path.join(root, "my dir", "a.md"));
    Object.defineProperty(vscode.workspace, "findFiles", {
      configurable: true,
      value: async () => [fileUri],
    });
    Object.defineProperty(vscode.workspace, "asRelativePath", {
      configurable: true,
      value: () => "my dir/a.md",
    });

    const selectionEditor = new MockSelectionEditor(
      new vscode.Selection(
        new vscode.Position(0, 0),
        new vscode.Position(0, 5)
      ),
      {
        uri: fileUri,
        getText: () => "hello",
      }
    );
    Object.defineProperty(vscode.window, "visibleTextEditors", {
      configurable: true,
      value: [selectionEditor],
    });

    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: ((command: string) =>
        command === "vscode.executeWorkspaceSymbolProvider"
          ? Promise.resolve([
              new vscode.SymbolInformation(
                "Heading Name",
                vscode.SymbolKind.String,
                "",
                new vscode.Location(
                  fileUri,
                  new vscode.Range(
                    new vscode.Position(2, 0),
                    new vscode.Position(2, 12)
                  )
                )
              ),
            ])
          : originalExecuteCommand(command)) as typeof originalExecuteCommand,
    });

    const provider = new PromptCompletionProvider();
    const complete = async (prompt: string, trigger: "@" | "#") => {
      const document = await vscode.workspace.openTextDocument({
        language: "json",
        content: `{"prompt":"review ${trigger}"}`,
      });
      const position = new vscode.Position(0, `{"prompt":"review ${trigger}`.length);
      const list = await provider.provideCompletionItems(
        document,
        position,
        new MockCancellationToken(),
        {
          triggerKind: vscode.CompletionTriggerKind.Invoke,
          triggerCharacter: undefined,
        }
      );
      assert.ok(list, `${prompt} completion list should be provided`);
      return list.items;
    };

    const atItems = await complete("@", "@");
    assert.ok(
      atItems.some((item) => item.insertText === '\\"my dir/a.md\\"'),
      "@ path completion should escape reference quotes for JSON"
    );

    const hashItems = await complete("#", "#");
    assert.ok(
      hashItems.some(
        (item) => item.insertText === 'selection:\\"my dir/a.md\\":1-1'
      ),
      "selection completion should escape path quotes for JSON"
    );
    assert.ok(
      hashItems.some(
        (item) =>
          item.insertText ===
          'sym.string:\\"my dir/a.md\\":\\"Heading Name\\":3-3'
      ),
      "symbol completion should escape path and name quotes for JSON"
    );
  });
});
