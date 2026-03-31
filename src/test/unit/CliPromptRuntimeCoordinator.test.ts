import * as assert from "assert";
import { suite, test } from "mocha";
import { CliPromptRuntimeCoordinator } from "../../flightpath/harness/shared/CliPromptRuntimeCoordinator";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import { Harness, type PromptItem } from "../../types/FlightPathTypes";

function createCoordinator(options?: {
  nowValues?: number[];
  debugMessages?: string[];
}): CliPromptRuntimeCoordinator {
  const nowValues = [...(options?.nowValues ?? [])];

  return new CliPromptRuntimeCoordinator({
    getIntegrationHarness: () => Harness.CopilotCli,
    logger: {
      debug: (message: string) => {
        options?.debugMessages?.push(message);
      },
    },
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
    const prompt: PromptItem = {
      prompt: "cancelled",
    };
    let updateCount = 0;

    await createCoordinator({ debugMessages }).persistCancelledPromptRuntime({
      prompt,
      executionStartTime: new Date(1234),
      extractedSessionId: "session-123",
      promptQueue: {
        async updateWorkingFile(): Promise<void> {
          updateCount += 1;
        },
      },
    });

    assert.strictEqual(prompt._runtime?.startedAt, 1234);
    assert.strictEqual(prompt._runtime?.sessionId, "session-123");
    assert.strictEqual(updateCount, 1);
    assert.deepStrictEqual(debugMessages, [
      "💾 Saved cancelled-prompt runtime to working file (sessionId: session-123)",
    ]);
  });

  test("should store successful runtime metadata and merge session ID into parsed output", async () => {
    const debugMessages: string[] = [];
    const prompt: PromptItem = {
      prompt: "done",
    };
    let updateCount = 0;

    const parsedOutput = await createCoordinator({
      nowValues: [2000, 3000],
      debugMessages,
    }).persistSuccessfulPromptRuntime({
      prompt,
      resolvedProperties: {
        harness: Harness.ClaudeCli,
        model: "sonnet",
        agent: "reviewer",
        resumeSession: true,
        mcpServers: null,
        hooks: null,
        toolPermissions: null,
      },
      extractedSessionId: "session-456",
      parsedOutput: createParsedOutput(),
      promptQueue: {
        async updateWorkingFile(): Promise<void> {
          updateCount += 1;
        },
      },
    });

    assert.strictEqual(prompt._runtime?.harness, Harness.ClaudeCli);
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
    const prompt: PromptItem = {
      prompt: "rerun",
      _runtime: {
        harness: Harness.CopilotCli,
        model: "gpt-5",
        startedAt: 111,
      },
    };

    const parsedOutput = await createCoordinator({
      nowValues: [4000],
    }).persistSuccessfulPromptRuntime({
      prompt,
      resolvedProperties: {
        harness: Harness.CodexCli,
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

    assert.strictEqual(prompt._runtime?.harness, Harness.CodexCli);
    assert.strictEqual(prompt._runtime?.model, "gpt-5.2-codex");
    assert.strictEqual(prompt._runtime?.startedAt, 111);
    assert.strictEqual(prompt._runtime?.completedAt, 4000);
    assert.strictEqual(prompt._runtime?.sessionId, "thread_new");
    assert.strictEqual(parsedOutput?.metadata.sessionId, "thread_existing");
  });
});
