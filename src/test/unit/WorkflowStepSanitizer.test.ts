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
  test("preserves shell overrides on script steps and their conditions", () => {
    const scriptStep = sanitizeClipboardWorkflowStep({
      type: STEP_TYPES.SCRIPT,
      script: "echo script",
      shell: "bash",
    });
    const promptStep = sanitizeClipboardWorkflowStep({
      type: STEP_TYPES.PROMPT,
      prompt: "prompt",
      preCondition: { script: "echo pre", shell: "cmd" },
      endCondition: { script: "echo end", shell: "pwsh" },
    });

    assert.deepStrictEqual(scriptStep, {
      type: STEP_TYPES.SCRIPT,
      script: "echo script",
      shell: "bash",
    });
    assert.deepStrictEqual(promptStep, {
      type: STEP_TYPES.PROMPT,
      prompt: "prompt",
      preCondition: { script: "echo pre", shell: "cmd" },
      endCondition: { script: "echo end", shell: "pwsh" },
    });
  });

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

  test("preserves inline MCP server descriptions through clipboard round trips", () => {
    const step = {
      prompt: "use the server",
      mcpServers: [
        {
          id: "github",
          description: "GitHub issues",
          command: "npx",
          args: ["-y", "gh-mcp"],
        },
      ],
    } as any;

    assert.deepStrictEqual(
      parseClipboardWorkflowStep(serializeWorkflowStepForClipboard(step)),
      step
    );
  });

  test("drops invalid executionMode values instead of persisting them", () => {
    assert.deepStrictEqual(
      buildPromptStepProperties({ executionMode: "sideways" }),
      {}
    );
  });

  test("preserves run-address priorContext through sanitization and clipboard round trips", () => {
    const step = {
      type: STEP_TYPES.PROMPT,
      prompt: "continue from the completed run",
      priorContext: {
        workflowKey: "workflow-1",
        runRef: "run-2026-01-01T00-00-00-000Z",
        ignored: "not part of WorkflowRunAddress",
      },
    } as any;
    const expected = {
      type: STEP_TYPES.PROMPT,
      prompt: "continue from the completed run",
      priorContext: {
        workflowKey: "workflow-1",
        runRef: "run-2026-01-01T00-00-00-000Z",
      },
    };

    assert.deepStrictEqual(sanitizeClipboardWorkflowStep(step), expected);
    assert.deepStrictEqual(
      parseClipboardWorkflowStep(serializeWorkflowStepForClipboard(step)),
      expected
    );
  });

  test("drops malformed priorContext objects while retaining supported forms", () => {
    for (const priorContext of [{ workflowKey: 1 }, { runRef: "run-1" }]) {
      assert.deepStrictEqual(
        sanitizeClipboardWorkflowStep({ prompt: "prompt", priorContext }),
        { prompt: "prompt" }
      );
    }

    assert.deepStrictEqual(
      sanitizeClipboardWorkflowStep({
        prompt: "prompt",
        priorContext: { previous: 3 },
      }),
      { prompt: "prompt", priorContext: { previous: 3 } }
    );
    assert.deepStrictEqual(
      sanitizeClipboardWorkflowStep({ prompt: "prompt", priorContext: "all" }),
      { prompt: "prompt", priorContext: "all" }
    );
    assert.deepStrictEqual(
      sanitizeClipboardWorkflowStep({ prompt: "prompt", priorContext: [1, 3] }),
      { prompt: "prompt", priorContext: [1, 3] }
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
