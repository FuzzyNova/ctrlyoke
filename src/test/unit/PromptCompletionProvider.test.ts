import * as assert from "assert";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import * as vscode from "vscode";
import { afterEach, suite, test } from "mocha";
import { PromptCompletionProvider } from "../../completions/PromptCompletionProvider";
import { clearFilesCache } from "../../completions/CompletionHelpers";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { PromptDocumentStub } from "../helpers/PromptDocumentStub";

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
  const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
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
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: originalWorkspaceFolders,
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
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "completion-provider-")
    );
    await fs.mkdir(path.join(root, "my dir"), { recursive: true });
    await fs.writeFile(path.join(root, "my dir", "a.md"), "hello");
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: [{ uri: vscode.Uri.file(root), name: "workspace", index: 0 }],
    });
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
      const position = new vscode.Position(
        0,
        `{"prompt":"review ${trigger}`.length
      );
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
    await fs.rm(root, { recursive: true, force: true });
  });

  suite("references inside code", () => {
    /** Completions at the end of the first occurrence of `marker`. */
    const completeAfter = async (
      fileName: string,
      languageId: string,
      text: string,
      marker: string
    ): Promise<vscode.CompletionList | undefined> => {
      clearFilesCache();
      ConfigurationUtils.shouldRespectGitignoreForCompletions = () => false;
      const root = path.join(os.tmpdir(), "completion-provider-code");
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        configurable: true,
        value: [{ uri: vscode.Uri.file(root), name: "workspace", index: 0 }],
      });
      Object.defineProperty(vscode.workspace, "findFiles", {
        configurable: true,
        value: async () => [],
      });
      const document = new PromptDocumentStub(
        path.join(root, fileName),
        languageId,
        text
      );
      return new PromptCompletionProvider().provideCompletionItems(
        document.asDocument(),
        document.positionAt(document.offsetAfter(marker)),
        new MockCancellationToken(),
        {
          triggerKind: vscode.CompletionTriggerKind.Invoke,
          triggerCharacter: undefined,
        }
      );
    };

    test("offers nothing inside inline code or a fence", async () => {
      const fenced = ["Read:", "", "```", "@src/ext", "```"].join("\n");
      assert.strictEqual(
        await completeAfter("p.prompt.md", "markdown", fenced, "```\n@src/ext"),
        undefined
      );
      const inline = "Read `@src/ext` now";
      assert.strictEqual(
        await completeAfter("p.prompt.md", "markdown", inline, "`@src/ext"),
        undefined
      );
    });

    test("offers nothing inside an indented fence in a YAML block scalar", async () => {
      const text = [
        "steps:",
        "  - prompt: |",
        "      ```",
        "      @src/ext",
        "      ```",
      ].join("\n");
      assert.strictEqual(
        await completeAfter("w.ctrlyoke.yaml", "yaml", text, "@src/ext"),
        undefined
      );
    });

    test("offers nothing inside inline code in a JSON prompt string", async () => {
      const text = '{ "prompt": "Read `@src/ext` now" }';
      assert.strictEqual(
        await completeAfter("w.ctrlyoke.json", "json", text, "`@src/ext"),
        undefined
      );
    });

    test("still completes a reference just outside the code", async () => {
      const text = "Read `code` then @src/ext";
      assert.ok(
        await completeAfter("p.prompt.md", "markdown", text, "then @src/ext")
      );
      const yamlText = [
        "steps:",
        "  - prompt: |",
        "      `code` then @src/ext",
      ].join("\n");
      assert.ok(
        await completeAfter(
          "w.ctrlyoke.yaml",
          "yaml",
          yamlText,
          "then @src/ext"
        )
      );
    });
  });
});
