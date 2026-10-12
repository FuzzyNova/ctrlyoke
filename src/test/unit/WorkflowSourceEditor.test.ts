import * as assert from "assert";
import { parse as parseJsonc } from "jsonc-parser";
import { setWorkflowSourceTopLevelKey } from "../../utils/WorkflowSourceEditor";

suite("WorkflowSourceEditor", () => {
  test("sets a YAML key without changing comments, block scalars, or aliases", () => {
    const source = [
      "# Keep this workflow comment.",
      "defaults: &defaults",
      "  model: fast-model",
      "  prompt: |",
      "    This is a deliberately long prompt line that must not be folded or rewrapped by a source edit.",
      "steps:",
      "  - <<: *defaults",
      "    prompt: Run the inherited workflow.",
      "",
    ].join("\n");
    const expected = `${source}trustedExternalRoots:\n  - C:/external\n`;

    const edited = setWorkflowSourceTopLevelKey(
      source,
      "yaml",
      "trustedExternalRoots",
      ["C:/external"]
    );

    assert.strictEqual(edited, expected);
  });

  test("updates JSONC while retaining comments and four-space indentation", () => {
    const source = [
      "{",
      "    // Keep this comment.",
      '    "steps": [',
      '        { "prompt": "Run the workflow." }',
      "    ],",
      '    "trustedExternalRoots": ["C:/old"],',
      "}",
    ].join("\n");
    const expected = source.replace(
      '"trustedExternalRoots": ["C:/old"]',
      '"trustedExternalRoots": [\n        "C:/external"\n    ]'
    );

    const edited = setWorkflowSourceTopLevelKey(
      source,
      "json",
      "trustedExternalRoots",
      ["C:/external"]
    );

    assert.strictEqual(edited, expected);
    assert.deepStrictEqual(parseJsonc(edited), {
      steps: [{ prompt: "Run the workflow." }],
      trustedExternalRoots: ["C:/external"],
    });
  });
});
