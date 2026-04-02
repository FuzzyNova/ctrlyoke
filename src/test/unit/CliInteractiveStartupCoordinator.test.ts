import * as assert from "assert";
import { suite, test } from "mocha";
import { CliInteractiveStartupCoordinator } from "../../flightpath/harness/shared/CliInteractiveStartupCoordinator";

suite("CliInteractiveStartupCoordinator", () => {
  test("should seek to end for resumed session logs", async () => {
    let seekedPath: string | undefined;

    const coordinator = new CliInteractiveStartupCoordinator({
      logParser: {
        extractResponse: () => ({ events: [], metadata: {} }),
        isComplete: () => false,
        watchLogFile: () => ({ close() {} }) as any,
        readNewLines: async () => [],
        discoverSessionLog: async (
          _promptText: string,
          _startTime: Date,
          sessionId?: string
        ) => {
          assert.strictEqual(sessionId, "session-123");
          return "C:/logs/session-123.jsonl";
        },
        extractSessionId: () => null,
        extractStructuredEventsFromEvent: () => [],
        extractContentFromEvent: () => undefined,
        formatStatistics: () => "",
        getFinalEventsOnCompletion: async () => [],
        seekToEnd: (filePath: string) => {
          seekedPath = filePath;
        },
      },
      notificationMonitor: {
        supportsSessionIdInFilename: true,
        supportsSessionStart: true,
        monitorForCompletion: async () => ({ completed: false }),
        buildHookConfig: () => ({ type: "none" as const }),
        getNotificationDirectory: () => process.cwd(),
      },
      getWorkspaceRoot: () => process.cwd(),
      getAbortState: () => null,
      markProcessExitDuringStage: (_stage: string, exitCode: number) =>
        `process exit ${exitCode}`,
      setFailureReason: () => {},
    });

    const result = await coordinator.resolveSession({
      promptForDiscovery: "say hi",
      startTime: new Date(),
      resolvedSessionId: "session-123",
      runId: "run-1",
    });

    assert.deepStrictEqual(result, {
      logPath: "C:/logs/session-123.jsonl",
      sessionId: "session-123",
    });
    assert.strictEqual(seekedPath, "C:/logs/session-123.jsonl");
  });

  test("should stop when process exits during SessionStart wait", async () => {
    let failureReason: string | undefined;
    let cancelObserved = false;

    const coordinator = new CliInteractiveStartupCoordinator({
      logParser: {
        extractResponse: () => ({ events: [], metadata: {} }),
        isComplete: () => false,
        watchLogFile: () => ({ close() {} }) as any,
        readNewLines: async () => [],
        discoverSessionLog: async () => null,
        extractSessionId: () => null,
        extractStructuredEventsFromEvent: () => [],
        extractContentFromEvent: () => undefined,
        formatStatistics: () => "",
        getFinalEventsOnCompletion: async () => [],
      },
      notificationMonitor: {
        supportsSessionIdInFilename: true,
        supportsSessionStart: true,
        monitorForCompletion: async () => ({ completed: false }),
        buildHookConfig: () => ({ type: "none" as const }),
        getNotificationDirectory: () => process.cwd(),
        waitForSessionStart: async (
          _config: unknown,
          _startTime: Date,
          _runId?: string,
          onCancel?: () => boolean
        ) => {
          cancelObserved = onCancel?.() ?? false;
          return {
            completed: false,
            error: cancelObserved ? "cancelled" : "still waiting",
          };
        },
      },
      getWorkspaceRoot: () => process.cwd(),
      getAbortState: () => ({ kind: "process-exited", exitCode: 0 }),
      markProcessExitDuringStage: (stage: string, exitCode: number) =>
        `CLI process exited unexpectedly while ${stage} (exit code ${exitCode})`,
      setFailureReason: (reason: string) => {
        failureReason = reason;
      },
    });

    const result = await coordinator.resolveSession({
      promptForDiscovery: "say hi",
      startTime: new Date(),
      runId: "run-2",
    });

    assert.strictEqual(result, null);
    assert.strictEqual(cancelObserved, true);
    assert.strictEqual(
      failureReason,
      "CLI process exited unexpectedly while waiting for SessionStart hook (exit code 0)"
    );
  });

  test("should extract session ID from discovered log when no hook session ID exists", async () => {
    const coordinator = new CliInteractiveStartupCoordinator({
      logParser: {
        extractResponse: () => ({ events: [], metadata: {} }),
        isComplete: () => false,
        watchLogFile: () => ({ close() {} }) as any,
        readNewLines: async () => [{ type: "session.created" }],
        discoverSessionLog: async () => "C:/logs/discovered.jsonl",
        extractSessionId: () => "session-from-log",
        extractStructuredEventsFromEvent: () => [],
        extractContentFromEvent: () => undefined,
        formatStatistics: () => "",
        getFinalEventsOnCompletion: async () => [],
      },
      notificationMonitor: {
        supportsSessionIdInFilename: true,
        supportsSessionStart: false,
        monitorForCompletion: async () => ({ completed: false }),
        buildHookConfig: () => ({ type: "none" as const }),
        getNotificationDirectory: () => process.cwd(),
      },
      getWorkspaceRoot: () => process.cwd(),
      getAbortState: () => null,
      markProcessExitDuringStage: (_stage: string, exitCode: number) =>
        `process exit ${exitCode}`,
      setFailureReason: () => {},
    });

    const result = await coordinator.resolveSession({
      promptForDiscovery: "say hi",
      startTime: new Date(),
      runId: "run-3",
    });

    assert.deepStrictEqual(result, {
      logPath: "C:/logs/discovered.jsonl",
      sessionId: "session-from-log",
    });
  });
});
