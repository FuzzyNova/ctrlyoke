import * as assert from "assert";
import { suite, test } from "mocha";
import { CONDITION_ACTIONS, STEP_TYPES } from "../../types/DashboardConstants";
import {
  parseClipboardWorkflowStep,
  sanitizeClipboardWorkflowStep,
  serializeWorkflowStepForClipboard,
  buildPromptStepProperties,
  normalizeAgentSelection,
  stripTimelineDuplicatedWorkingFileOutput,
} from "../../core/WorkflowStepSanitizer";

suite("WorkflowStepSanitizer clipboard helpers", () => {
  test("normalizes the empty agent sentinel to schema-valid null", () => {
    assert.strictEqual(normalizeAgentSelection(""), null);
    assert.strictEqual(normalizeAgentSelection("reviewer"), "reviewer");
    assert.strictEqual(normalizeAgentSelection(null), null);
    assert.strictEqual(buildPromptStepProperties({ agent: "" }).agent, null);
  });

  test("sanitizeClipboardWorkflowStep strips transient fields and preserves persistable prompt properties", () => {
    const sanitized = sanitizeClipboardWorkflowStep({
      type: STEP_TYPES.PROMPT,
      name: "Copied prompt",
      prompt: "ship it",
      color: "#A1b2C3",
      enabled: false,
      harness: "codex-cli",
      model: "gpt-5.4",
      executionMode: "headless",
      agent: null,
      skills: ["review"],
      resumeSession: true,
      sessionId: "session-123",
      mcpServers: [
        "ctrlyoke",
        {
          id: "local-server",
          command: "npx",
          args: ["-y", "@scope/server"],
          env: { TOKEN: "secret" },
          autoApprove: true,
          deniedTools: ["danger"],
        },
      ],
      hooks: [{ event: "stop", command: "echo done", timeoutSec: 5 }],
      endCondition: {
        script: "check.js",
        expected: "done",
        timeoutSec: 0.03,
        maxRetries: 2,
        retryPrompt: "retry",
        passRetryPrompt: "keep going",
        resumeSessionOnRetry: false,
        onPass: CONDITION_ACTIONS.CONTINUE,
        onFail: CONDITION_ACTIONS.RETRY,
      },
      preCondition: {
        script: "pre.js",
        expected: "true",
        timeoutSec: 0.01,
        compareSource: "stdout",
        onPass: CONDITION_ACTIONS.CONTINUE,
        onFail: CONDITION_ACTIONS.SKIP_PROMPT,
      },
      priorContext: [1, 3],
      additionalArgs: null,
      toolPermissions: {
        mode: "custom",
        allowedTools: ["read"],
        deniedTools: ["write"],
      },
      _runtime: {
        startedAt: 1,
        completedAt: 2,
        responseText: "transient",
      },
      status: "completed",
      details: { retryCount: 2 },
      output: { response: "ignore me" },
      retryCount: 9,
      uiOnly: true,
    } as any);

    assert.deepStrictEqual(sanitized, {
      type: STEP_TYPES.PROMPT,
      name: "Copied prompt",
      prompt: "ship it",
      color: "#A1b2C3",
      enabled: false,
      harness: "codex-cli",
      model: "gpt-5.4",
      executionMode: "headless",
      agent: null,
      skills: ["review"],
      resumeSession: true,
      sessionId: "session-123",
      mcpServers: [
        "ctrlyoke",
        {
          id: "local-server",
          command: "npx",
          args: ["-y", "@scope/server"],
          env: { TOKEN: "secret" },
          autoApprove: true,
          deniedTools: ["danger"],
        },
      ],
      hooks: [{ event: "stop", command: "echo done", timeoutSec: 5 }],
      endCondition: {
        script: "check.js",
        expected: "done",
        timeoutSec: 0.03,
        maxRetries: 2,
        retryPrompt: "retry",
        passRetryPrompt: "keep going",
        resumeSessionOnRetry: false,
        onPass: CONDITION_ACTIONS.CONTINUE,
        onFail: CONDITION_ACTIONS.RETRY,
      },
      preCondition: {
        script: "pre.js",
        expected: "true",
        timeoutSec: 0.01,
        compareSource: "stdout",
        onPass: CONDITION_ACTIONS.CONTINUE,
        onFail: CONDITION_ACTIONS.SKIP_PROMPT,
      },
      priorContext: [1, 3],
      additionalArgs: null,
      toolPermissions: {
        mode: "custom",
        allowedTools: ["read"],
        deniedTools: ["write"],
      },
    });
  });

  test("serializeWorkflowStepForClipboard emits canonical JSON and drops enabled=true", () => {
    const text = serializeWorkflowStepForClipboard({
      type: STEP_TYPES.SCRIPT,
      name: "Copied script",
      script: "npm test",
      color: "#123456",
      executionMode: "interactive",
      enabled: true,
      timeoutSec: 0.045,
      onPass: CONDITION_ACTIONS.CONTINUE,
      onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
      _runtime: {
        startedAt: 1,
        completedAt: 2,
      },
      status: "completed",
    } as any);

    assert.ok(text.includes(`"type": "${STEP_TYPES.SCRIPT}"`));
    assert.ok(!text.includes(`"enabled": true`));

    const parsed = parseClipboardWorkflowStep(text);
    assert.deepStrictEqual(parsed, {
      type: STEP_TYPES.SCRIPT,
      name: "Copied script",
      script: "npm test",
      color: "#123456",
      executionMode: "interactive",
      timeoutSec: 0.045,
      onPass: CONDITION_ACTIONS.CONTINUE,
      onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
    });
  });

  test("drops invalid executionMode values instead of persisting them", () => {
    assert.deepStrictEqual(
      buildPromptStepProperties({ executionMode: "sideways" }),
      {}
    );
  });
});

suite("WorkflowStepSanitizer response-source cutover", () => {
  test("drops obsolete working-file output fields without migration reads", () => {
    const normalized = stripTimelineDuplicatedWorkingFileOutput({
      steps: [
        {
          prompt: "answer",
          _runtime: {
            startedAt: 1,
            completedAt: 2,
            sessionId: "keep-session",
            responseText: "obsolete answer",
          },
        },
        {
          type: STEP_TYPES.SCRIPT,
          script: "npm test",
          _runtime: {
            startedAt: 3,
            scriptOutput: {
              command: "npm test",
              stdout: "obsolete",
              stderr: "",
            },
          },
        },
      ],
      _runtime: {
        currentIndex: 1,
        executionState: "stopped",
        finalStep: {
          phase: "finalStep",
          loopCount: 2,
          responseTexts: ["obsolete loop"],
        },
      },
    } as any);

    assert.deepStrictEqual(normalized.steps?.[0]._runtime, {
      startedAt: 1,
      completedAt: 2,
      sessionId: "keep-session",
    });
    assert.deepStrictEqual(normalized.steps?.[1]._runtime, { startedAt: 3 });
    assert.deepStrictEqual(normalized._runtime?.finalStep, {
      phase: "finalStep",
      loopCount: 2,
    });
  });
});
