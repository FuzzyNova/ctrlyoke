import * as assert from "assert";
import { suite, test } from "mocha";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import { CliResponseCollector } from "../../flightpath/harness/shared/CliResponseCollector";

function createParsedOutput(
  overrides?: Partial<UniversalCliOutput>
): UniversalCliOutput {
  return {
    events: [
      {
        type: "text" as any,
        data: { text: "hello world" },
      },
    ],
    metadata: {},
    ...overrides,
  };
}

suite("CliResponseCollector", () => {
  test("should build cli result and prefer session ID from parsed output", async () => {
    const loggedResponses: Array<{ response: string; statistics?: string }> =
      [];
    const completedResponses: string[] = [];
    const debugMessages: string[] = [];

    const collector = new CliResponseCollector({
      responseParser: {
        parse: () =>
          createParsedOutput({
            metadata: { sessionId: "session-from-output" },
          }),
        parseTokenCounts: () => undefined,
      },
      extractTextFromEvents: () => "hello world",
      formatStatistics: () => "Usage: 1 input + 2 output = 3 tokens",
      logResponse: (response: string, statistics?: string) => {
        loggedResponses.push({ response, statistics });
      },
      onResponseComplete: (response: string) => {
        completedResponses.push(response);
      },
      logger: {
        debug: (message: string) => {
          debugMessages.push(message);
        },
      },
    });

    const result = await collector.collectHeadlessResponse({
      stdout: "stdout",
      stderr: "",
      exitCode: 0,
      promptForSessionLog: "say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.cliResult.success, true);
    assert.strictEqual(result.cliResult.response, "hello world");
    assert.strictEqual(
      result.cliResult.statistics,
      "Usage: 1 input + 2 output = 3 tokens"
    );
    assert.strictEqual(result.extractedSessionId, "session-from-output");
    assert.deepStrictEqual(loggedResponses, [
      {
        response: "hello world",
        statistics: "Usage: 1 input + 2 output = 3 tokens",
      },
    ]);
    assert.deepStrictEqual(completedResponses, ["hello world"]);
    assert.ok(
      debugMessages.some((message) => message.includes("session-from-output"))
    );
  });

  test("should fall back to log-based session extraction when output has no session ID", async () => {
    let extractedPrompt: string | undefined;

    const collector = new CliResponseCollector({
      responseParser: {
        parse: () => createParsedOutput(),
        parseTokenCounts: () => undefined,
      },
      extractSessionIdFromLogs: async (promptText: string) => {
        extractedPrompt = promptText;
        return "session-from-log";
      },
      extractTextFromEvents: () => "hello world",
      formatStatistics: () => "",
      logResponse: () => {},
      onResponseComplete: () => {},
      logger: { debug: (_message: string) => {} },
    });

    const result = await collector.collectHeadlessResponse({
      stdout: "stdout",
      stderr: "",
      exitCode: 0,
      promptForSessionLog: "discover me",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.extractedSessionId, "session-from-log");
    assert.strictEqual(extractedPrompt, "discover me");
  });

  test("should skip log-based session extraction when resuming an existing session", async () => {
    let logExtractionCalled = false;

    const collector = new CliResponseCollector({
      responseParser: {
        parse: () => createParsedOutput(),
        parseTokenCounts: () => undefined,
      },
      extractSessionIdFromLogs: async () => {
        logExtractionCalled = true;
        return "session-from-log";
      },
      extractTextFromEvents: () => "hello world",
      formatStatistics: () => "",
      logResponse: () => {},
      onResponseComplete: () => {},
      logger: { debug: (_message: string) => {} },
    });

    const result = await collector.collectHeadlessResponse({
      stdout: "stdout",
      stderr: "",
      exitCode: 0,
      promptForSessionLog: "ignored",
      executionStartTime: new Date(),
      resolvedSessionId: "existing-session",
    });

    assert.strictEqual(result.extractedSessionId, undefined);
    assert.strictEqual(logExtractionCalled, false);
  });
});
