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

  test("preserves CRLF and four-space indentation when appending the key", () => {
    const source = ["steps:", "    - prompt: run", ""].join("\r\n");
    const edited = setWorkflowSourceTopLevelKey(
      source,
      "yaml",
      "trustedExternalRoots",
      ["C:/external"]
    );

    assert.strictEqual(
      edited,
      `${source}trustedExternalRoots:\r\n    - C:/external\r\n`
    );
  });

  test("keeps an unindented sequence and multiple blank lines byte-identical", () => {
    const source = "steps:\n- prompt: run\n\n\n# Keep this ending.\n";
    const edited = setWorkflowSourceTopLevelKey(
      source,
      "yaml",
      "trustedExternalRoots",
      ["C:/external"]
    );

    assert.strictEqual(
      edited,
      `${source}trustedExternalRoots:\n- C:/external\n`
    );
  });

  test("preserves a YAML BOM and all original source when appending", () => {
    const source = "\uFEFFsteps:\n  - prompt: run\n";
    const edited = setWorkflowSourceTopLevelKey(
      source,
      "yaml",
      "trustedExternalRoots",
      ["C:/external"]
    );

    assert.strictEqual(
      edited,
      `${source}trustedExternalRoots:\n  - C:/external\n`
    );
  });

  test("replaces only a block-style YAML value", () => {
    const source = "steps: []\ntrustedExternalRoots:\n  - C:/old\n# keep\n";
    const expected = source.replace("  - C:/old", "  - C:/external");
    const edited = setWorkflowSourceTopLevelKey(
      source,
      "yaml",
      "trustedExternalRoots",
      ["C:/external"]
    );

    assert.strictEqual(edited, expected);
  });

  test("replaces a flow-style YAML value and retains its trailing comment", () => {
    const source =
      "steps: []\ntrustedExternalRoots: [C:/old] # keep this comment\n";
    const edited = setWorkflowSourceTopLevelKey(
      source,
      "yaml",
      "trustedExternalRoots",
      ["C:/external"]
    );

    assert.strictEqual(
      edited,
      "steps: []\ntrustedExternalRoots: [ C:/external ] # keep this comment\n"
    );
  });

  test("adds a missing key inside a flow-style YAML root", () => {
    const source = "{steps: []}\n";
    const edited = setWorkflowSourceTopLevelKey(
      source,
      "yaml",
      "trustedExternalRoots",
      ["C:/external"]
    );

    assert.strictEqual(
      edited,
      "{steps: [], trustedExternalRoots: [ C:/external ]}\n"
    );
  });

  test("fills an empty or scalar YAML value with a flow sequence on the key's line", () => {
    for (const [source, expected] of [
      [
        "name: x\r\ntrustedExternalRoots:\r\nsteps: []\r\n",
        "name: x\r\ntrustedExternalRoots: [ C:/external ]\r\nsteps: []\r\n",
      ],
      [
        "trustedExternalRoots: ~ # none\nsteps: []\n",
        "trustedExternalRoots: [ C:/external ] # none\nsteps: []\n",
      ],
    ]) {
      const edited = setWorkflowSourceTopLevelKey(
        source!,
        "yaml",
        "trustedExternalRoots",
        ["C:/external"]
      );
      assert.strictEqual(edited, expected);
    }
  });

  test("preserves a JSON BOM while parsing and editing the source", () => {
    const source = '\uFEFF{\n  "steps": []\n}';
    const expected =
      '\uFEFF{\n  "steps": [],\n  "trustedExternalRoots": [\n    "C:/external"\n  ]\n}';
    const edited = setWorkflowSourceTopLevelKey(
      source,
      "json",
      "trustedExternalRoots",
      ["C:/external"]
    );

    assert.ok(edited.startsWith("\uFEFF"));
    assert.strictEqual(edited, expected);
    assert.deepStrictEqual(parseJsonc(edited.slice(1)), {
      steps: [],
      trustedExternalRoots: ["C:/external"],
    });
  });
});
