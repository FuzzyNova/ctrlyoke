import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { saveIfDirty } from "../../platform/VsCodeDocuments";

/** Poll until `condition` holds; false when `timeoutMs` passes first. */
async function waitUntil(
  condition: () => boolean,
  timeoutMs = 5_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/** What VS Code knows about `uri`, for a failure message. */
function describeEditorState(uri: vscode.Uri) {
  const key = uri.toString();
  return {
    activeEditorDocument:
      vscode.window.activeTextEditor?.document.uri.toString() ?? null,
    visibleEditorDocuments: vscode.window.visibleTextEditors.map((editor) =>
      editor.document.uri.toString()
    ),
    matchingOpenDocumentCount: vscode.workspace.textDocuments.filter(
      (openDocument) => openDocument.uri.toString() === key
    ).length,
    matchingTabs: vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs
        .filter(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === key
        )
        .map((tab) => ({ isDirty: tab.isDirty, isActive: tab.isActive }))
    ),
  };
}

suite("VsCodeDocuments", () => {
  test("saves an open dirty document", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-document-")
    );
    const filePath = path.join(directory, "workflow.md");
    let saveEventElapsedMs: number | undefined;
    let startedAt = 0;
    let saveListener: vscode.Disposable | undefined;
    try {
      await fs.writeFile(filePath, "before", "utf8");
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(filePath)
      );
      // Pin the document in an editor, as a user's dirty file would be. A
      // document opened only through openTextDocument is held by VS Code's
      // bounded hidden-model pool (50 references); under a sharded run other
      // tests' hidden opens evict it from workspace.textDocuments before
      // saveIfDirty looks it up.
      await vscode.window.showTextDocument(document, { preview: false });
      // An earlier suite's late editor close can still land; edit only once
      // this document is settled as the active editor's.
      assert.ok(
        await waitUntil(
          () =>
            vscode.window.activeTextEditor?.document.uri.toString() ===
            document.uri.toString()
        ),
        `document never became the active editor: ${JSON.stringify(
          describeEditorState(document.uri)
        )}`
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(0, 0, 0, document.lineAt(0).text.length),
        "after"
      );
      await vscode.workspace.applyEdit(edit);
      assert.strictEqual(document.isDirty, true);

      startedAt = Date.now();
      saveListener = vscode.workspace.onDidSaveTextDocument((savedDocument) => {
        if (savedDocument.uri.toString() === document.uri.toString()) {
          saveEventElapsedMs = Date.now() - startedAt;
        }
      });
      const stateBeforeSave = describeEditorState(document.uri);
      await saveIfDirty(filePath);

      const savedContents = await fs.readFile(filePath, "utf8");
      assert.strictEqual(
        savedContents,
        "after",
        `saveIfDirty did not persist the open document: ${JSON.stringify({
          filePath,
          elapsedMs: Date.now() - startedAt,
          documentIsDirty: document.isDirty,
          documentIsClosed: document.isClosed,
          stateBeforeSave,
          stateAfterSave: describeEditorState(document.uri),
          saveEventElapsedMs,
          savedContents,
        })}`
      );
    } finally {
      saveListener?.dispose();
      await vscode.commands.executeCommand(
        "workbench.action.revertAndCloseActiveEditor"
      );
      await fs
        .rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        })
        .catch(() => {});
    }
  });

  test("does not load a file that no editor has open", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-document-")
    );
    const filePath = path.join(directory, "closed.md");
    try {
      await fs.writeFile(filePath, "unchanged", "utf8");
      await saveIfDirty(filePath);
      const uri = vscode.Uri.file(filePath).toString();
      assert.deepStrictEqual(
        vscode.workspace.textDocuments
          .map((document) => document.uri.toString())
          .filter((openUri) => openUri === uri),
        []
      );
      assert.strictEqual(await fs.readFile(filePath, "utf8"), "unchanged");
    } finally {
      await fs
        .rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        })
        .catch(() => {});
    }
  });
});
