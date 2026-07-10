import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import * as vscode from "vscode";
import {
  clearFilesCache,
  getFileCompletions,
  getHashSelectionCompletions,
  getPromptFileCompletions,
} from "../../completions/CompletionHelpers";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

suite("CompletionHelpers", () => {
  const originalFindFiles = vscode.workspace.findFiles;
  const originalAsRelativePath = vscode.workspace.asRelativePath;
  const originalVisibleTextEditors = vscode.window.visibleTextEditors;
  const originalShouldRespectGitignore =
    ConfigurationUtils.shouldRespectGitignoreForCompletions;

  // Install fake visible editors whose selections drive getHashSelectionCompletions.
  function mockSelections(
    selections: Array<{
      relativePath: string;
      startLine: number;
      endLine: number;
      text?: string;
    }>
  ): void {
    const workspaceRoot = path.join(os.tmpdir(), "ctrlyoke-completion-helpers");
    const pathByFsPath = new Map<string, string>();
    const editors = selections.map((sel) => {
      const uri = vscode.Uri.file(
        path.join(workspaceRoot, sel.relativePath.replace(/\//g, path.sep))
      );
      pathByFsPath.set(uri.fsPath, sel.relativePath);
      const selection = {
        isEmpty: false,
        start: { line: sel.startLine - 1 },
        end: { line: sel.endLine - 1 },
      };
      return {
        selection,
        document: {
          uri,
          getText: () => sel.text ?? "",
        },
      };
    });

    Object.defineProperty(vscode.workspace, "asRelativePath", {
      value: (uri: vscode.Uri) => pathByFsPath.get(uri.fsPath) ?? uri.fsPath,
      configurable: true,
    });
    Object.defineProperty(vscode.window, "visibleTextEditors", {
      value: editors,
      configurable: true,
    });
  }

  function mockWorkspaceFiles(relativePaths: string[]): void {
    const workspaceRoot = path.join(os.tmpdir(), "ctrlyoke-completion-helpers");
    const pathByFsPath = new Map<string, string>();
    const files = relativePaths.map((relativePath) => {
      const uri = vscode.Uri.file(
        path.join(workspaceRoot, relativePath.replace(/\//g, path.sep))
      );
      pathByFsPath.set(uri.fsPath, relativePath);
      return uri;
    });

    Object.defineProperty(vscode.workspace, "findFiles", {
      value: async () => files,
      configurable: true,
    });
    Object.defineProperty(vscode.workspace, "asRelativePath", {
      value: (uri: vscode.Uri) => pathByFsPath.get(uri.fsPath) ?? uri.fsPath,
      configurable: true,
    });
  }

  setup(() => {
    clearFilesCache();
    ConfigurationUtils.shouldRespectGitignoreForCompletions =
      (() => false) as typeof ConfigurationUtils.shouldRespectGitignoreForCompletions;
  });

  teardown(() => {
    clearFilesCache();
    Object.defineProperty(vscode.workspace, "findFiles", {
      value: originalFindFiles,
      configurable: true,
    });
    Object.defineProperty(vscode.workspace, "asRelativePath", {
      value: originalAsRelativePath,
      configurable: true,
    });
    Object.defineProperty(vscode.window, "visibleTextEditors", {
      value: originalVisibleTextEditors,
      configurable: true,
    });
    ConfigurationUtils.shouldRespectGitignoreForCompletions =
      originalShouldRespectGitignore;
  });

  test("matches @ completions against the typed directory and child prefix", async () => {
    mockWorkspaceFiles([
      "src/ui/webview-react/components/editor/CodeMirrorEditor.tsx",
      "src/ui/webview-react/components/editor/CodeMirrorTheme.ts",
      "src/ui/webview-react/components/editor/commands/CommandPalette.tsx",
      "src/ui/webview-react/components/workflow/WorkflowFilePickerModal.tsx",
    ]);

    const items = await getFileCompletions(
      "src/ui/webview-react/components/editor/Co"
    );
    const labels = items.map((item) => item.label);

    assert.ok(labels.includes("commands/"));
    assert.ok(labels.includes("CodeMirrorEditor.tsx"));
    assert.ok(labels.includes("CodeMirrorTheme.ts"));
    assert.ok(!labels.includes("CommandPalette.tsx"));
    assert.ok(!labels.includes("WorkflowFilePickerModal.tsx"));
  });

  test("matches @ completions fuzzily against a basename-only query", async () => {
    mockWorkspaceFiles([
      "src/ui/webview-react/components/editor/CodeMirrorEditor.tsx",
      "src/ui/webview-react/components/editor/CodeMirrorTheme.ts",
      "src/ui/webview-react/components/workflow/WorkflowFilePickerModal.tsx",
    ]);

    const items = await getFileCompletions("cme");
    const labels = items.map((item) => item.label);

    assert.ok(labels.includes("CodeMirrorEditor.tsx"));
    assert.ok(!labels.includes("CodeMirrorTheme.ts"));
    assert.ok(!labels.includes("WorkflowFilePickerModal.tsx"));
  });

  test("matches @ completions fuzzily within the typed directory segment", async () => {
    mockWorkspaceFiles([
      "src/ui/webview-react/components/editor/CodeMirrorEditor.tsx",
      "src/ui/webview-react/components/editor/CodeMirrorTheme.ts",
      "src/ui/webview-react/components/editor/commands/CommandPalette.tsx",
    ]);

    const items = await getFileCompletions(
      "src/ui/webview-react/components/editor/cme"
    );
    const labels = items.map((item) => item.label);

    assert.ok(labels.includes("CodeMirrorEditor.tsx"));
    assert.ok(!labels.includes("CodeMirrorTheme.ts"));
    assert.ok(!labels.includes("commands/"));
  });

  test("matches lone prompt-file path completions against the typed directory and child prefix", async () => {
    mockWorkspaceFiles([
      "prompts/seed.prompt.md",
      "prompts/setup.prompt.md",
      "prompts/sub/section.prompt.md",
      "docs/seed.md",
    ]);

    const items = await getPromptFileCompletions("./prompts/se");
    const labels = items.map((item) => item.label).sort();

    assert.deepStrictEqual(labels, ["seed.prompt.md", "setup.prompt.md"]);
  });

  test("matches lone prompt-file path completions fuzzily against the typed child name", async () => {
    mockWorkspaceFiles([
      "prompts/seed.prompt.md",
      "prompts/setup.prompt.md",
      "prompts/sub/section.prompt.md",
    ]);

    const items = await getPromptFileCompletions("./prompts/stpm");
    const labels = items.map((item) => item.label);

    assert.deepStrictEqual(labels, ["setup.prompt.md"]);
  });

  test("getHashSelectionCompletions returns the active selection with a top-bubbled sortText", () => {
    mockSelections([
      {
        relativePath: "src/foo.ts",
        startLine: 10,
        endLine: 20,
        text: "const x = 1;",
      },
    ]);

    const items = getHashSelectionCompletions();

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].insertText, "selection:src/foo.ts:10-20");
    // Prefixed with "0_" so selections bubble above the "1_" symbol items in
    // the merged getHashCompletions result.
    assert.ok(items[0].sortText?.startsWith("0_"));
  });

  test("getHashSelectionCompletions returns nothing when there is no selection", () => {
    mockSelections([]);

    assert.deepStrictEqual(getHashSelectionCompletions(), []);
  });
});
