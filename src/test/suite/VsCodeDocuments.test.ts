import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { saveIfDirty } from "../../platform/VsCodeDocuments";

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
      await saveIfDirty(filePath);

      const savedContents = await fs.readFile(filePath, "utf8");
      assert.strictEqual(
        savedContents,
        "after",
        `saveIfDirty did not persist the open document: ${JSON.stringify({
          filePath,
          elapsedMs: Date.now() - startedAt,
          documentIsDirty: document.isDirty,
          matchingOpenDocumentCount: vscode.workspace.textDocuments.filter(
            (openDocument) =>
              openDocument.uri.toString() === document.uri.toString()
          ).length,
          saveEventElapsedMs,
          savedContents,
        })}`
      );
    } finally {
      saveListener?.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
