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
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { EXTERNAL_FILE_TRUST_SCOPES } from "../../types/DashboardConstants";
import type {
  ChoiceRequest,
  UserInteractionPort,
} from "../../ui/UserInteractionPort";

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

class FakeInteractionPort implements UserInteractionPort {
  constructor(private readonly choice: string | undefined) {}

  canPrompt(): boolean {
    return true;
  }

  async requestBatchApproval(): Promise<undefined> {
    return undefined;
  }

  async requestChoice(
    _request: ChoiceRequest
  ): Promise<string | undefined> {
    return this.choice;
  }
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
    workspaceRoot: string,
    workspaceRelativeReferencePathResolver?: (uri: vscode.Uri) => string | null,
    trustChoice: string | null = EXTERNAL_FILE_TRUST_SCOPES.USER,
    prepareTrustPrompt?: () => Promise<UserInteractionPort>
  ): ContextMenuReferenceCommands {
    return new ContextMenuReferenceCommands(
      sink,
      () => workspaceRoot,
      workspaceRelativeReferencePathResolver,
      prepareTrustPrompt ??
        (async () => new FakeInteractionPort(trustChoice ?? undefined))
    );
  }

  function setActiveEditor(editor: MockOutputEditor): void {
    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: editor,
    });
  }

  function createTestWorkspace(): string {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-context-menu-workspace-")
    );
    workspaceRoots.push(workspaceRoot);
    return workspaceRoot;
  }

  test("offers trust and inserts absolute references for external targets", async () => {
    const workspaceRoot = createTestWorkspace();
    const externalRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-context-menu-external-")
    );
    workspaceRoots.push(externalRoot);
    const externalFilePath = path.join(externalRoot, "external.ts");
    const externalDirectoryPath = path.join(externalRoot, "nested");
    await fs.promises.writeFile(
      externalFilePath,
      "function externalSymbol() {}\n"
    );
    await fs.promises.mkdir(externalDirectoryPath);

    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalShouldOfferTrust =
      ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks;
    const originalGetApprovedRoots =
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots;
    const originalAddUserRoot =
      ConfigurationUtils.addUserAllowedExternalFileRoot;
    const originalExecuteCommand = vscode.commands.executeCommand;
    const warningMessages: string[] = [];
    const trustedParentFolders: string[] = [];

    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: ((message: string) => {
        warningMessages.push(message);
        return Promise.resolve("Trust Parent Folder");
      }) as unknown as typeof originalShowWarningMessage,
    });
    ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks = () => true;
    ConfigurationUtils.getEffectiveApprovedExternalFileRoots = () => [];
    ConfigurationUtils.addUserAllowedExternalFileRoot = async (root) => {
      trustedParentFolders.push(root);
    };

    const symbol = new vscode.DocumentSymbol(
      "externalSymbol",
      "",
      vscode.SymbolKind.Function,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 30)),
      new vscode.Range(new vscode.Position(0, 9), new vscode.Position(0, 23))
    );
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: ((command: string) =>
        command === "vscode.executeDocumentSymbolProvider"
          ? Promise.resolve([symbol])
          : originalExecuteCommand(command)) as typeof originalExecuteCommand,
    });

    try {
      const externalDocument = await vscode.workspace.openTextDocument(
        vscode.Uri.file(externalFilePath)
      );
      setActiveEditor(
        new MockOutputEditor(
          externalDocument,
          new vscode.Selection(
            new vscode.Position(0, 0),
            new vscode.Position(0, 10)
          )
        )
      );

      const sink = new RecordingPromptEditorInsertSink();
      const commands = createCommands(sink, workspaceRoot);
      await commands.addFileToPromptEditor(vscode.Uri.file(externalFilePath));
      await commands.addDirectoryToPromptEditor(
        vscode.Uri.file(externalDirectoryPath)
      );
      await commands.addSelectionToPromptEditor(
        vscode.Uri.file(externalFilePath)
      );
      await commands.addSymbolToPromptEditor(
        vscode.Uri.file(externalFilePath),
        1
      );

      const normalizedFilePath = vscode.Uri.file(
        externalFilePath
      ).fsPath.replace(/\\/g, "/");
      const normalizedDirectoryPath = `${vscode.Uri.file(
        externalDirectoryPath
      ).fsPath.replace(/\\/g, "/")}/`;
      assert.deepStrictEqual(
        sink.requests.map((request) => request.references[0]),
        [
          `@${normalizedFilePath}`,
          `@${normalizedDirectoryPath}`,
          `#selection:"${normalizedFilePath}":1-1`,
          `#sym.function:"${normalizedFilePath}":externalSymbol:1-1`,
        ]
      );
      assert.deepStrictEqual(trustedParentFolders, [
        vscode.Uri.file(externalRoot).fsPath,
        vscode.Uri.file(externalRoot).fsPath,
        vscode.Uri.file(externalRoot).fsPath,
        vscode.Uri.file(externalRoot).fsPath,
      ]);
    } finally {
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalShowWarningMessage,
      });
      ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks =
        originalShouldOfferTrust;
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots =
        originalGetApprovedRoots;
      ConfigurationUtils.addUserAllowedExternalFileRoot = originalAddUserRoot;
      Object.defineProperty(vscode.commands, "executeCommand", {
        configurable: true,
        value: originalExecuteCommand,
      });
    }
  });

  test("inserts an already-trusted external target without prompting", async () => {
    const workspaceRoot = createTestWorkspace();
    const externalRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-context-menu-trusted-")
    );
    workspaceRoots.push(externalRoot);
    const externalFilePath = path.join(externalRoot, "trusted.ts");
    const sink = new RecordingPromptEditorInsertSink();
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalGetApprovedRoots =
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots;
    const warningMessages: string[] = [];

    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: ((message: string) => {
        warningMessages.push(message);
        return Promise.resolve(undefined);
      }) as unknown as typeof originalShowWarningMessage,
    });

    test("waits for the panel-ready boundary before asking for trust", async () => {
      const workspaceRoot = createTestWorkspace();
      const externalRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "ctrlyoke-context-menu-ready-")
      );
      workspaceRoots.push(externalRoot);
      const externalFilePath = path.join(externalRoot, "ready.ts");
      const sink = new RecordingPromptEditorInsertSink();
      const stages: string[] = [];
      const originalShouldOffer =
        ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks;
      const originalGetApproved =
        ConfigurationUtils.getEffectiveApprovedExternalFileRoots;
      const originalAddUser =
        ConfigurationUtils.addUserAllowedExternalFileRoot;

      ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks = () => true;
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots = () => [];
      ConfigurationUtils.addUserAllowedExternalFileRoot = async () => {};

      try {
        await createCommands(
          sink,
          workspaceRoot,
          undefined,
          EXTERNAL_FILE_TRUST_SCOPES.USER,
          async () => {
            stages.push("open-panel");
            await Promise.resolve();
            stages.push("ready");
            return new FakeInteractionPort(EXTERNAL_FILE_TRUST_SCOPES.USER);
          }
        ).addFileToPromptEditor(vscode.Uri.file(externalFilePath));

        assert.deepStrictEqual(stages, ["open-panel", "ready"]);
        assert.strictEqual(sink.requests.length, 1);
      } finally {
        ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks =
          originalShouldOffer;
        ConfigurationUtils.getEffectiveApprovedExternalFileRoots =
          originalGetApproved;
        ConfigurationUtils.addUserAllowedExternalFileRoot = originalAddUser;
      }
    });
    ConfigurationUtils.getEffectiveApprovedExternalFileRoots = () => [
      externalRoot,
    ];

    try {
      await createCommands(sink, workspaceRoot).addFileToPromptEditor(
        vscode.Uri.file(externalFilePath)
      );

      assert.deepStrictEqual(sink.requests[0].references, [
        `@${vscode.Uri.file(externalFilePath).fsPath.replace(/\\/g, "/")}`,
      ]);
    } finally {
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalShowWarningMessage,
      });
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots =
        originalGetApprovedRoots;
    }
  });

  test("does not insert an external reference when trust is declined", async () => {
    const workspaceRoot = createTestWorkspace();
    const externalRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-context-menu-declined-")
    );
    workspaceRoots.push(externalRoot);
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalShouldOfferTrust =
      ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks;
    const originalGetApprovedRoots =
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots;
    const warningMessages: string[] = [];

    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: ((message: string) => {
        warningMessages.push(message);
        return Promise.resolve(undefined);
      }) as unknown as typeof originalShowWarningMessage,
    });
    ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks = () => true;
    ConfigurationUtils.getEffectiveApprovedExternalFileRoots = () => [];

    try {
      const sink = new RecordingPromptEditorInsertSink();
      await createCommands(
        sink,
        workspaceRoot,
        undefined,
        null
      ).addDirectoryToPromptEditor(vscode.Uri.file(path.join(externalRoot, "declined")));

      assert.strictEqual(sink.requests.length, 0);
    } finally {
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: originalShowWarningMessage,
      });
      ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks =
        originalShouldOfferTrust;
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots =
        originalGetApprovedRoots;
    }
  });

  test("keeps workspace targets as relative references", async () => {
    const workspaceRoot = createTestWorkspace();
    const workspaceFileUri = vscode.Uri.file(
      path.join(workspaceRoot, "context-menu-regression.ts")
    );
    const sink = new RecordingPromptEditorInsertSink();

    await createCommands(
      sink,
      workspaceRoot,
      () => "context-menu-regression.ts"
    ).addFileToPromptEditor(workspaceFileUri);

    assert.deepStrictEqual(sink.requests[0].references, [
      "@context-menu-regression.ts",
    ]);
  });

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
