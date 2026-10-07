import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as vscode from "vscode";
import { suite, setup, teardown, test } from "mocha";
import {
  CompletionCore,
  mapSymbolKindToReferenceKind,
} from "../../completions/CompletionCore";
import type { CompletionWorkspace } from "../../completions/CompletionCore";
import type { EditorContextSource } from "../../completions/EditorContextSource";
import type { IndexedSymbol, SymbolIndex } from "../../completions/SymbolIndex";
import { LspSymbolKind } from "../../completions/SymbolIndex";
import { VsCodeSymbolIndex } from "../../platform/VsCodeSymbolIndex";
import { RegexSymbolIndex } from "../../completions/RegexSymbolIndex";
import { toVSCodeCompletionItem } from "../../completions/CompletionHelpers";
import {
  symbolCompletionGolden,
  symbolCompletionGoldenResult,
} from "../fixtures/SymbolCompletionGolden";
import {
  COMPLETION_KIND_ICONS,
  SYMBOL_KIND_ICONS,
} from "../../types/SymbolKindConstants";
import {
  CAPTURING_OUTPUT_PLACEHOLDER,
  GIT_CHANGE_KINDS,
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
  WORKSPACE_ENTRY_KINDS,
} from "../../types/DashboardConstants";

function createCore(
  options: {
    files?: string[];
    multiRoot?: boolean;
    symbols?: SymbolIndex;
    editorContext?: EditorContextSource;
  } = {}
): CompletionCore {
  const workspace: CompletionWorkspace = {
    getFiles: async () => options.files ?? [],
    isMultiRoot: () => options.multiRoot ?? false,
    symbols: options.symbols,
    editorContext: options.editorContext,
  };
  return new CompletionCore(workspace);
}

function makeSymbol(
  name: string,
  viewerPath: string,
  kind = LspSymbolKind.Function,
  startLine = 1,
  endLine = 3
): IndexedSymbol {
  return { name, kind, viewerPath, startLine, endLine };
}

suite("CompletionCore", () => {
  test("keeps the #sym insertion and dashboard icon kind stable", async () => {
    const core = createCore({
      symbols: {
        workspaceSymbols: async () => [symbolCompletionGolden],
        documentSymbols: async () => [symbolCompletionGolden],
      },
    });
    const item = (await core.getHashCompletions("Wid"))[0];
    assert.strictEqual(
      item.insertText,
      symbolCompletionGoldenResult.insertText
    );
    assert.strictEqual(item.kind, symbolCompletionGoldenResult.completionKind);
    assert.strictEqual(
      COMPLETION_KIND_ICONS[item.kind],
      symbolCompletionGoldenResult.icon
    );
  });

  test("maps all LSP SymbolKind values to the renderer vocabulary", () => {
    for (const value of Object.values(LspSymbolKind).filter(
      (x): x is number => typeof x === "number"
    )) {
      const kind = mapSymbolKindToReferenceKind(value as LspSymbolKind);
      assert.ok(kind, `missing name for LSP kind ${value}`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(SYMBOL_KIND_ICONS, kind),
        `missing renderer icon for ${kind}`
      );
    }
  });

  test("returns unique secret names without values and applies fuzzy filtering", () => {
    const items = createCore().getSecretCompletions(
      ["ZETA_TOKEN", "ALPHA_TOKEN", "ZETA_TOKEN"],
      "token"
    );
    assert.deepStrictEqual(
      items.map(({ label, insertText }) => ({ label, insertText })),
      [
        { label: "ALPHA_TOKEN", insertText: "ALPHA_TOKEN" },
        { label: "ZETA_TOKEN", insertText: "ZETA_TOKEN" },
      ]
    );
    assert.ok(items.every((item) => !("value" in item)));
    assert.ok(items.every((item) => item.kind === 5 && item.icon === "key"));
  });

  test("offers condition-output prior-context completions and filters fuzzily", () => {
    const core = createCore();
    const items = core.getPriorContextCompletions("");
    const phases = [
      SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
      SCRIPT_OUTPUT_SOURCES.END_CONDITION,
    ];
    const conditions = items.filter((item) =>
      phases.some((phase) => item.label.startsWith(`${phase}:`))
    );
    const expected = phases.flatMap((phase) =>
      Object.values(RETRY_PROMPT_PLACEHOLDERS).map(
        (field) => `${phase}:${field}`
      )
    );
    assert.deepStrictEqual(
      conditions.map((item) => item.label),
      expected
    );
    assert.ok(conditions.every((item) => item.detail?.includes("script")));
    assert.deepStrictEqual(
      core
        .getPriorContextCompletions("endcondition:exit")
        .map((item) => item.label),
      [
        `${SCRIPT_OUTPUT_SOURCES.END_CONDITION}:${RETRY_PROMPT_PLACEHOLDERS.EXIT_CODE}`,
      ]
    );
  });

  test("matches @ completions inside a typed directory, including direct child directories", async () => {
    const core = createCore({
      files: [
        "src/ui/editor/CodeMirrorEditor.tsx",
        "src/ui/editor/CodeMirrorTheme.ts",
        "src/ui/editor/commands/CommandPalette.tsx",
        "src/ui/workflow/Picker.tsx",
      ],
    });
    const labels = (await core.getFileCompletions("src/ui/editor/Co")).map(
      (item) => item.label
    );
    assert.ok(labels.includes("commands/"));
    assert.ok(labels.includes("CodeMirrorEditor.tsx"));
    assert.ok(labels.includes("CodeMirrorTheme.ts"));
    assert.ok(!labels.includes("CommandPalette.tsx"));
    assert.ok(!labels.includes("Picker.tsx"));
  });

  test("lists directories before files for an unfiltered @ completion", async () => {
    const items = await createCore({
      files: ["src/z.ts", "README.md"],
    }).getFileCompletions("");
    assert.strictEqual(items[0]?.label, "src/");
    assert.ok(
      items.findIndex((item) => item.label === "src/") <
        items.findIndex((item) => item.label === "README.md")
    );
  });

  test("preserves folder prefixes for file completions in a multi-root workspace", async () => {
    const items = await createCore({
      files: ["root2/src/index.ts"],
      multiRoot: true,
    }).getFileCompletions("root2/src/i");
    assert.strictEqual(items[0]?.insertText, "root2/src/index.ts");
  });

  test("ranks @ matches fuzzily by basename, including camelCase gaps", async () => {
    const files = [
      "src/ui/editor/CodeMirrorTheme.ts",
      "src/workflow/WorkflowFilePickerModal.tsx",
      "src/ui/editor/CodeMirrorEditor.tsx",
    ];
    const core = createCore({ files });
    const ranked = await core.getFileCompletions("cme");
    assert.strictEqual(ranked[0]?.label, "CodeMirrorEditor.tsx");
    assert.deepStrictEqual(
      ranked.map((item) => item.rank),
      ranked.map((_, index) => index)
    );
    assert.deepStrictEqual(
      (await createCore({ files }).getFileCompletions("codeeditor")).map(
        (item) => item.label
      ),
      ["CodeMirrorEditor.tsx"]
    );
  });

  test("ranks file matches before applying the cap", async () => {
    const noise = Array.from(
      { length: 600 },
      (_, index) => `aaa/editor-fixtures/case${index}.ts`
    );
    const items = await createCore({
      files: [...noise, "zzz/ui/components/editor/CodeMirrorEditor.tsx"],
    }).getFileCompletions("codemirroreditor");
    assert.strictEqual(items[0]?.label, "CodeMirrorEditor.tsx");
    assert.ok(items.length <= 500);
  });

  test("ranks matching children within the typed directory", async () => {
    const items = await createCore({
      files: [
        "src/ui/editor/CodeMirrorTheme.ts",
        "src/ui/editor/CodeMirrorEditor.tsx",
        "src/ui/editor/commands/CommandPalette.tsx",
      ],
    }).getFileCompletions("src/ui/editor/cme");
    assert.strictEqual(items[0]?.label, "CodeMirrorEditor.tsx");
    assert.ok(
      !items.some(
        (item) =>
          item.label === "commands/" || item.label === "CommandPalette.tsx"
      )
    );
  });

  test("keeps standalone prompt paths folder-qualified in multi-root workspaces", async () => {
    const files = ["other/.ctrlyoke/prompts/current.prompt.md"];
    const items = await createCore({
      files,
      multiRoot: true,
    }).getPromptFileCompletions("other/.ctrlyoke/prompts/cu");
    assert.strictEqual(
      items[0]?.insertText,
      "other/.ctrlyoke/prompts/current.prompt.md"
    );
  });

  test("matches prompt files by typed directory and fuzzy child name", async () => {
    const files = [
      "prompts/seed.prompt.md",
      "prompts/setup.prompt.md",
      "prompts/sub/section.prompt.md",
      "docs/seed.md",
    ];
    const core = createCore({ files });
    assert.deepStrictEqual(
      (await core.getPromptFileCompletions("./prompts/se"))
        .map((item) => item.label)
        .sort(),
      ["seed.prompt.md", "setup.prompt.md"]
    );
    assert.deepStrictEqual(
      (
        await createCore({ files }).getPromptFileCompletions("./prompts/stpm")
      ).map((item) => item.label),
      ["setup.prompt.md"]
    );
    assert.ok(
      (await core.getPromptFileCompletions("")).every(
        (item) => item.kind === 16
      )
    );
  });

  test("builds selection items from the editor context and deduplicates them", () => {
    const editorContext: EditorContextSource = {
      getSelections: () => [
        {
          viewerPath: "src/foo.ts",
          startLine: 10,
          endLine: 20,
          text: "const x = 1;",
          isOutput: false,
        },
        {
          viewerPath: "src/foo.ts",
          startLine: 10,
          endLine: 20,
          text: "duplicate",
          isOutput: false,
        },
      ],
      getVisibleOutputChannels: () => [],
    };
    const items = createCore({ editorContext }).getHashSelectionCompletions();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].insertText, "selection:src/foo.ts:10-20");
    assert.ok(items[0].sortText?.startsWith("0_"));
    assert.strictEqual(items[0].kind, 10);
    assert.strictEqual(items[0].captureId, undefined);
  });

  test("returns no selection completion when editor context has no selections", () => {
    const editorContext: EditorContextSource = {
      getSelections: () => [],
      getVisibleOutputChannels: () => [],
    };
    assert.deepStrictEqual(
      createCore({ editorContext }).getHashSelectionCompletions(),
      []
    );
  });

  test("captures selected output lines as a deferred snapshot", () => {
    const editorContext: EditorContextSource = {
      getSelections: () => [
        {
          viewerPath: "agenthost",
          outputChannel: "agenthost",
          startLine: 17,
          endLine: 18,
          text: "line 17\nline 18",
          isOutput: true,
          captureId: "capture-selection",
          visibleEditorCount: 2,
        },
      ],
      getVisibleOutputChannels: () => [],
    };
    const [item] = createCore({ editorContext }).getHashSelectionCompletions();
    assert.strictEqual(item.label, "selection: agenthost (lines 17-18)");
    assert.strictEqual(item.insertText, CAPTURING_OUTPUT_PLACEHOLDER);
    assert.strictEqual(item.captureId, "capture-selection");
    assert.ok(!item.insertText.includes("#selection:"));
  });

  test("filters selections and combines symbol candidates from full and short-prefix queries", async () => {
    const queries: string[] = [];
    const candidates = [
      makeSymbol("useCallbackRef", "src/hooks.ts"),
      makeSymbol("useFinalStepContextMenu", "src/hooks.ts"),
      makeSymbol("useContextPct", "src/hooks.ts"),
    ];
    const symbols: SymbolIndex = {
      workspaceSymbols: async (query) => {
        queries.push(query);
        return candidates.filter((candidate) =>
          `${candidate.containerName ?? ""}.${candidate.name}`
            .toLowerCase()
            .includes(query.toLowerCase())
        );
      },
      documentSymbols: async () => [],
    };
    const editorContext: EditorContextSource = {
      getSelections: () => [
        {
          viewerPath: "src/foo.ts",
          startLine: 10,
          endLine: 20,
          text: "",
          isOutput: false,
        },
      ],
      getVisibleOutputChannels: () => [],
    };
    const items = await createCore({
      symbols,
      editorContext,
    }).getHashCompletions("usecontext");
    const labels = items.map((item) => item.label);
    assert.deepStrictEqual(queries.sort(), ["use", "usecontext"]);
    assert.ok(labels.includes("useFinalStepContextMenu"));
    assert.ok(labels.includes("useContextPct"));
    assert.ok(!labels.includes("useCallbackRef"));
    assert.ok(!labels.includes("selection: Current Selection"));
    assert.deepStrictEqual(
      items.map((item) => item.rank),
      items.map((_, index) => index)
    );
    assert.strictEqual(
      (await createCore({ symbols, editorContext }).getHashCompletions("sel"))
        .length,
      1
    );
  });

  test("retains provider matches that fuzzy ranking cannot see", async () => {
    const symbols: SymbolIndex = {
      workspaceSymbols: async (query) =>
        query === "Container.member"
          ? [makeSymbol("member", "src/member.ts")]
          : [],
      documentSymbols: async () => [],
    };
    assert.deepStrictEqual(
      (
        await createCore({ symbols }).getHashCompletions("Container.member")
      ).map((item) => item.label),
      ["member"]
    );
  });

  test("adds visible output channels to @ completions with deferred capture data", async () => {
    const editorContext: EditorContextSource = {
      getSelections: () => [],
      getVisibleOutputChannels: () => [
        {
          viewerPath: "agenthost",
          channel: "agenthost",
          text: "latest output",
          captureId: "capture-agenthost",
        },
      ],
    };
    const item = (
      await createCore({ editorContext }).getFileCompletions("")
    )[0];
    assert.strictEqual(item.label, "agenthost (Output)");
    assert.strictEqual(item.insertText, CAPTURING_OUTPUT_PLACEHOLDER);
    assert.strictEqual(item.captureId, "capture-agenthost");
    assert.ok(!item.insertText.includes("agenthost"));
  });

  test("suggests corrected paths by same-directory tier, basename, and requested cap", async () => {
    const core = createCore({
      files: [
        "src/editor/CodeMirrorEditor.tsx",
        "src/editor/CodeMirrorTheme.ts",
      ],
    });
    assert.deepStrictEqual(
      await core.getPathSuggestions(
        "src/editor/CodeMirrorEditor.tsxfoo",
        WORKSPACE_ENTRY_KINDS.FILE
      ),
      ["@src/editor/CodeMirrorEditor.tsx"]
    );
    assert.deepStrictEqual(
      await core.getPathSuggestions(
        "src/editor/CodeMirrorEdi",
        WORKSPACE_ENTRY_KINDS.FILE
      ),
      ["@src/editor/CodeMirrorEditor.tsx"]
    );
    assert.deepStrictEqual(
      await createCore({
        files: ["src/a/Button.tsx", "src/z/Button.ts"],
      }).getPathSuggestions("src/a/Button.ts", WORKSPACE_ENTRY_KINDS.FILE),
      ["@src/a/Button.tsx", "@src/z/Button.ts"]
    );
    assert.deepStrictEqual(
      await createCore({
        files: [
          "src/ui/components/CodeMirrorEditor.tsx",
          "src/unrelated/Other.ts",
        ],
      }).getPathSuggestions(
        "src/old/path/CodeMirrorEditor.tsx",
        WORKSPACE_ENTRY_KINDS.FILE
      ),
      ["@src/ui/components/CodeMirrorEditor.tsx"]
    );
    assert.deepStrictEqual(
      await core.getPathSuggestions(
        "src/c/Zzzzz.md",
        WORKSPACE_ENTRY_KINDS.FILE
      ),
      []
    );
    assert.strictEqual(
      (
        await createCore({
          files: [
            "src/a/Report1.ts",
            "src/a/Report2.ts",
            "src/a/Report3.ts",
            "src/a/Report4.ts",
          ],
        }).getPathSuggestions("src/a/Report", WORKSPACE_ENTRY_KINDS.FILE, 3)
      ).length,
      3
    );
  });

  test("suggests the corrected directory for a mistyped directory reference", async () => {
    const core = createCore({
      files: ["src/ui/webview-react/components/editor/CodeMirrorEditor.tsx"],
    });
    assert.ok(
      (
        await core.getPathSuggestions(
          "src/ui/webview-react/components/edito/",
          WORKSPACE_ENTRY_KINDS.DIRECTORY
        )
      ).includes("@src/ui/webview-react/components/editor/")
    );
  });

  test("resolves reference kinds by exact symbol name and range from document then workspace index", async () => {
    const classSymbol = makeSymbol(
      "Outer",
      "src/a.ts",
      LspSymbolKind.Class,
      1,
      10
    );
    const method = makeSymbol("method", "src/a.ts", LspSymbolKind.Method, 3, 4);
    const workspaceOnly = makeSymbol(
      "--safe-area-bottom",
      "src/a.ts",
      LspSymbolKind.Property,
      80,
      80
    );
    const symbols: SymbolIndex = {
      documentSymbols: async () => [classSymbol, method],
      workspaceSymbols: async () => [workspaceOnly],
    };
    const core = createCore({ symbols });
    assert.strictEqual(
      await core.findSymbolKindForReference("src/a.ts", "method", 3, 4),
      1
    );
    assert.strictEqual(
      await core.findSymbolKindForReference(
        "src/a.ts",
        "--safe-area-bottom",
        80,
        80
      ),
      9
    );
    assert.strictEqual(
      await core.findSymbolKindForReference("src/b.ts", "method", 3, 4),
      undefined
    );
    assert.strictEqual(
      await core.findSymbolKindForReference("src/a.ts", "method", 3, 5),
      undefined
    );
  });
});

suite("CompletionCore git change completions", function () {
  let workspaceRoot: string;
  function runGit(args: string[]): string {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  }
  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-git-completions-")
    );
    runGit(["init"]);
    runGit(["config", "user.name", "Completion Author"]);
    runGit(["config", "user.email", "completion@example.com"]);
    await fs.writeFile(path.join(workspaceRoot, "initial.txt"), "initial\n");
    runGit(["add", "initial.txt"]);
    runGit(["commit", "-m", "unrelated commit subject"]);
  });
  teardown(async () => {
    await fs.rm(workspaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  test("keeps recent commits available by hash and author", async () => {
    const core = createCore();
    const hash = runGit(["rev-parse", "HEAD"]);
    assert.strictEqual(
      (
        await core.getGitChangeCompletions(workspaceRoot, hash.slice(0, 8))
      ).filter((item) => item.insertText === hash).length,
      1
    );
    assert.ok(
      (
        await core.getGitChangeCompletions(workspaceRoot, "Completion Author")
      ).some((item) => item.insertText === hash)
    );
  });

  test("includes git change icons and searches hashes outside the recent commit cache", async () => {
    await fs.writeFile(path.join(workspaceRoot, "initial.txt"), "changed\n");
    runGit(["stash"]);
    const olderHash = runGit(["rev-parse", "HEAD"]);
    const items = await createCore().getGitChangeCompletions(workspaceRoot, "");
    const iconFor = (insertText: string) =>
      items.find((item) => item.insertText === insertText)?.icon;
    assert.strictEqual(iconFor(GIT_CHANGE_KINDS.DIFF), "git-branch-changes");
    assert.strictEqual(
      iconFor(GIT_CHANGE_KINDS.STAGED),
      "git-branch-staged-changes"
    );
    assert.strictEqual(iconFor(`${GIT_CHANGE_KINDS.STASH}:0`), "git-stash");
    assert.ok(items.some((item) => item.insertText === olderHash));
    assert.strictEqual(iconFor(olderHash), "git-commit");
    for (let index = 0; index < 50; index++)
      runGit(["commit", "--allow-empty", "-m", `later commit ${index}`]);
    assert.ok(
      (
        await createCore().getGitChangeCompletions(
          workspaceRoot,
          olderHash.slice(0, 8)
        )
      ).some((item) => item.insertText === olderHash)
    );
  });
});

suite("VsCodeSymbolIndex completion golden", () => {
  const originalExecuteCommand = vscode.commands.executeCommand;
  const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
  const originalGetConfiguration = vscode.workspace.getConfiguration;
  setup(() => {
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: [
        {
          name: "workspace",
          uri: vscode.Uri.file(path.join(os.tmpdir(), "symbol-golden")),
          index: 0,
        },
      ],
    });
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: () => ({ get: (_key: string, fallback: string) => fallback }),
    });
  });
  teardown(() => {
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: originalExecuteCommand,
    });
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: originalWorkspaceFolders,
    });
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: originalGetConfiguration,
    });
  });

  test("converts a VS Code Class symbol through LSP numbering to the legacy insertion and kind", async () => {
    const root = path.join(os.tmpdir(), "symbol-golden");
    const symbol = new vscode.SymbolInformation(
      "Widget",
      vscode.SymbolKind.Class,
      "",
      new vscode.Location(
        vscode.Uri.file(path.join(root, "src", "Widget.ts")),
        new vscode.Range(3, 0, 17, 0)
      )
    );
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: ((command: string) =>
        command === "vscode.executeWorkspaceSymbolProvider"
          ? Promise.resolve([symbol])
          : Promise.resolve(undefined)) as typeof originalExecuteCommand,
    });
    const core = createCore({ symbols: new VsCodeSymbolIndex() });
    const [plain] = await core.getHashCompletions("Wid");
    const native = toVSCodeCompletionItem(plain, "#");
    assert.strictEqual(
      plain.insertText,
      symbolCompletionGoldenResult.insertText
    );
    assert.strictEqual(plain.kind, symbolCompletionGoldenResult.completionKind);
    assert.strictEqual(
      COMPLETION_KIND_ICONS[plain.kind],
      symbolCompletionGoldenResult.icon
    );
    assert.strictEqual(native.kind, vscode.CompletionItemKind.Class);
  });

  test("indexes the shared #sym golden with RegexSymbolIndex", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "symbol-regex-golden-")
    );
    const source = [
      "// fixture",
      "",
      "",
      "export class Widget {",
      "  first() {",
      "    return 1;",
      "  }",
      "",
      "  second() {",
      "    return 2;",
      "  }",
      "",
      "  third() {",
      "    return 3;",
      "  }",
      "",
      "  value = 4;",
      "}",
    ].join("\n");
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "Widget.ts"), source);
      const symbols = new RegexSymbolIndex(root, async () => ["src/Widget.ts"]);
      const core = createCore({ symbols });
      const [item] = await core.getHashCompletions("Wid");
      assert.strictEqual(
        item.insertText,
        symbolCompletionGoldenResult.insertText
      );
      assert.strictEqual(
        item.kind,
        symbolCompletionGoldenResult.completionKind
      );
      assert.strictEqual(
        COMPLETION_KIND_ICONS[item.kind],
        symbolCompletionGoldenResult.icon
      );
      assert.ok(
        (await symbols.documentSymbols("src/Widget.ts")).some(
          (symbol) =>
            symbol.name === symbolCompletionGolden.name &&
            symbol.kind === symbolCompletionGolden.kind &&
            symbol.viewerPath === symbolCompletionGolden.viewerPath &&
            symbol.startLine === symbolCompletionGolden.startLine &&
            symbol.endLine === symbolCompletionGolden.endLine
        )
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("indexes nested document symbols for reference-kind lookup", async () => {
    const root = path.join(os.tmpdir(), "symbol-golden");
    const range = new vscode.Range(0, 0, 9, 0);
    const methodRange = new vscode.Range(5, 0, 6, 0);
    const method = new vscode.DocumentSymbol(
      "run",
      "",
      vscode.SymbolKind.Method,
      methodRange,
      methodRange
    );
    const parent = new vscode.DocumentSymbol(
      "Widget",
      "",
      vscode.SymbolKind.Class,
      range,
      range
    );
    parent.children = [method];
    let requestedPath: string | undefined;
    Object.defineProperty(vscode.commands, "executeCommand", {
      configurable: true,
      value: ((command: string, uri?: vscode.Uri) => {
        if (command === "vscode.executeDocumentSymbolProvider") {
          requestedPath = uri?.fsPath;
          return Promise.resolve([parent]);
        }
        return Promise.resolve([]);
      }) as typeof originalExecuteCommand,
    });
    const core = createCore({ symbols: new VsCodeSymbolIndex() });
    assert.strictEqual(
      await core.findSymbolKindForReference("src/Widget.ts", "run", 6, 7),
      vscode.CompletionItemKind.Method
    );
    assert.strictEqual(
      requestedPath?.toLowerCase(),
      path.join(root, "src", "Widget.ts").toLowerCase()
    );
  });
});
