import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { afterEach, suite, test } from "mocha";
import {
  ContextMenuPromptEditorInsertSink,
  ContextMenuReferenceCommands,
  extractCommitHashFromEditorUri,
} from "../../completions/ContextMenuReferenceCommands";
import {
  buildDirectoryReference,
  buildFileReference,
  buildGitReference,
  buildSelectionReference,
  buildSymbolReference,
} from "../../completions/ContextReferenceBuilder";
import type { PromptEditorInsertRequest } from "../../types/WebviewMessageTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import {
  EXTERNAL_FILE_TRUST_SCOPES,
  VSCODE_COMMANDS,
  VSCODE_URI_SCHEMES,
} from "../../types/DashboardConstants";
import type {
  ChoiceRequest,
  UserInteractionPort,
} from "../../ui/UserInteractionPort";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { snapshotProperty } from "../helpers/propertySnapshot";

class RecordingPromptEditorInsertSink implements ContextMenuPromptEditorInsertSink {
  readonly requests: PromptEditorInsertRequest[] = [];

  async enqueuePromptEditorInsert(
    request: PromptEditorInsertRequest
  ): Promise<void> {
    this.requests.push(request);
  }
}

class MockWorkspaceFolder implements vscode.WorkspaceFolder {
  constructor(
    readonly uri: vscode.Uri,
    readonly name: string,
    readonly index: number
  ) {}

  toResource(relativePath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.uri, relativePath);
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

  async requestChoice(_request: ChoiceRequest): Promise<string | undefined> {
    return this.choice;
  }
}

suite("ContextMenuReferenceCommands", () => {
  const workspaceRoots: string[] = [];
  const restoreActiveEditor = snapshotProperty(
    vscode.window,
    "activeTextEditor"
  );

  afterEach(async () => {
    restoreActiveEditor();
    for (const workspaceRoot of workspaceRoots.splice(0)) {
      removeTempDir(workspaceRoot);
    }
  });

  function trackedTempDir(prefix: string): string {
    const dir = makeTempDir(prefix);
    workspaceRoots.push(dir);
    return dir;
  }

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
    prepareTrustPrompt?: () => Promise<UserInteractionPort>,
    workspaceCommitChecker?: (
      workspaceRoot: string,
      commitHash: string
    ) => Promise<boolean>
  ): ContextMenuReferenceCommands {
    return new ContextMenuReferenceCommands(
      sink,
      () => workspaceRoot,
      workspaceRelativeReferencePathResolver,
      prepareTrustPrompt ??
        (async () => new FakeInteractionPort(trustChoice ?? undefined)),
      workspaceCommitChecker
    );
  }

  function setActiveEditor(editor: MockOutputEditor): void {
    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: editor,
    });
  }

  function createTestWorkspace(): string {
    const workspaceRoot = trackedTempDir("ctrlyoke-context-menu-workspace-");
    return workspaceRoot;
  }

  test("offers trust and inserts absolute references for external targets", async () => {
    const workspaceRoot = createTestWorkspace();
    const externalRoot = trackedTempDir("ctrlyoke-context-menu-external-");
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
          buildFileReference(normalizedFilePath),
          buildDirectoryReference(normalizedDirectoryPath),
          buildSelectionReference(normalizedFilePath, 1, 1),
          buildSymbolReference(
            normalizedFilePath,
            "externalSymbol",
            1,
            1,
            "function"
          ),
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
    const externalRoot = trackedTempDir("ctrlyoke-context-menu-trusted-");
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
      const externalRoot = trackedTempDir("ctrlyoke-context-menu-ready-");
      const externalFilePath = path.join(externalRoot, "ready.ts");
      const sink = new RecordingPromptEditorInsertSink();
      const stages: string[] = [];
      const originalShouldOffer =
        ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks;
      const originalGetApproved =
        ConfigurationUtils.getEffectiveApprovedExternalFileRoots;
      const originalAddUser = ConfigurationUtils.addUserAllowedExternalFileRoot;

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
        buildFileReference(
          vscode.Uri.file(externalFilePath).fsPath.replace(/\\/g, "/")
        ),
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
    const externalRoot = trackedTempDir("ctrlyoke-context-menu-declined-");
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
      ).addDirectoryToPromptEditor(
        vscode.Uri.file(path.join(externalRoot, "declined"))
      );

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

  test("includes the workspace folder name for targets in a multi-root workspace", async () => {
    const restoreWorkspaceFolders = snapshotProperty(
      vscode.workspace,
      "workspaceFolders"
    );
    const originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
    const originalAsRelativePath = vscode.workspace.asRelativePath;
    const firstRoot = vscode.Uri.file("/workspace/frontend");
    const secondRoot = vscode.Uri.file("/workspace/backend");
    const folders: vscode.WorkspaceFolder[] = [
      new MockWorkspaceFolder(firstRoot, "frontend", 0),
      new MockWorkspaceFolder(secondRoot, "backend", 1),
    ];
    let includeWorkspaceFolder: boolean | undefined;
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: folders,
    });
    Object.defineProperty(vscode.workspace, "getWorkspaceFolder", {
      configurable: true,
      value: (uri: vscode.Uri) =>
        uri.fsPath.startsWith(secondRoot.fsPath) ? folders[1] : undefined,
    });
    Object.defineProperty(vscode.workspace, "asRelativePath", {
      configurable: true,
      value: (_uri: vscode.Uri, includeFolder?: boolean) => {
        includeWorkspaceFolder = includeFolder;
        return includeFolder ? "backend/src/app.ts" : "src/app.ts";
      },
    });

    try {
      const sink = new RecordingPromptEditorInsertSink();
      await createCommands(sink, secondRoot.fsPath).addFileToPromptEditor(
        vscode.Uri.file("/workspace/backend/src/app.ts")
      );

      assert.strictEqual(includeWorkspaceFolder, true);
      assert.deepStrictEqual(sink.requests[0].references, [
        "@backend/src/app.ts",
      ]);
    } finally {
      restoreWorkspaceFolders();
      Object.defineProperty(vscode.workspace, "getWorkspaceFolder", {
        configurable: true,
        value: originalGetWorkspaceFolder,
      });
      Object.defineProperty(vscode.workspace, "asRelativePath", {
        configurable: true,
        value: originalAsRelativePath,
      });
    }
  });

  test("keeps workspace-relative references unprefixed in a single-root workspace", async () => {
    const restoreWorkspaceFolders = snapshotProperty(
      vscode.workspace,
      "workspaceFolders"
    );
    const originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
    const originalAsRelativePath = vscode.workspace.asRelativePath;
    const root = vscode.Uri.file("/workspace/project");
    const folder = new MockWorkspaceFolder(root, "project", 0);
    let includeWorkspaceFolder: boolean | undefined;
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: [folder],
    });
    Object.defineProperty(vscode.workspace, "getWorkspaceFolder", {
      configurable: true,
      value: () => folder,
    });
    Object.defineProperty(vscode.workspace, "asRelativePath", {
      configurable: true,
      value: (_uri: vscode.Uri, includeFolder?: boolean) => {
        includeWorkspaceFolder = includeFolder;
        return includeFolder ? "project/src/app.ts" : "src/app.ts";
      },
    });

    try {
      const sink = new RecordingPromptEditorInsertSink();
      await createCommands(sink, root.fsPath).addFileToPromptEditor(
        vscode.Uri.file("/workspace/project/src/app.ts")
      );

      assert.strictEqual(includeWorkspaceFolder, false);
      assert.deepStrictEqual(sink.requests[0].references, ["@src/app.ts"]);
    } finally {
      restoreWorkspaceFolders();
      Object.defineProperty(vscode.workspace, "getWorkspaceFolder", {
        configurable: true,
        value: originalGetWorkspaceFolder,
      });
      Object.defineProperty(vscode.workspace, "asRelativePath", {
        configurable: true,
        value: originalAsRelativePath,
      });
    }
  });

  test("captures the active output selection with a 1-based line range", async () => {
    const workspaceRoot = trackedTempDir("ctrlyoke-context-menu-");
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

  test("does not include the next line in a whole-line output selection", async () => {
    const workspaceRoot = trackedTempDir("ctrlyoke-context-menu-");
    const editor = await createOutputEditor();
    editor.selection = new vscode.Selection(
      new vscode.Position(0, 0),
      new vscode.Position(1, 0)
    );
    setActiveEditor(editor);
    const sink = new RecordingPromptEditorInsertSink();

    await createCommands(sink, workspaceRoot).addOutputSelectionToPromptEditor(
      editor.document.uri
    );

    const reference = sink.requests[0].references[0];
    assert.match(reference, /-1-1-[0-9a-f]{12}\.log$/);
    const referencePath = reference.slice(1);
    assert.strictEqual(
      await fs.promises.readFile(
        path.join(workspaceRoot, referencePath),
        "utf8"
      ),
      "first output\n"
    );
  });

  test("inserts a whole-line file selection with an inclusive end", async () => {
    const workspaceRoot = createTestWorkspace();
    const filePath = path.join(workspaceRoot, "app.ts");
    await fs.promises.writeFile(filePath, "first\nsecond\nthird", "utf8");
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(filePath)
    );
    const editor = new MockOutputEditor(
      document,
      new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(1, 0))
    );
    setActiveEditor(editor);
    const sink = new RecordingPromptEditorInsertSink();
    const commands = createCommands(sink, workspaceRoot, () => "src/app.ts");

    await commands.addSelectionToPromptEditor(document.uri);

    assert.deepStrictEqual(sink.requests[0].references, [
      "#selection:src/app.ts:1-1",
    ]);
  });

  test("captures the whole active output channel from the toolbar invocation", async () => {
    const workspaceRoot = trackedTempDir("ctrlyoke-context-menu-");
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
    // carries into the attachment filename. writeOutputCaptureAttachment
    // already returns a quoted reference value, so re-quoting it would
    // produce a malformed "@""..."" token instead of a single "@"..."".
    const workspaceRoot = trackedTempDir("ctrlyoke-context-menu-");
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
    const workspaceRoot = trackedTempDir("ctrlyoke-context-menu-");
    const editor = await createOutputEditor();
    setActiveEditor(editor);
    const sink = new RecordingPromptEditorInsertSink();

    await createCommands(sink, workspaceRoot).addOutputChannelToPromptEditor(
      vscode.Uri.parse("output://different-channel")
    );

    assert.strictEqual(sink.requests.length, 0);
  });

  suite("commit in an editor", () => {
    const COMMIT = "0123456789abcdef0123456789abcdef01234567";
    const PARENT = "fedcba9876543210fedcba9876543210fedcba98";
    const repoRoot = path.join(os.tmpdir(), "ctrlyoke repo");

    /** The `git:` URI vscode.git builds for a file at a ref (`toGitUri`). */
    function gitUri(ref: string): vscode.Uri {
      const file = vscode.Uri.file(path.join(repoRoot, "src", "a.ts"));
      return file.with({
        scheme: VSCODE_URI_SCHEMES.GIT,
        query: JSON.stringify({ path: file.fsPath, ref }),
      });
    }

    /** The source URI of the Timeline's "Open Commit" multi-file diff. */
    function timelineCommitUri(commit: string): vscode.Uri {
      return vscode.Uri.from({
        scheme: VSCODE_URI_SCHEMES.SCM_HISTORY_ITEM,
        path: `${repoRoot}/${PARENT}..${commit}`,
      });
    }

    /** The source URI of the SCM Graph's commit multi-file diff. */
    function graphCommitUri(commit: string): vscode.Uri {
      return vscode.Uri.from({
        scheme: VSCODE_URI_SCHEMES.SCM_HISTORY_ITEM,
        path: repoRoot,
        query: JSON.stringify({
          repositoryId: "scm0",
          historyItemId: commit,
          historyItemParentId: PARENT,
          historyItemDisplayId: commit.slice(0, 7),
        }),
      });
    }

    const commitUris = (commit: string) => [
      gitUri(commit),
      timelineCommitUri(commit),
      graphCommitUri(commit),
    ];
    const nonCommitUris = [
      gitUri("HEAD"),
      gitUri("~"),
      gitUri(""),
      gitUri(`${COMMIT}^`),
      vscode.Uri.file(path.join(repoRoot, "src", "a.ts")),
      vscode.Uri.from({
        scheme: VSCODE_URI_SCHEMES.GIT,
        path: "/a",
        query: "not json",
      }),
    ];

    function editorCommitWhenClauses(): string[] {
      const manifest = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, "../../../package.json"),
          "utf8"
        )
      ) as {
        contributes: {
          menus: Record<string, { command?: string; when?: string }[]>;
        };
      };
      return Object.values(manifest.contributes.menus)
        .flat()
        .filter(
          (entry) =>
            entry.command ===
              VSCODE_COMMANDS.ADD_EDITOR_COMMIT_TO_PROMPT_EDITOR &&
            entry.when !== "false"
        )
        .map((entry) => entry.when ?? "");
    }

    test("resolves the commit from every editor shape that shows one", () => {
      for (const uri of commitUris(COMMIT.toUpperCase())) {
        assert.strictEqual(
          extractCommitHashFromEditorUri(uri),
          COMMIT,
          uri.toString()
        );
      }
    });

    test("rejects symbolic refs and non-git editors", () => {
      for (const uri of nonCommitUris) {
        assert.strictEqual(
          extractCommitHashFromEditorUri(uri),
          undefined,
          uri.toString()
        );
      }
    });

    test("the menu when clauses show exactly where a commit resolves", () => {
      const clauses = editorCommitWhenClauses();
      assert.ok(clauses.length >= 2, "expected title bar and tab menu entries");
      for (const clause of clauses) {
        const match = /^resource =~ \/(.+)\/$/.exec(clause);
        assert.ok(match, `unexpected when clause: ${clause}`);
        const pattern = new RegExp(match[1]);
        for (const uri of commitUris(COMMIT)) {
          assert.ok(pattern.test(uri.toString()), uri.toString());
        }
        for (const uri of nonCommitUris) {
          assert.ok(!pattern.test(uri.toString()), uri.toString());
        }
      }
    });

    test("inserts the commit reference for the menu's editor resource", async () => {
      const sink = new RecordingPromptEditorInsertSink();
      const workspaceRoot = createTestWorkspace();
      const checkedCommits: string[] = [];

      await createCommands(
        sink,
        workspaceRoot,
        undefined,
        undefined,
        undefined,
        async (checkedRoot, commitHash) => {
          assert.strictEqual(checkedRoot, workspaceRoot);
          checkedCommits.push(commitHash);
          return true;
        }
      ).addEditorCommitToPromptEditor(gitUri(COMMIT));

      assert.deepStrictEqual(checkedCommits, [COMMIT]);
      assert.deepStrictEqual(
        sink.requests.map((request) => request.references),
        [[buildGitReference(COMMIT)]]
      );
    });

    test("warns and inserts nothing for a commit outside the workspace repo", async () => {
      const sink = new RecordingPromptEditorInsertSink();
      const warnings: string[] = [];
      const originalShowWarningMessage = vscode.window.showWarningMessage;
      Object.defineProperty(vscode.window, "showWarningMessage", {
        configurable: true,
        value: ((message: string) => {
          warnings.push(message);
          return Promise.resolve(undefined);
        }) as unknown as typeof originalShowWarningMessage,
      });

      try {
        await createCommands(
          sink,
          createTestWorkspace(),
          undefined,
          undefined,
          undefined,
          async () => false
        ).addEditorCommitToPromptEditor(gitUri(COMMIT));
      } finally {
        Object.defineProperty(vscode.window, "showWarningMessage", {
          configurable: true,
          value: originalShowWarningMessage,
        });
      }

      assert.deepStrictEqual(warnings, [
        `ctrlyoke: Commit ${COMMIT.slice(0, 7)} is not in this workspace's repository, so a ~ reference can't attach it.`,
      ]);
      assert.strictEqual(sink.requests.length, 0);
    });

    test("inserts nothing for an editor without a commit", async () => {
      const sink = new RecordingPromptEditorInsertSink();

      await createCommands(
        sink,
        createTestWorkspace()
      ).addEditorCommitToPromptEditor(gitUri("~"));

      assert.strictEqual(sink.requests.length, 0);
    });
  });
});
