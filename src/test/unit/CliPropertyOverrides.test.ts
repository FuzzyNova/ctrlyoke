import * as assert from "assert";
import { suite, test } from "mocha";
import {
  applyCliPropertyOverrides,
  buildCliPropertyOverrides,
  FORCE_ALL_KEYWORD,
  ForceableFlag,
} from "../../cli/CliPropertyOverrides";
import { HARNESS_IDS, PERMISSION_MODES } from "../../types/DashboardConstants";
import {
  resolveExecutionProperties,
  resolveSessionId,
} from "../../types/ExecutionPropertyResolver";
import { resolveCliExecutionMode } from "../../cli/CliExecutionMode";
import type {
  PromptFile,
  PromptStep,
  ScriptStep,
} from "../../types/CtrlYokeTypes";

suite("CLI property overrides", () => {
  test("--force all applies each passed forceable flag to prompts and scripts", () => {
    const workflow: PromptFile = {
      steps: [
        {
          prompt: "one",
          model: "old",
          sessionId: "old-session",
          toolPermissions: {
            allowedTools: ["old-allow"],
            deniedTools: ["old-deny"],
          },
          preCondition: { script: "true" },
          endCondition: { script: "true" },
        },
        { type: "script", script: "true", timeoutSec: 5 },
      ],
      finalStep: { prompt: "final" },
    };
    const overrides = buildCliPropertyOverrides({
      harness: HARNESS_IDS.COPILOT_CLI,
      model: "gpt-test",
      headless: true,
      permissionMode: PERMISSION_MODES.NONE,
      allowTool: ["new-allow"],
      denyTool: ["new-deny"],
      resumeSession: true,
      sessionId: "forced-session",
      scriptTimeout: 17,
      force: [FORCE_ALL_KEYWORD],
    });

    assert.deepStrictEqual(
      overrides.forced,
      new Set(
        Object.values(ForceableFlag).filter(
          (flag) => flag !== ForceableFlag.INTERACTIVE
        )
      )
    );
    applyCliPropertyOverrides(workflow, overrides);
    const first = workflow.steps![0] as PromptStep;
    assert.strictEqual(first.harness, HARNESS_IDS.COPILOT_CLI);
    assert.strictEqual(first.model, "gpt-test");
    assert.strictEqual(first.executionMode, "headless");
    assert.strictEqual(first.resumeSession, true);
    assert.strictEqual(first.sessionId, "forced-session");
    assert.deepStrictEqual(first.toolPermissions, {
      mode: PERMISSION_MODES.NONE,
      allowedTools: ["new-allow"],
      deniedTools: ["new-deny"],
    });
    assert.strictEqual(first.preCondition?.timeoutSec, 17);
    assert.strictEqual(first.endCondition?.timeoutSec, 17);
    assert.strictEqual(workflow.steps![1].executionMode, "headless");
    assert.strictEqual((workflow.steps![1] as ScriptStep).timeoutSec, 17);
    assert.strictEqual(workflow.finalStep?.executionMode, "headless");
    assert.strictEqual(
      (workflow.finalStep as PromptStep).sessionId,
      "forced-session"
    );
  });

  test("--force resume-session false removes step session IDs", () => {
    const workflow: PromptFile = {
      steps: [{ prompt: "one", sessionId: "drop-me" }],
    };
    const overrides = buildCliPropertyOverrides({
      allowTool: [],
      denyTool: [],
      resumeSession: false,
      force: ["resume-session"],
    });
    applyCliPropertyOverrides(workflow, overrides);
    assert.strictEqual((workflow.steps![0] as PromptStep).sessionId, undefined);
    assert.strictEqual((workflow.steps![0] as PromptStep).resumeSession, false);
  });

  test("rejects unknown, non-forceable, and absent flag names", () => {
    for (const [force, expected] of [
      [["bogus"], "cannot include"],
      [["var"], "cannot include"],
      [["model"], "requires --model"],
    ] as const) {
      assert.throws(
        () =>
          buildCliPropertyOverrides({
            allowTool: [],
            denyTool: [],
            force: [...force],
          }),
        new RegExp(expected, "u")
      );
    }
  });

  test("--force harness clears models on steps whose harness changes", () => {
    const workflow: PromptFile = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      steps: [
        { prompt: "inherits", model: "sonnet" },
        {
          prompt: "explicit",
          harness: HARNESS_IDS.OPENCODE_CLI,
          model: "old-model",
        },
      ],
      finalStep: {
        prompt: "final",
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "old-final",
      },
    };
    const notices = applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides({
        harness: HARNESS_IDS.COPILOT_CLI,
        allowTool: [],
        denyTool: [],
        force: ["harness"],
      })
    );
    assert.deepStrictEqual(
      workflow.steps?.map((step) => (step as PromptStep).model),
      [undefined, undefined]
    );
    assert.strictEqual((workflow.finalStep as PromptStep).model, undefined);
    assert.strictEqual(notices.length, 3);
    assert.ok(notices.every((notice) => notice.includes("model")));
  });

  test("--force model refuses steps resolving to different harnesses", () => {
    const workflow: PromptFile = {
      steps: [
        { prompt: "one", harness: HARNESS_IDS.CLAUDE_CLI },
        { prompt: "two", harness: HARNESS_IDS.COPILOT_CLI },
      ],
    };
    const overrides = buildCliPropertyOverrides({
      model: "shared-model",
      allowTool: [],
      denyTool: [],
      force: ["model"],
    });
    assert.throws(
      () => applyCliPropertyOverrides(workflow, overrides),
      /step 1.*step 2.*--force harness/u
    );
  });
  test("builds workflow harness and model overrides", () => {
    const overrides = buildCliPropertyOverrides({
      harness: HARNESS_IDS.CODEX_CLI,
      model: "gpt-test",
      allowTool: [],
      denyTool: [],
    });
    assert.deepStrictEqual(overrides.workflow, {
      harness: HARNESS_IDS.CODEX_CLI,
      model: "gpt-test",
    });
    assert.strictEqual(overrides.forced.size, 0);
  });

  test("clears a workflow model when the effective harness changes", () => {
    const workflow: PromptFile = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "sonnet",
      steps: [],
    };
    const notices = applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides(
        { harness: HARNESS_IDS.COPILOT_CLI, allowTool: [], denyTool: [] },
        HARNESS_IDS.CODEX_CLI
      )
    );
    assert.strictEqual(workflow.harness, HARNESS_IDS.COPILOT_CLI);
    assert.strictEqual(workflow.model, undefined);
    assert.deepStrictEqual(notices, [
      'workflow model "sonnet" dropped: it was set for claude-cli',
    ]);
  });

  test("does not clear a model when the flag names the effective harness", () => {
    const workflow: PromptFile = {
      model: "custom-model",
      steps: [],
    };
    const notices = applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides(
        { harness: HARNESS_IDS.CLAUDE_CLI, allowTool: [], denyTool: [] },
        HARNESS_IDS.CLAUDE_CLI
      )
    );
    assert.strictEqual(workflow.model, "custom-model");
    assert.deepStrictEqual(notices, []);
  });

  test("clears a model without an authored harness when the default changes", () => {
    const workflow: PromptFile = { model: "old-model", steps: [] };
    const notices = applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides(
        { harness: HARNESS_IDS.CODEX_CLI, allowTool: [], denyTool: [] },
        HARNESS_IDS.CLAUDE_CLI
      )
    );
    assert.strictEqual(workflow.harness, HARNESS_IDS.CODEX_CLI);
    assert.strictEqual(workflow.model, undefined);
    assert.deepStrictEqual(notices, [
      'workflow model "old-model" dropped: it was set for claude-cli',
    ]);
  });

  test("keeps an old model when --model accompanies a harness change", () => {
    const workflow: PromptFile = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "sonnet",
      steps: [],
    };
    const notices = applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides({
        harness: HARNESS_IDS.CODEX_CLI,
        model: "gpt-test",
        allowTool: [],
        denyTool: [],
      })
    );
    assert.strictEqual(workflow.model, "gpt-test");
    assert.deepStrictEqual(notices, []);
  });

  test("merges permission fields and replaces only fields supplied by flags", () => {
    const workflow: PromptFile = {
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["old-allow"],
        deniedTools: ["keep-deny"],
      },
      steps: [],
    };
    applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides({
        harness: undefined,
        model: undefined,
        permissionMode: PERMISSION_MODES.NONE,
        allowTool: ["new-allow"],
        denyTool: [],
      })
    );
    assert.deepStrictEqual(workflow.toolPermissions, {
      mode: PERMISSION_MODES.NONE,
      allowedTools: ["new-allow"],
      deniedTools: ["keep-deny"],
    });
  });

  test("turns null workflow permissions into an object when flagged", () => {
    const workflow: PromptFile = { toolPermissions: null, steps: [] };
    applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides({
        harness: undefined,
        model: undefined,
        permissionMode: undefined,
        allowTool: [],
        denyTool: ["blocked"],
      })
    );
    assert.deepStrictEqual(workflow.toolPermissions, {
      deniedTools: ["blocked"],
    });
  });

  test("applies session flags at workflow scope and preserves step session IDs", () => {
    const workflow: PromptFile = {
      steps: [
        { prompt: "one" },
        { prompt: "two", sessionId: "step-session" },
        { prompt: "three" },
      ],
    };
    applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides({
        allowTool: [],
        denyTool: [],
        sessionId: "literal-42",
      })
    );

    assert.strictEqual(workflow.sessionId, "literal-42");
    assert.strictEqual(workflow.resumeSession, true);
    const defaults = {
      harness: HARNESS_IDS.COPILOT_CLI,
      modelsByHarness: {},
      additionalArgsByHarness: {},
      executionMode: "headless" as const,
      resumeSession: false,
    };
    assert.strictEqual(
      resolveSessionId(workflow.steps![0] as PromptStep, workflow, defaults)
        .value,
      "literal-42"
    );
    assert.strictEqual(
      resolveSessionId(workflow.steps![1] as PromptStep, workflow, defaults)
        .value,
      "step-session"
    );
    assert.strictEqual(
      resolveSessionId(workflow.steps![2] as PromptStep, workflow, defaults)
        .value,
      "literal-42"
    );
  });

  test("--no-resume-session keeps step session IDs and explicit choices", () => {
    const workflow: PromptFile = {
      steps: [
        { prompt: "one", sessionId: "keep-one" },
        { prompt: "two", sessionId: "keep-two", resumeSession: true },
      ],
    };
    applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides({
        allowTool: [],
        denyTool: [],
        resumeSession: false,
      })
    );
    assert.strictEqual(workflow.resumeSession, false);
    assert.strictEqual(
      (workflow.steps?.[0] as PromptStep).sessionId,
      "keep-one"
    );
    assert.strictEqual(
      (workflow.steps?.[1] as PromptStep).sessionId,
      "keep-two"
    );
    assert.strictEqual((workflow.steps?.[1] as PromptStep).resumeSession, true);
  });

  test("execution mode flags override the workflow while steps retain precedence", () => {
    const workflow: PromptFile = {
      executionMode: "interactive",
      steps: [{ prompt: "one", executionMode: "interactive" }],
    };
    applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides({
        allowTool: [],
        denyTool: [],
        headless: true,
      })
    );
    assert.strictEqual(workflow.executionMode, "headless");
    assert.strictEqual(workflow.steps?.[0].executionMode, "interactive");

    const tty = resolveCliExecutionMode(true, true);
    const resolved = resolveExecutionProperties(
      workflow.steps![0] as PromptStep,
      workflow,
      {
        defaults: {
          harness: HARNESS_IDS.COPILOT_CLI,
          modelsByHarness: {},
          additionalArgsByHarness: {},
          executionMode: tty.executionMode,
          resumeSession: false,
        },
        hostCanProvidePty: tty.hostCanProvidePty,
      }
    );
    assert.strictEqual(resolved.properties.executionMode, "interactive");
  });
});
