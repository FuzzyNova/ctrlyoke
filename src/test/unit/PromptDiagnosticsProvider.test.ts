import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import * as vscode from "vscode";
import {
  PromptDiagnosticsProvider,
  type PromptDiagnosticsRefreshTrigger,
  type PromptReferenceValidator,
} from "../../completions/PromptDiagnosticsProvider";
import {
  PROMPT_DIAGNOSTIC_CODES,
  PROMPT_DIAGNOSTICS_SOURCE,
} from "../../types/DashboardConstants";

const validator: PromptReferenceValidator = async (references) =>
  references.map((reference) => ({
    id: reference.id,
    exists: !reference.path?.includes("missing"),
    message: "file not found",
  }));

suite("PromptDiagnosticsProvider", () => {
  let tempDir: string;
  let provider: PromptDiagnosticsProvider;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-diag-"));
    provider = new PromptDiagnosticsProvider(validator);
  });

  teardown(async () => {
    provider.dispose();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });
  });

  async function open(name: string, content: string) {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, content);
    return vscode.workspace.openTextDocument(file);
  }

  test("publishes diagnostics for a missing reference and a missing step", async () => {
    const document = await open(
      "case.ctrlyoke.yaml",
      "steps:\n  - prompt: read @missing.ts then $step:9\n"
    );
    await provider.refresh(document);

    const diagnostics = provider.getDiagnostics(document.uri);
    assert.deepStrictEqual(
      diagnostics.map((d) => [d.code, document.getText(d.range)]),
      [
        [PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_STEP_MISSING, "$step:9"],
        [PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE, "@missing.ts"],
      ]
    );
    assert.ok(
      diagnostics.every((d) => d.source === PROMPT_DIAGNOSTICS_SOURCE),
      "every diagnostic carries the ctrlyoke source"
    );
  });

  test("ignores files that are not ctrlyoke files", async () => {
    const document = await open("notes.md", "see @missing.ts\n");
    await provider.refresh(document);
    assert.deepStrictEqual(provider.getDiagnostics(document.uri), []);
  });

  test("re-checks after an edit and drops diagnostics that no longer apply", async () => {
    const document = await open("case.prompt.md", "see @missing.ts\n");
    await provider.refresh(document);
    assert.strictEqual(provider.getDiagnostics(document.uri).length, 1);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      "see @present.ts\n"
    );
    await vscode.workspace.applyEdit(edit);
    await provider.refresh(document);
    assert.deepStrictEqual(provider.getDiagnostics(document.uri), []);
  });

  test("re-checks open files when a refresh trigger fires, until disposed", async () => {
    // Stands in for a trust decision or settings write that makes a
    // previously unresolvable reference resolve.
    let trusted = false;
    let subscribed = 0;
    let fire: (() => void) | undefined;
    const trigger: PromptDiagnosticsRefreshTrigger = (listener) => {
      subscribed++;
      fire = listener;
      return () => {
        subscribed--;
        fire = undefined;
      };
    };
    provider.dispose();
    provider = new PromptDiagnosticsProvider(
      async (references) =>
        references.map((reference) => ({
          id: reference.id,
          exists: trusted,
          message: "outside approved roots",
        })),
      { refreshTriggers: [trigger] }
    );
    assert.strictEqual(subscribed, 1);

    const document = await open("case.prompt.md", "see @external.ts\n");
    await provider.refresh(document);
    assert.strictEqual(provider.getDiagnostics(document.uri).length, 1);

    trusted = true;
    fire?.();
    const deadline = Date.now() + 10_000;
    while (
      provider.getDiagnostics(document.uri).length > 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepStrictEqual(
      provider.getDiagnostics(document.uri),
      [],
      `still flagged after the refresh trigger fired; document still open: ${vscode.workspace.textDocuments.includes(document)}, closed: ${document.isClosed}`
    );

    provider.dispose();
    assert.strictEqual(subscribed, 0, "dispose unsubscribes every trigger");
  });
});
