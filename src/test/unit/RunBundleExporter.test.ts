/**
 * RunBundleExporter — the secrets half of export redaction.
 *
 * A run's own redactor is gone once it finishes, so export re-resolves the
 * secrets the definition grants and removes their current values (and their
 * JSON-escaped form, which harnesses print when they echo a config). The
 * path and heuristic halves are covered end to end in
 * `runReplay.integration.test.ts`.
 */
import * as assert from "assert";
import { suite, test } from "mocha";
import { resolveRunBundleSecrets } from "../../core/orchestration/RunBundleExporter";
import type { PromptFile } from "../../types/CtrlYokeTypes";

suite("RunBundleExporter secrets", () => {
  const definition = {
    secrets: ["DEMO_TOKEN"],
    steps: [{ prompt: "uses !STEP_ONLY_TOKEN" }, { prompt: "plain" }],
  } as unknown as PromptFile;

  test("resolves every granted secret, including inline grants", async () => {
    const values = await resolveRunBundleSecrets(definition, {
      workspaceRoot: process.cwd(),
      environment: { DEMO_TOKEN: 'abc"quoted', STEP_ONLY_TOKEN: "step-secret" },
    });
    assert.ok(values.includes('abc"quoted'));
    assert.ok(values.includes('abc\\"quoted'), "the JSON-escaped spelling too");
    assert.ok(values.includes("step-secret"));
  });

  test("skips a granted secret with no value on this machine", async () => {
    const values = await resolveRunBundleSecrets(definition, {
      workspaceRoot: process.cwd(),
      environment: { DEMO_TOKEN: "only-this-one" },
    });
    assert.deepStrictEqual(values, ["only-this-one"]);
  });
});
