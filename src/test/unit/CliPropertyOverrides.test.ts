import * as assert from "assert";
import { suite, test } from "mocha";
import {
  applyCliPropertyOverrides,
  buildCliPropertyOverrides,
} from "../../cli/CliPropertyOverrides";
import { HARNESS_IDS, PERMISSION_MODES } from "../../types/DashboardConstants";
import {
  resolveExecutionProperties,
  resolveSessionId,
} from "../../types/ExecutionPropertyResolver";
import { resolveCliExecutionMode } from "../../cli/CliExecutionMode";
import type { PromptFile, PromptStep } from "../../types/CtrlYokeTypes";

suite("CLI property overrides", () => {
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
      resolveSessionId(
        workflow.steps![0] as PromptStep,
        workflow,
        defaults
      ).value,
      "literal-42"
    );
    assert.strictEqual(
      resolveSessionId(
        workflow.steps![1] as PromptStep,
        workflow,
        defaults
      ).value,
      "step-session"
    );
    assert.strictEqual(
      resolveSessionId(
        workflow.steps![2] as PromptStep,
        workflow,
        defaults
      ).value,
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
    assert.strictEqual(
      (workflow.steps?.[1] as PromptStep).resumeSession,
      true
    );
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
