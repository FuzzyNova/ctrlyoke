import * as assert from "assert";
import { suite, test } from "mocha";
import { FAILURE_KINDS } from "../../types/DashboardConstants";
import { getTranscriptText } from "../../utils/StepOutputText";
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
    let completedResponses = 0;
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
          onResponseComplete: () => completedResponses++,
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
      assert.strictEqual(
        getTranscriptText(result.parsedOutput.events),
        "hello world"
      );
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
      assert.strictEqual(completedResponses, 1);
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
    let completedResponses = 0;
    const result = await new CliResponseCollector({
      provider,
      hostCallbacks: {
        logResponse: (response, statistics) =>
          loggedResponses.push({ response, statistics }),
        onResponseComplete: () => completedResponses++,
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
    assert.strictEqual(completedResponses, 1);
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

  test("should prefer parsed harness error text over a bare exit code", async () => {
    const result = await createCollector(
      createProvider(
        createParsedOutput({
          events: [
            { type: "text" as any, data: { text: "Provider rejected key" } },
          ],
          metadata: { error: "Provider rejected key" },
        })
      )
    ).collectHeadlessResponse({
      stdout: '{"type":"error"}',
      stderr: "",
      exitCode: 1,
      promptForSessionLog: "say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.failureKind, FAILURE_KINDS.PROCESS_EXIT);
    assert.strictEqual(result.failureMessage, "Provider rejected key");
    assert.strictEqual(result.cliResult.error, "Provider rejected key");
  });

  test("should classify a killed process as cancellation, not a harness failure", async () => {
    // Regression: ctrlyoke's own teardown SIGKILLed a running harness, Node
    // reported exit code null (coalesced to 1), and the step was reported as
    // "Process exited unexpectedly" with whatever chatter was on stderr as the
    // reason — inviting a retry of something that never failed on its own.
    const result = await createCollector(
      createProvider({ events: [], metadata: {} })
    ).collectHeadlessResponse({
      stdout: "",
      stderr: "Reading additional input from stdin...",
      exitCode: 1,
      terminationSignal: "SIGKILL",
      promptForSessionLog: "say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.failureKind, FAILURE_KINDS.USER_CANCELLED);
    assert.strictEqual(
      result.failureMessage,
      "Harness process was terminated (SIGKILL)"
    );
  });

  test("should not quote stderr progress chatter as the reason a process exited", async () => {
    // "Reading additional input from stdin..." is what Codex prints whenever
    // its stdin is the NUL handle — i.e. on every headless run. It says
    // nothing about why the process ended, so the exit code is the honest
    // answer. The full stderr still reaches the log.
    const result = await createCollector(
      createProvider({ events: [], metadata: {} })
    ).collectHeadlessResponse({
      stdout: "",
      stderr: "Reading additional input from stdin...\nWorking...",
      exitCode: 1,
      promptForSessionLog: "say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(result.failureKind, FAILURE_KINDS.PROCESS_EXIT);
    assert.strictEqual(result.failureMessage, "Process exited with code 1");
  });

  test("should keep a diagnostic line that sits among stderr chatter", async () => {
    const result = await createCollector(
      createProvider({ events: [], metadata: {} })
    ).collectHeadlessResponse({
      stdout: "",
      stderr: [
        "Reading additional input from stdin...",
        "error: model 'nope' is not available",
        "Shutting down...",
      ].join("\n"),
      exitCode: 1,
      promptForSessionLog: "say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(
      result.failureMessage,
      "error: model 'nope' is not available"
    );
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
        onResponseComplete: () => undefined,
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

  test("does not heuristically redact the harness's own response text (prior-context regression)", async () => {
    // Regression: parsed output becomes `$prior-context`/`$step:N` in
    // a later prompt (see PromptQueue/CliPromptPreparer) and commit-message
    // text (CommitMessageGenerator). A value shaped like the heuristic
    // credential-assignment rule but backed by no resolved secret — e.g.
    // ordinary code the model wrote while helping debug auth — must survive
    // verbatim here, or a later step would send the model back a corrupted
    // copy of its own output. This is the same failure mode as redacting
    // the standalone shim's generated JS.
    const responseText = 'const token = "example-not-a-real-secret";';
    const collector = createCollector(
      createProvider(
        createParsedOutput({
          events: [{ type: "text" as any, data: { text: responseText } }],
        })
      )
    );

    const result = await collector.collectHeadlessResponse({
      stdout: "stdout",
      stderr: "",
      exitCode: 0,
      promptForSessionLog: "say hi",
      executionStartTime: new Date(),
    });

    assert.strictEqual(
      getTranscriptText(result.parsedOutput.events),
      responseText
    );
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
