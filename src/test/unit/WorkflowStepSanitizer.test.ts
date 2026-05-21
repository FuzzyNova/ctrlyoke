import * as assert from "assert";
import { suite, test } from "mocha";
import { CONDITION_ACTIONS, STEP_TYPES } from "../../types/DashboardConstants";
import {
  parseClipboardWorkflowStep,
  sanitizeClipboardWorkflowStep,
  serializeWorkflowStepForClipboard,
} from "../../flightpath/WorkflowStepSanitizer";

suite("WorkflowStepSanitizer clipboard helpers", () => {
  test("sanitizeClipboardWorkflowStep strips transient fields and preserves persistable prompt properties", () => {
    const sanitized = sanitizeClipboardWorkflowStep({
      type: STEP_TYPES.PROMPT,
      name: "Copied prompt",
      prompt: "ship it",
      enabled: false,
      harness: "codex-cli",
      model: "gpt-5.4",
      agent: null,
      skills: ["review"],
      resumeSession: true,
      sessionId: "session-123",
      mcpServers: [
        "flightpath",
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
        returns: "done",
        timeout: 30,
        maxRetries: 2,
        retryPrompt: "retry",
        resumeSessionOnRetry: false,
        onPass: CONDITION_ACTIONS.CONTINUE,
        onFail: CONDITION_ACTIONS.RETRY,
      },
      preCondition: {
        script: "pre.js",
        returns: "true",
        timeout: 10,
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
      enabled: false,
      harness: "codex-cli",
      model: "gpt-5.4",
      agent: null,
      skills: ["review"],
      resumeSession: true,
      sessionId: "session-123",
      mcpServers: [
        "flightpath",
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
        returns: "done",
        timeout: 30,
        maxRetries: 2,
        retryPrompt: "retry",
        resumeSessionOnRetry: false,
        onPass: CONDITION_ACTIONS.CONTINUE,
        onFail: CONDITION_ACTIONS.RETRY,
      },
      preCondition: {
        script: "pre.js",
        returns: "true",
        timeout: 10,
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
      enabled: true,
      timeout: 45,
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
      timeout: 45,
      onPass: CONDITION_ACTIONS.CONTINUE,
      onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
    });
  });
});
