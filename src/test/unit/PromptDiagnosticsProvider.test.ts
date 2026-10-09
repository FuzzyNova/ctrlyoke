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
  WORKFLOW_SCHEMA_DIAGNOSTIC_CODES,
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

  // Shown, not just opened. A document opened only through openTextDocument
  // sits in VS Code's bounded hidden-model pool (50 references), and under a
  // sharded run other tests' hidden opens can evict it from `textDocuments`,
  // which is the list a refresh trigger re-checks. An editor holds it open
  // until teardown closes all editors.
  async function open(name: string, content: string) {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, content);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
  }

  /**
   * Resolve once `uri`'s diagnostics satisfy `done`, re-checking on every
   * diagnostics change rather than on a clock. The deadline only bounds a
   * genuine hang, so it is generous; the rejection reports what was seen.
   */
  function waitForDiagnostics(
    uri: vscode.Uri,
    done: (diagnostics: readonly vscode.Diagnostic[]) => boolean,
    describe: () => string,
    timeoutMs = 60_000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (done(provider.getDiagnostics(uri))) finish();
      };
      const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
        if (
          event.uris.some((changed) => changed.toString() === uri.toString())
        ) {
          check();
        }
      });
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `diagnostics never settled within ${timeoutMs}ms: ${describe()}`
            )
          ),
        timeoutMs
      );
      function finish(error?: Error) {
        clearTimeout(timer);
        subscription.dispose();
        if (error) reject(error);
        else resolve();
      }
      check();
    });
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

  test("maps YAML schema diagnostics to their workflow path", async () => {
    provider.dispose();
    provider = new PromptDiagnosticsProvider(validator, {
      isYamlSchemaValidationSuppressed: () => false,
      validateWorkflowText: () => ({
        issues: [
          {
            instancePath: "/steps/0/prompt",
            message: "prompt is invalid",
            severity: "error",
          },
        ],
      }),
    });
    const document = await open(
      "schema.ctrlyoke.yaml",
      "steps:\n  - prompt: invalid value\n"
    );
    await provider.refresh(document);
    const [diagnostic] = provider.getDiagnostics(document.uri);
    assert.strictEqual(diagnostic.code, WORKFLOW_SCHEMA_DIAGNOSTIC_CODES.ERROR);
    assert.strictEqual(document.getText(diagnostic.range), "invalid value");
    assert.strictEqual(diagnostic.source, PROMPT_DIAGNOSTICS_SOURCE);
  });

  test("skips YAML schema diagnostics when Red Hat YAML is active", async () => {
    provider.dispose();
    provider = new PromptDiagnosticsProvider(validator, {
      isYamlSchemaValidationSuppressed: () => true,
      validateWorkflowText: () => ({
        issues: [
          {
            instancePath: "/steps/0/prompt",
            message: "prompt is invalid",
            severity: "error",
          },
        ],
      }),
    });
    const document = await open(
      "schema.ctrlyoke.yaml",
      "steps:\n  - prompt: valid\n"
    );
    await provider.refresh(document);
    assert.deepStrictEqual(provider.getDiagnostics(document.uri), []);
  });

  test("does not add ctrlyoke schema diagnostics to JSON workflows", async () => {
    provider.dispose();
    provider = new PromptDiagnosticsProvider(validator, {
      isYamlSchemaValidationSuppressed: () => false,
      validateWorkflowText: () => ({
        issues: [
          {
            instancePath: "/steps/0/prompt",
            message: "prompt is invalid",
            severity: "error",
          },
        ],
      }),
    });
    const document = await open(
      "schema.ctrlyoke.json",
      '{"steps":[{"prompt":"valid"}]}'
    );
    await provider.refresh(document);
    assert.deepStrictEqual(provider.getDiagnostics(document.uri), []);
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

  test("re-checks open files when a refresh trigger fires, until disposed", async function () {
    // Above the suite default on purpose: waitForDiagnostics carries its own
    // 60s bound so that a hang fails with what it saw, not a bare timeout.
    this.timeout(90_000);
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
    // The trigger's refresh is debounced; wait for it to publish rather than
    // for a fixed time. A refresh only re-checks `textDocuments`, so a miss
    // says whether the document was in it (and how big it was: a stubbed,
    // never-restored list is how this test once failed).
    await waitForDiagnostics(
      document.uri,
      (diagnostics) => diagnostics.length === 0,
      () =>
        `still flagged after the refresh trigger fired; in textDocuments: ${vscode.workspace.textDocuments.includes(document)} (of ${vscode.workspace.textDocuments.length})`
    );

    provider.dispose();
    assert.strictEqual(subscribed, 0, "dispose unsubscribes every trigger");
  });
});
