import * as assert from "assert";
import { suite, test } from "mocha";
import { FAILURE_KINDS } from "../../types/DashboardConstants";
import { CliLogMonitor } from "../../core/harness/CliLogMonitor";
import { CliExecutionSession } from "../../core/harness/shared/CliExecutionSession";
import {
  CliExecutionRunner,
  type InteractiveInjectContext,
} from "../../core/harness/shared/CliExecutionRunner";
import { CliFailureTracker } from "../../core/harness/shared/CliFailureTracker";
import { CliInteractiveStartupCoordinator } from "../../core/harness/shared/CliInteractiveStartupCoordinator";
import type { ICliProvider } from "../../core/harness/shared/interfaces/ICliProvider";

function createProvider(options?: {
  supportsSessionStart?: boolean;
  waitForSessionStart?: (
    onCancel?: () => boolean
  ) => Promise<{ completed: boolean; error?: string; data?: unknown }>;
  discoverSessionLog?: () => Promise<string | null>;
}): ICliProvider {
  return {
    config: {
      name: "test",
      displayName: "Test CLI",
      terminalName: "Test",
      installHint: "",
      shouldStreamHeadlessOutput: false,
    },
    responseParser: {
      parse: () => ({ events: [], metadata: {} }),
      parseTokenCounts: () => undefined,
    },
    notificationMonitor: {
      supportsSessionIdInFilename: true,
      supportsSessionStart: options?.supportsSessionStart ?? true,
      monitorForCompletion: async () => ({ completed: false }),
      buildHookConfig: () => ({ type: "none" as const }),
      getNotificationDirectory: () => process.cwd(),
      waitForSessionStart: async (
        _config: unknown,
        _startTime: Date,
        _runId?: string,
        onCancel?: () => boolean
      ) => {
        if (options?.waitForSessionStart) {
          return options.waitForSessionStart(onCancel);
        }

        return {
          completed: false,
          error: onCancel?.() ? "cancelled" : "pending",
        };
      },
    },
    toolPermissionMapper: {
      hasFullPermissions: () => true,
    },
    logParser: {
      extractResponse: () => ({ events: [], metadata: {} }),
      isComplete: () => false,
      watchLogFile: () => ({ close() {} }) as never,
      readNewLines: async () => [],
      discoverSessionLog: async () => {
        if (options?.discoverSessionLog) {
          return options.discoverSessionLog();
        }
        return null;
      },
      extractSessionId: () => null,
      extractStructuredEventsFromEvent: () => [],
      extractContentFromEvent: () => undefined,
      formatStatistics: () => "",
      getFinalEventsOnCompletion: async () => [],
    },
    buildCliArgs: async () => [],
    buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
      ...baseArgs,
      prompt,
    ],
    buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
      promptText,
      ...baseArgs,
    ],
    checkAvailability: async () => true,
  } as unknown as ICliProvider;
}

function createRunner(options?: {
  supportsSessionStart?: boolean;
  waitForSessionStart?: (
    onCancel?: () => boolean
  ) => Promise<{ completed: boolean; error?: string; data?: unknown }>;
  discoverSessionLog?: () => Promise<string | null>;
  writeToCurrentPtySession?: (text: string) => boolean;
  isCancelling?: boolean;
  collectedHeadlessResponse?: {
    success: boolean;
    error?: string;
    sessionId?: string;
  };
}) {
  const failureTracker = new CliFailureTracker();
  let failureReason: string | undefined;
  const provider = createProvider(options);

  const runner = new CliExecutionRunner({
    provider,
    transportCoordinator: {
      executeStandaloneInteractiveProcess: async () => ({ success: true }),
      startInteractiveProcess: async () => {
        failureTracker.capturePtyExit(0, []);
      },
      executeHeadless: async (_args, _prompt, _tempFiles, callback) => {
        return callback({
          stdout: "",
          stderr: options?.collectedHeadlessResponse?.error ?? "",
          exitCode:
            options?.collectedHeadlessResponse?.success === false ? 1 : 0,
        });
      },
      writeToCurrentPtySession:
        options?.writeToCurrentPtySession ?? (() => false),
    },
    failureTracker,
    factories: {
      createInteractiveStartupCoordinator: () =>
        new CliInteractiveStartupCoordinator({
          logParser: provider.logParser!,
          notificationMonitor: provider.notificationMonitor,
          getWorkspaceRoot: () => process.cwd(),
          getAbortState: () => failureTracker.getInteractiveAbortState(false),
          markProcessExitDuringStage: (stage: string, exitCode: number) =>
            failureTracker.markProcessExitDuringStage(stage, exitCode),
          setFailureReason: (reason: string) => {
            failureReason = reason;
          },
        }),
      createResponseCollector: () => ({
        collectHeadlessResponse: async () => ({
          success: options?.collectedHeadlessResponse?.success ?? true,
          parsedOutput: { events: [], metadata: {} },
          extractedSessionId: options?.collectedHeadlessResponse?.sessionId,
          cliResult: {
            success: options?.collectedHeadlessResponse?.success ?? true,
            response: "",
            statistics: "",
            error: options?.collectedHeadlessResponse?.error,
          },
        }),
      }),
      cleanupTempFiles: async () => {},
    },
    runtimeState: {
      getWorkspaceRoot: () => process.cwd(),
      getExtensionPath: () => process.cwd(),
      isVsCodeContext: () => true,
      isCancelling: () => options?.isCancelling ?? false,
      setFailureReason: (reason: string) => {
        failureReason = reason;
      },
    },
    hostCallbacks: {
      onStreamingEvents: () => {},
      onResponseComplete: () => {},
      logResponse: () => {},
    },
  });

  return {
    runner,
    failureTracker,
    getFailureReason: () => failureReason,
  };
}

suite("CliExecutionRunner", () => {
  test("should flag PTY exit while waiting for SessionStart", async () => {
    let cancelObserved = false;
    const { runner, failureTracker, getFailureReason } = createRunner({
      waitForSessionStart: async (onCancel) => {
        cancelObserved = onCancel?.() ?? false;
        return {
          completed: false,
          error: cancelObserved ? "cancelled" : "still waiting",
        };
      },
    });

    const success = await runner.executeInteractive(
      new CliExecutionSession({ prompt: { prompt: "just say hi" } }),
      []
    );

    assert.strictEqual(success, false);
    assert.strictEqual(cancelObserved, true);
    assert.strictEqual(failureTracker.wasLastFailureProcessExit(), true);
    const failureReason = getFailureReason();
    assert.ok(failureReason);
    assert.match(failureReason, /waiting for SessionStart hook/iu);
  });

  test("should stop early when PTY exits during session log discovery", async function () {
    this.timeout(5_000);

    const { runner, failureTracker, getFailureReason } = createRunner({
      supportsSessionStart: false,
      discoverSessionLog: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return null;
      },
    });

    const startedAt = Date.now();
    const success = await runner.executeInteractive(
      new CliExecutionSession({ prompt: { prompt: "just say hi" } }),
      []
    );
    const elapsedMs = Date.now() - startedAt;

    assert.strictEqual(success, false);
    assert.ok(
      elapsedMs < 300,
      `expected discovery to abort quickly after PTY exit, but it took ${elapsedMs}ms`
    );
    assert.strictEqual(failureTracker.wasLastFailureProcessExit(), true);
    const failureReason = getFailureReason();
    assert.ok(failureReason);
    assert.match(failureReason, /discovering the session log/iu);
  });

  test("should send inject prompt in chunks with repeated focus and submit pulses", async function () {
    this.timeout(5_000);

    const writes: string[] = [];
    const prompt = "x".repeat(300);
    const { runner, failureTracker } = createRunner({
      writeToCurrentPtySession: (text) => {
        writes.push(text);
        if (text === "\r") {
          failureTracker.capturePtyExit(0, []);
        }
        return true;
      },
    });

    (
      runner as unknown as {
        lastInteractiveContext?: InteractiveInjectContext;
      }
    ).lastInteractiveContext = {
      logPath: "test.log",
      sessionId: "test-session",
    };

    const result = await runner.executeInteractiveInject(
      new CliExecutionSession({ prompt: { prompt } })
    );

    assert.deepStrictEqual(writes, [
      "\x1b[I",
      "\x1b[I",
      "x".repeat(256),
      "x".repeat(44),
      "\r",
      "\r",
    ]);
    assert.deepStrictEqual(result, { injected: false });
  });

  test("should expose collector failure reason for headless execution failures", async () => {
    const { runner, failureTracker, getFailureReason } = createRunner({
      collectedHeadlessResponse: {
        success: false,
        error: "error: unknown option '--poop'",
      },
    });

    const success = await runner.executeHeadless(
      new CliExecutionSession({ prompt: { prompt: "just say hi" } }),
      []
    );

    assert.strictEqual(success, false);
    assert.strictEqual(getFailureReason(), "error: unknown option '--poop'");
    assert.strictEqual(
      failureTracker.getLastFailureKind(),
      FAILURE_KINDS.PROCESS_EXIT
    );
  });

  test("should report stopped by user for cancelled headless execution", async () => {
    const { runner, getFailureReason } = createRunner({
      isCancelling: true,
      collectedHeadlessResponse: {
        success: false,
        error: "Process exited with code 1",
      },
    });

    const success = await runner.executeHeadless(
      new CliExecutionSession({ prompt: { prompt: "just say hi" } }),
      []
    );

    assert.strictEqual(success, false);
    assert.strictEqual(getFailureReason(), "Stopped by user");
  });

  test("should persist a resolved session ID through the live working-file seam", async () => {
    const { runner } = createRunner({
      collectedHeadlessResponse: {
        success: true,
        sessionId: "session-live-123",
      },
    });
    const persisted: Array<{ promptIndex: number; sessionId: string }> = [];
    const session = new CliExecutionSession({
      prompt: { prompt: "just say hi" },
      workflowContext: {
        promptIndex: 0,
        allPrompts: [{ prompt: "just say hi" }],
        workingFilePersistence: {
          updateWorkingFile: async () => {},
          persistSessionId: async (promptIndex, sessionId) => {
            persisted.push({ promptIndex, sessionId });
          },
        },
      },
    });

    const success = await runner.executeHeadless(session, []);

    assert.strictEqual(success, true);
    assert.strictEqual(session.effectiveSessionId, "session-live-123");
    assert.deepStrictEqual(persisted, [
      { promptIndex: 0, sessionId: "session-live-123" },
    ]);
  });

  test("should classify log monitor timeouts without throwing", async () => {
    const { runner, failureTracker, getFailureReason } = createRunner();
    const originalMonitor = CliLogMonitor.prototype.monitor;

    try {
      CliLogMonitor.prototype.monitor = async () => {
        return {
          success: false,
          failureKind: FAILURE_KINDS.TIMEOUT,
          failureMessage: "Log monitoring timeout",
          timedOut: true,
        };
      };

      const result = await (runner as any).monitorLogFile(
        "test.log",
        new CliExecutionSession({ prompt: { prompt: "just say hi" } }),
        { sessionId: null, startTime: new Date() }
      );

      assert.deepStrictEqual(result, { success: false, sessionId: undefined });
      assert.strictEqual(failureTracker.wasLastFailureTimeout(), true);
      assert.strictEqual(getFailureReason(), "Log monitoring timeout");
    } finally {
      CliLogMonitor.prototype.monitor = originalMonitor;
    }
  });
});
