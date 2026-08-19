import * as assert from "assert";
import { suite, test } from "mocha";
import { PromptFileParser } from "../../core/PromptFileParser";

suite("PromptFileParser worktree authoring", function () {
  this.timeout(10_000);

  const parser = new PromptFileParser();

  test("round-trips the supported root forms", async () => {
    const cases = [
      { authored: { prompt: "prompt", worktree: false }, expected: false },
      {
        authored: { prompt: "prompt", worktree: true },
        expected: { mode: "managed" },
      },
      {
        authored: { prompt: "prompt", worktree: "feature/auto" },
        expected: "feature/auto",
      },
      {
        authored: {
          steps: [{ prompt: "prompt" }],
          worktree: {
            mode: "managed",
            merge: true,
            keep: true,
            base: "HEAD",
            setup: "npm ci",
          },
        },
        expected: {
          mode: "managed",
          merge: true,
          keep: true,
          base: "HEAD",
          setup: "npm ci",
        },
      },
      {
        authored: {
          type: "script",
          script: "npm test",
          worktree: "feature/script",
        },
        expected: "feature/script",
      },
    ] as const;

    for (const { authored, expected } of cases) {
      const parsed = await parser.validateAndNormalize(
        authored,
        "workflow.ctrlyoke.json"
      );
      assert.deepStrictEqual(parsed.worktree, expected);
    }
  });

  test("keeps an omitted worktree absent", async () => {
    const parsed = await parser.validateAndNormalize(
      { steps: [{ prompt: "prompt" }] },
      "workflow.ctrlyoke.json"
    );

    assert.strictEqual(Object.hasOwn(parsed, "worktree"), false);
    assert.strictEqual(parsed.worktree, undefined);
  });

  test("rejects worktree on nested steps, finalStep, and prompt runtime", async () => {
    const invalid = [
      { steps: [{ prompt: "prompt", worktree: false }] },
      { steps: [{ type: "script", script: "npm test", worktree: true }] },
      {
        steps: [{ prompt: "prompt" }],
        finalStep: { prompt: "final", worktree: "feature/final" },
      },
      {
        steps: [{ prompt: "prompt" }],
        finalStep: { type: "script", script: "npm test", worktree: true },
      },
      {
        steps: [
          { prompt: "prompt", _runtime: { startedAt: 1, worktree: false } },
        ],
      },
    ];

    for (const authored of invalid) {
      await assert.rejects(
        parser.validateAndNormalize(authored, "workflow.ctrlyoke.json"),
        /Validation failed/
      );
    }
  });

  test("rejects named merge, mode-invalid, and empty worktree forms", async () => {
    const invalid = [
      { prompt: "prompt", worktree: "" },
      {
        steps: [{ prompt: "prompt" }],
        worktree: { mode: "named", branch: "" },
      },
      {
        prompt: "prompt",
        worktree: { mode: "named", branch: "feature", keep: true },
      },
      { prompt: "prompt", worktree: { mode: "managed", branch: "feature" } },
      {
        prompt: "prompt",
        worktree: { mode: "named", branch: "feature", merge: true },
      },
    ];

    for (const authored of invalid) {
      await assert.rejects(
        parser.validateAndNormalize(authored, "workflow.ctrlyoke.json"),
        /Validation failed/
      );
    }
  });
});
