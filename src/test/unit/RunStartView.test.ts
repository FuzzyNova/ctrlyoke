import * as assert from "assert";
import { suite, test } from "mocha";
import type {
  PromptFile,
  PromptStep,
  WorktreeDefaultConfig,
} from "../../types/CtrlYokeTypes";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import { RunStartView } from "../../utils/RunStartView";
import { VarSubstitutionValidationError } from "../../utils/VarSubstitutor";

const CLAUDE = HARNESS_IDS.CLAUDE_CLI;
const CODEX = HARNESS_IDS.CODEX_CLI;

function workflow(overrides: Record<string, unknown> = {}): PromptFile {
  return {
    harness: "{{h}}",
    maxSteps: "{{max}}",
    vars: { h: CLAUDE, max: "5", on: "false", branch: "fix/1" },
    worktree: { mode: "named", branch: "{{branch}}" },
    steps: [{ prompt: "one", harness: "{{h}}", enabled: "{{on}}" }],
    ...overrides,
  } as unknown as PromptFile;
}

suite("RunStartView", () => {
  test("resolves root, step, finalStep and worktree run-start fields without touching the definition", () => {
    const authored = workflow({
      finalStep: { prompt: "final", harness: "{{h}}" },
    });
    const view = RunStartView.resolve(authored, {
      branch: "{{branch}}",
    } as unknown as WorktreeDefaultConfig);

    assert.strictEqual(view.workflow.harness, CLAUDE);
    assert.strictEqual(view.workflow.maxSteps, 5);
    const step = view.workflow.steps?.[0] as PromptStep;
    assert.strictEqual(step.harness, CLAUDE);
    assert.strictEqual(step.enabled, false);
    assert.strictEqual(
      (view.workflow.finalStep as PromptStep | undefined)?.harness,
      CLAUDE
    );
    assert.deepStrictEqual(view.workflow.worktree, {
      mode: "named",
      branch: "fix/1",
    });
    assert.deepStrictEqual(view.defaultWorktree, { branch: "fix/1" });
    assert.strictEqual(authored.harness, "{{h}}");
    assert.strictEqual((authored.steps?.[0] as PromptStep).harness, "{{h}}");
  });

  test("applies its vars to the live definition, even when the live vars change", () => {
    const authored = workflow();
    const view = RunStartView.resolve(authored);
    const live = { ...authored, vars: { h: CODEX } };
    const applied = view.applyToWorkflow(live);
    assert.strictEqual(applied.harness, CLAUDE);
    assert.strictEqual(applied.maxSteps, 5);
    assert.strictEqual(applied.steps, live.steps);
    assert.strictEqual(live.harness, "{{h}}");
  });

  test("resolves an appended or edited step, and returns an unchanged step itself", () => {
    const view = RunStartView.resolve(workflow());
    const appended = {
      prompt: "two",
      harness: "{{h}}",
    } as unknown as PromptStep;
    assert.strictEqual(view.resolveStep(appended, 1).harness, CLAUDE);
    const edited = { ...appended, harness: CODEX };
    assert.strictEqual(view.resolveStep(edited, 1).harness, CODEX);
    const plain: PromptStep = { prompt: "three", harness: CODEX };
    assert.strictEqual(view.resolveStep(plain, 2), plain);
  });

  test("snapshots the vars it was built with", () => {
    const vars: Record<string, string> = { h: CLAUDE, max: "5", on: "true" };
    const view = RunStartView.resolve(workflow(), undefined, vars);
    vars["h"] = CODEX;
    assert.ok(Object.isFrozen(view.vars));
    const step = { prompt: "x", harness: "{{h}}" } as unknown as PromptStep;
    assert.strictEqual(view.resolveStep(step, 0).harness, CLAUDE);
  });

  test("a failing run-start field throws before any side effect", () => {
    assert.throws(
      () => RunStartView.resolve(workflow({ vars: { h: "nope", max: "5" } })),
      (error: Error) =>
        error instanceof VarSubstitutionValidationError &&
        error.message.startsWith('harness: variable "h" is "nope"')
    );
  });
});
