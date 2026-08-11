import * as assert from "assert";
import { suite, test } from "mocha";
import { PromptFileParser } from "../../core/PromptFileParser";

suite("PromptFileParser worktree authoring", function () {
  this.timeout(10_000);

  const parser = new PromptFileParser();

  test("round-trips the supported root forms", async () => {
    const cases = [
      { prompt: "prompt", worktree: false },
      { prompt: "prompt", worktree: "feature/auto" },
      {
        steps: [{ prompt: "prompt" }],
        worktree: {
          mode: "named",
          branch: "feature/named",
          base: "HEAD",
          setup: "npm ci",
        },
      },
      {
        type: "script",
        script: "npm test",
        worktree: "feature/script",
      },
    ] as const;

    for (const authored of cases) {
      const parsed = await parser.validateAndNormalize(
        authored,
        "workflow.ctrlyoke.json"
      );
      assert.deepStrictEqual(parsed.worktree, authored.worktree);
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
      {
        steps: [{ prompt: "prompt" }],
        finalStep: { prompt: "final", worktree: "feature/final" },
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

  test("rejects unimplemented and empty worktree forms", async () => {
    const invalid = [
      { prompt: "prompt", worktree: "" },
      { steps: [{ prompt: "prompt" }], worktree: { mode: "named", branch: "" } },
      { prompt: "prompt", worktree: { mode: "managed", branch: "feature" } },
      { prompt: "prompt", worktree: { mode: "named", branch: "feature", keep: true } },
    ];

    for (const authored of invalid) {
      await assert.rejects(
        parser.validateAndNormalize(authored, "workflow.ctrlyoke.json"),
        /Validation failed/
      );
    }
  });
});
