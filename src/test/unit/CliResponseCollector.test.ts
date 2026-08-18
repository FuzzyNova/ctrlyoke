import * as assert from "assert";
import { suite, test } from "mocha";
import { FAILURE_KINDS } from "../../types/DashboardConstants";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import { CliResponseCollector } from "../../core/harness/shared/CliResponseCollector";
import type { BaseCliEvent } from "../../core/harness/shared/interfaces/ILogParser";
import { Log } from "../../utils/Log";
import {
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";

function createParsedOutput(
  overrides?: Partial<UniversalCliOutput>
): UniversalCliOutput {
  return {
    events: [{ type: "text" as any, data: { text: "hello world" } }],
    metadata: {},
    ...overrides,
  };
}

function createProvider(output = createParsedOutput()) {
  return {
    parseHeadlessStdout: () => [],
    logParser: { extractResponse: () => output },
  } as any;
}

function createCollector(provider: any) {
  return new CliResponseCollector({
    provider,
    hostCallbacks: { logResponse: () => {}, onResponseComplete: () => {} },
  });
}

suite("CliResponseCollector", () => {
  test("should build cli result and prefer session ID from parsed output", async () => {
    const loggedResponses: Array<{ response: string; statistics?: string }> =
      [];
    const completedResponses: string[] = [];
    const debugMessages: string[] = [];
    const originalDebug = Log.debug;
    (Log as unknown as { debug(message: string): void }).debug = (message) =>
      debugMessages.push(message);

    try {
      const collector = new CliResponseCollector({
        provider: {
          ...createProvider(
            createParsedOutput({
              metadata: {
                sessionId: "session-from-output",
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              } as any,
            })
          ),
        },
        hostCallbacks: {
          logResponse: (response, statistics) =>
            loggedResponses.push({ response, statistics }),
          onResponseComplete: (response) => completedResponses.push(response),
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

  test("should call provider-owned augmentation without detaching provider context", async () => {
    const provider = {
      ...createProvider(),
      augmentationSessionId: "augmented-session",
      async augmentParsedOutput(output: UniversalCliOutput) {
        return {
          ...output,
          metadata: {
            ...output.metadata,
            sessionId: this.augmentationSessionId,
          },
        };
      },
    };

    const result = await createCollector(provider).collectHeadlessResponse({
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
      ...createProvider(),
      logSessionId: "session-from-log",
      async extractSessionIdFromLogs(promptText: string) {
        extractedPrompt = promptText;
        return this.logSessionId;
      },
    };

    const result = await createCollector(provider).collectHeadlessResponse({
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
    const stderr = [
      "error: unknown option '--poop'",
      "(Did you mean --prompt?)",
      "",
      "Try 'copilot --help' for more information.",
    ].join("\n");
    const provider = {
      ...createProvider({ events: [], metadata: {} }),
      async extractSessionIdFromLogs() {
        logExtractionCalled = true;
        return "session-from-log";
      },
    };

    const loggedResponses: Array<{ response: string; statistics?: string }> =
      [];
    const completedResponses: string[] = [];
    const result = await new CliResponseCollector({
      provider,
      hostCallbacks: {
        logResponse: (response, statistics) =>
          loggedResponses.push({ response, statistics }),
        onResponseComplete: (response) => completedResponses.push(response),
      },
    }).collectHeadlessResponse({
      stdout: "",
      stderr,
      exitCode: 0,
      promptForSessionLog: "just say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.success, false);
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
    const result = await createCollector({
      ...createProvider(),
      async extractSessionIdFromLogs() {
        logExtractionCalled = true;
        return "session-from-log";
      },
    }).collectHeadlessResponse({
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
    const result = await createCollector(
      createProvider({ events: [], metadata: {} })
    ).collectHeadlessResponse({
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

  test("should redact secret-bearing stderr while keeping the diagnostic", async () => {
    const secret = "Bearer super-secret-token";
    const loggedResponses: string[] = [];
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: secret });
    const release = secretRedactionService.register(redactor);
    const result = await new CliResponseCollector({
      provider: createProvider({ events: [], metadata: {} }),
      hostCallbacks: {
        logResponse: (response) => loggedResponses.push(response),
        onResponseComplete: (response) => loggedResponses.push(response),
      },
    }).collectHeadlessResponse({
      stdout: "",
      stderr: `Failed to parse config: ${secret}`,
      exitCode: 1,
      promptForSessionLog: "prompt",
      executionStartTime: new Date(),
    });
    release();

    // The secret is gone, but the reason for the failure survives — a bare
    // "Process exited with code 1" would be undiagnosable.
    assert.ok(!result.failureMessage?.includes(secret));
    assert.strictEqual(
      result.failureMessage,
      "Failed to parse config: [REDACTED]"
    );
    assert.ok(loggedResponses.every((response) => !response.includes(secret)));
  });

  test("should preserve stderr for providers with no redaction hook", async () => {
    const result = await createCollector({}).collectHeadlessResponse({
      stdout: "",
      stderr: "error: unknown option '--nope'",
      exitCode: 1,
      promptForSessionLog: "prompt",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.failureMessage, "error: unknown option '--nope'");
  });

  test("should route parsed stdout through the log parser mapping", async () => {
    const parsedEvents = [{ type: "stdout-event" }];
    const mappedOutput = createParsedOutput({
      metadata: { sessionId: "stdout-session" } as any,
    });
    let extractedEvents: unknown;
    const result = await createCollector({
      parseHeadlessStdout: () => parsedEvents,
      logParser: {
        extractResponse: (events: BaseCliEvent[]) => {
          extractedEvents = events;
          return mappedOutput;
        },
      },
    }).collectHeadlessResponse({
      stdout: "stdout",
      stderr: "",
      exitCode: 0,
      promptForSessionLog: "prompt",
      executionStartTime: new Date(),
    });

    assert.deepStrictEqual(extractedEvents, parsedEvents);
    assert.strictEqual(result.extractedSessionId, "stdout-session");
  });

  test("should route accumulated tail events through the log parser mapping", async () => {
    const tailEvents = [{ type: "log-event" }];
    const mappedOutput = createParsedOutput({
      metadata: { sessionId: "log-session" } as any,
    });
    let extractedEvents: unknown;
    const result = await createCollector({
      logParser: {
        extractResponse: (events: BaseCliEvent[]) => {
          extractedEvents = events;
          return mappedOutput;
        },
      },
    }).collectHeadlessResponse({
      stdout: "ignored",
      stderr: "",
      exitCode: 0,
      promptForSessionLog: "prompt",
      executionStartTime: new Date(),
      headlessLogTail: {
        getEvents: () => tailEvents,
        getSessionId: () => undefined,
      } as any,
    });

    assert.deepStrictEqual(extractedEvents, tailEvents);
    assert.strictEqual(result.extractedSessionId, "log-session");
  });

  test("an explicit log source wins over a provider's stdout parser", async () => {
    // The streaming path resolves mode from headlessSource, so the final-output
    // path must agree — otherwise a harness streams one mapping and reports
    // another.
    const tailEvents = [{ type: "log-event" }];
    let extractedEvents: unknown;
    let stdoutParseCalls = 0;
    await createCollector({
      headlessSource: "log",
      parseHeadlessStdout: () => {
        stdoutParseCalls += 1;
        return [{ type: "stdout-event" }];
      },
      logParser: {
        extractResponse: (events: BaseCliEvent[]) => {
          extractedEvents = events;
          return createParsedOutput();
        },
      },
    }).collectHeadlessResponse({
      stdout: "ignored",
      stderr: "",
      exitCode: 0,
      promptForSessionLog: "prompt",
      executionStartTime: new Date(),
      headlessLogTail: {
        getEvents: () => tailEvents,
        getSessionId: () => undefined,
      } as any,
    });

    assert.strictEqual(stdoutParseCalls, 0);
    assert.deepStrictEqual(extractedEvents, tailEvents);
  });
});
