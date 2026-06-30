import * as assert from "assert";
import { suite, test } from "mocha";
import { FAILURE_KINDS } from "../../types/DashboardConstants";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import { CliResponseCollector } from "../../core/harness/shared/CliResponseCollector";
import type { ICliProvider } from "../../core/harness/shared/interfaces/ICliProvider";
import { Log } from "../../utils/Log";

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
    const originalDebug = Log.debug;
    (Log as unknown as { debug(message: string): void }).debug = (
      message: string
    ) => {
      debugMessages.push(message);
    };

    try {
      const collector = new CliResponseCollector({
        provider: {
          responseParser: {
            parse: () =>
              createParsedOutput({
                metadata: {
                  sessionId: "session-from-output",
                  usage: {
                    inputTokens: 1,
                    outputTokens: 2,
                    totalTokens: 3,
                  },
                } as any,
              }),
            parseTokenCounts: () => undefined,
          },
        } as Pick<
          ICliProvider,
          "responseParser" | "augmentParsedOutput" | "extractSessionIdFromLogs"
        >,
        hostCallbacks: {
          logResponse: (response: string, statistics?: string) => {
            loggedResponses.push({ response, statistics });
          },
          onResponseComplete: (response: string) => {
            completedResponses.push(response);
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
        "Session: session- | Tokens: 1 in / 2 out"
      );
      assert.strictEqual(result.extractedSessionId, "session-from-output");
      assert.deepStrictEqual(loggedResponses, [
        {
          response: "hello world",
          statistics: "Session: session- | Tokens: 1 in / 2 out",
        },
      ]);
      assert.deepStrictEqual(completedResponses, ["hello world"]);
      assert.ok(
        debugMessages.some((message) => message.includes("session-from-output"))
      );
    } finally {
      (Log as unknown as { debug(message: string): void }).debug =
        originalDebug;
    }
  });

  test("should call provider-owned augmentParsedOutput without detaching provider context", async () => {
    const provider = {
      augmentationSessionId: "augmented-session",
      responseParser: {
        parse: () => createParsedOutput(),
        parseTokenCounts: () => undefined,
      },
      async augmentParsedOutput(output: UniversalCliOutput) {
        return {
          ...output,
          metadata: {
            ...output.metadata,
            sessionId: this.augmentationSessionId,
          },
        };
      },
    } as Pick<
      ICliProvider,
      "responseParser" | "augmentParsedOutput" | "extractSessionIdFromLogs"
    > & { augmentationSessionId: string };

    const collector = new CliResponseCollector({
      provider,
      hostCallbacks: {
        logResponse: () => {},
        onResponseComplete: () => {},
      },
    });

    const result = await collector.collectHeadlessResponse({
      stdout: "stdout",
      stderr: "",
      exitCode: 0,
      promptForSessionLog: "say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.extractedSessionId, "augmented-session");
    assert.strictEqual(
      result.parsedOutput.metadata.sessionId,
      "augmented-session"
    );
  });

  test("should fall back to log-based session extraction when output has no session ID", async () => {
    let extractedPrompt: string | undefined;
    const provider = {
      logSessionId: "session-from-log",
      responseParser: {
        parse: () => createParsedOutput(),
        parseTokenCounts: () => undefined,
      },
      async extractSessionIdFromLogs(promptText: string) {
        extractedPrompt = promptText;
        return this.logSessionId;
      },
    } as Pick<
      ICliProvider,
      "responseParser" | "augmentParsedOutput" | "extractSessionIdFromLogs"
    > & { logSessionId: string };

    const collector = new CliResponseCollector({
      provider,
      hostCallbacks: {
        logResponse: () => {},
        onResponseComplete: () => {},
      },
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

  test("should treat stderr-only CLI invocation errors as failure without log fallback", async () => {
    let logExtractionCalled = false;
    const loggedResponses: Array<{ response: string; statistics?: string }> =
      [];
    const completedResponses: string[] = [];
    const stderr = [
      "error: unknown option '--poop'",
      "(Did you mean --prompt?)",
      "",
      "Try 'copilot --help' for more information.",
    ].join("\n");

    const collector = new CliResponseCollector({
      provider: {
        responseParser: {
          parse: () => ({ events: [], metadata: {} }),
          parseTokenCounts: () => undefined,
        },
        extractSessionIdFromLogs: async () => {
          logExtractionCalled = true;
          return "session-from-log";
        },
      } as Pick<
        ICliProvider,
        "responseParser" | "augmentParsedOutput" | "extractSessionIdFromLogs"
      >,
      hostCallbacks: {
        logResponse: (response: string, statistics?: string) => {
          loggedResponses.push({ response, statistics });
        },
        onResponseComplete: (response: string) => {
          completedResponses.push(response);
        },
      },
    });

    const result = await collector.collectHeadlessResponse({
      stdout: "",
      stderr,
      exitCode: 0,
      promptForSessionLog: "just say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.cliResult.success, false);
    assert.strictEqual(result.cliResult.response, stderr);
    assert.strictEqual(result.cliResult.error, stderr);
    assert.strictEqual(result.failureKind, FAILURE_KINDS.UNKNOWN);
    assert.strictEqual(result.failureMessage, stderr);
    assert.strictEqual(result.extractedSessionId, undefined);
    assert.strictEqual(logExtractionCalled, false);
    assert.deepStrictEqual(loggedResponses, [
      { response: stderr, statistics: "" },
    ]);
    assert.deepStrictEqual(completedResponses, [stderr]);
  });

  test("should skip log-based session extraction when resuming an existing session", async () => {
    let logExtractionCalled = false;

    const collector = new CliResponseCollector({
      provider: {
        responseParser: {
          parse: () => createParsedOutput(),
          parseTokenCounts: () => undefined,
        },
        extractSessionIdFromLogs: async () => {
          logExtractionCalled = true;
          return "session-from-log";
        },
      } as Pick<
        ICliProvider,
        "responseParser" | "augmentParsedOutput" | "extractSessionIdFromLogs"
      >,
      hostCallbacks: {
        logResponse: () => {},
        onResponseComplete: () => {},
      },
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

  test("should classify non-zero headless exits as processExit", async () => {
    const collector = new CliResponseCollector({
      provider: {
        responseParser: {
          parse: () => ({ events: [], metadata: {} }),
          parseTokenCounts: () => undefined,
        },
      } as Pick<
        ICliProvider,
        "responseParser" | "augmentParsedOutput" | "extractSessionIdFromLogs"
      >,
      hostCallbacks: {
        logResponse: () => {},
        onResponseComplete: () => {},
      },
    });

    const result = await collector.collectHeadlessResponse({
      stdout: "",
      stderr: "process crashed",
      exitCode: 2,
      promptForSessionLog: "say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.failureKind, FAILURE_KINDS.PROCESS_EXIT);
    assert.strictEqual(result.failureMessage, "process crashed");
    assert.strictEqual(result.cliResult.error, "process crashed");
  });
});
