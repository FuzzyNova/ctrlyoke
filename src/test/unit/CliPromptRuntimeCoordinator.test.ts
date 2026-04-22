import * as assert from "assert";
import { suite, test } from "mocha";
import { CliPromptRuntimeCoordinator } from "../../flightpath/harness/shared/CliPromptRuntimeCoordinator";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import { type PromptStep } from "../../types/FlightPathTypes";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";

function createCoordinator(options?: {
  nowValues?: number[];
}): CliPromptRuntimeCoordinator {
  const nowValues = [...(options?.nowValues ?? [])];

  return new CliPromptRuntimeCoordinator({
    getIntegrationHarness: () => HARNESS_IDS.COPILOT_CLI,
    now: () => {
      const nextValue = nowValues.shift();
      return nextValue ?? 0;
    },
  });
}

function createParsedOutput(
  overrides?: Partial<UniversalCliOutput>
): UniversalCliOutput {
  return {
    events: [],
    metadata: {},
    ...overrides,
  };
}

suite("CliPromptRuntimeCoordinator", () => {
  test("should persist cancelled prompt runtime for resumable sessions", async () => {
    const debugMessages: string[] = [];
    const prompt: PromptStep = {
      prompt: "cancelled",
    };
    let updateCount = 0;
    const originalDebug = Log.debug;
    (Log as unknown as { debug(message: string): void }).debug = (
      message: string
    ) => {
      debugMessages.push(message);
    };

    try {
      await createCoordinator().persistCancelledPromptRuntime({
        prompt,
        executionStartTime: new Date(1234),
        extractedSessionId: "session-123",
        workingFilePersistence: {
          async updateWorkingFile(): Promise<void> {
            updateCount += 1;
          },
        },
      });
    } finally {
      (Log as unknown as { debug(message: string): void }).debug =
        originalDebug;
    }

    assert.strictEqual(prompt._runtime?.startedAt, 1234);
    assert.strictEqual(prompt._runtime?.sessionId, "session-123");
    assert.strictEqual(updateCount, 1);
    assert.deepStrictEqual(debugMessages, [
      "💾 Saved cancelled-prompt runtime to working file (sessionId: session-123)",
    ]);
  });

  test("should persist partial cancelled output and parsed session metadata", async () => {
    const prompt: PromptStep = {
      prompt: "cancelled after output",
    };
    let updateCount = 0;

    await createCoordinator({
      nowValues: [9999],
    }).persistCancelledPromptRuntime({
      prompt,
      executionStartTime: new Date(1234),
      parsedOutput: createParsedOutput({
        events: [
          {
            type: "text" as any,
            data: { text: "partial answer" },
          },
        ],
        metadata: {
          sessionId: "session-from-partial-output",
        },
      }),
      workingFilePersistence: {
        async updateWorkingFile(): Promise<void> {
          updateCount += 1;
        },
      },
    });

    assert.strictEqual(prompt._runtime?.startedAt, 1234);
    assert.strictEqual(prompt._runtime?.completedAt, 9999);
    assert.strictEqual(
      prompt._runtime?.sessionId,
      "session-from-partial-output"
    );
    assert.strictEqual(prompt._runtime?.responseText, "partial answer");
    assert.strictEqual(updateCount, 1);
  });

  test("should store successful runtime metadata and merge session ID into parsed output", async () => {
    const debugMessages: string[] = [];
    const prompt: PromptStep = {
      prompt: "done",
    };
    let updateCount = 0;
    const originalDebug = Log.debug;
    (Log as unknown as { debug(message: string): void }).debug = (
      message: string
    ) => {
      debugMessages.push(message);
    };

    let parsedOutput: UniversalCliOutput | undefined;
    try {
      parsedOutput = await createCoordinator({
        nowValues: [2000, 3000],
      }).persistSuccessfulPromptRuntime({
        prompt,
        resolvedProperties: {
          harness: HARNESS_IDS.CLAUDE_CLI,
          model: "sonnet",
          agent: "reviewer",
          resumeSession: true,
          mcpServers: null,
          hooks: null,
          toolPermissions: null,
        },
        extractedSessionId: "session-456",
        parsedOutput: createParsedOutput(),
        workingFilePersistence: {
          async updateWorkingFile(): Promise<void> {
            updateCount += 1;
          },
        },
      });
    } finally {
      (Log as unknown as { debug(message: string): void }).debug =
        originalDebug;
    }

    assert.strictEqual(prompt._runtime?.harness, HARNESS_IDS.CLAUDE_CLI);
    assert.strictEqual(prompt._runtime?.model, "sonnet");
    assert.strictEqual(prompt._runtime?.agent, "reviewer");
    assert.strictEqual(prompt._runtime?.startedAt, 2000);
    assert.strictEqual(prompt._runtime?.completedAt, 3000);
    assert.strictEqual(prompt._runtime?.sessionId, "session-456");
    assert.strictEqual(parsedOutput?.metadata.sessionId, "session-456");
    assert.strictEqual(updateCount, 1);
    assert.deepStrictEqual(debugMessages, [
      "💾 Saved runtime metadata to working file (sessionId: session-456)",
    ]);
  });

  test("should preserve existing parsed output session ID on successful completion", async () => {
    const prompt: PromptStep = {
      prompt: "rerun",
      _runtime: {
        harness: HARNESS_IDS.COPILOT_CLI,
        model: "gpt-5",
        startedAt: 111,
      },
    };

    const parsedOutput = await createCoordinator({
      nowValues: [4000],
    }).persistSuccessfulPromptRuntime({
      prompt,
      resolvedProperties: {
        harness: HARNESS_IDS.CODEX_CLI,
        model: "gpt-5.2-codex",
        resumeSession: true,
        mcpServers: null,
        hooks: null,
        toolPermissions: null,
      },
      extractedSessionId: "thread_new",
      parsedOutput: createParsedOutput({
        metadata: {
          sessionId: "thread_existing",
        },
      }),
    });

    assert.strictEqual(prompt._runtime?.harness, HARNESS_IDS.CODEX_CLI);
    assert.strictEqual(prompt._runtime?.model, "gpt-5.2-codex");
    assert.strictEqual(prompt._runtime?.startedAt, 111);
    assert.strictEqual(prompt._runtime?.completedAt, 4000);
    assert.strictEqual(prompt._runtime?.sessionId, "thread_new");
    assert.strictEqual(parsedOutput?.metadata.sessionId, "thread_existing");
  });
});
