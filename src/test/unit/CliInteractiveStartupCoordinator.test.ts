import * as assert from "assert";
import { suite, test } from "mocha";
import { CliInteractiveStartupCoordinator } from "../../core/harness/shared/CliInteractiveStartupCoordinator";
import { INTERACTIVE_ABORT_KINDS } from "../../types/DashboardConstants";

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
      getAbortState: () => ({
        kind: INTERACTIVE_ABORT_KINDS.PROCESS_EXITED,
        exitCode: 0,
      }),
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

  test("should recover from SessionStart timeout via delayed log discovery", async () => {
    let failureReason: string | undefined;

    const coordinator = new CliInteractiveStartupCoordinator({
      logParser: {
        extractResponse: () => ({ events: [], metadata: {} }),
        isComplete: () => false,
        watchLogFile: () => ({ close() {} }) as any,
        readNewLines: async () => [{ type: "session.created" }],
        discoverSessionLog: async () => "C:/logs/late-session.jsonl",
        extractSessionId: () => "late-session-id",
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
        waitForSessionStart: async () => ({
          completed: false,
          error: "Timeout waiting for SessionStart notification",
        }),
      },
      getWorkspaceRoot: () => process.cwd(),
      getAbortState: () => null,
      markProcessExitDuringStage: (_stage: string, exitCode: number) =>
        `process exit ${exitCode}`,
      setFailureReason: (reason: string) => {
        failureReason = reason;
      },
      startupTimeouts: {
        sessionStartSoftTimeoutMs: 5,
        sessionStartHardTimeoutMs: 25,
        sessionStartPollMs: 1,
        lateStartRecoveryPollMs: 1,
      },
    });

    const result = await coordinator.resolveSession({
      promptForDiscovery: "say hi",
      startTime: new Date(),
      runId: "run-4",
    });

    assert.deepStrictEqual(result, {
      logPath: "C:/logs/late-session.jsonl",
      sessionId: "late-session-id",
    });
    assert.strictEqual(failureReason, undefined);
  });

  test("should recover via delayed log discovery after session-start hook provides session ID", async () => {
    let failureReason: string | undefined;
    let discoverAttempts = 0;

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
          discoverAttempts += 1;
          assert.strictEqual(sessionId, "hook-session-id");
          return discoverAttempts >= 2 ? "C:/logs/hook-session.log" : null;
        },
        extractSessionId: () => "hook-session-id",
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
        waitForSessionStart: async () => ({
          completed: true,
          data: {
            hookEvent: "PreInvocation",
            sessionId: "hook-session-id",
          },
        }),
      },
      getWorkspaceRoot: () => process.cwd(),
      getAbortState: () => null,
      markProcessExitDuringStage: (_stage: string, exitCode: number) =>
        `process exit ${exitCode}`,
      setFailureReason: (reason: string) => {
        failureReason = reason;
      },
      startupTimeouts: {
        sessionStartSoftTimeoutMs: 5,
        sessionStartHardTimeoutMs: 25,
        sessionStartPollMs: 1,
        lateStartRecoveryPollMs: 1,
      },
    });

    const result = await coordinator.resolveSession({
      promptForDiscovery: "say hi",
      startTime: new Date(),
      runId: "run-4a",
    });

    assert.deepStrictEqual(result, {
      logPath: "C:/logs/hook-session.log",
      sessionId: "hook-session-id",
    });
    assert.ok(discoverAttempts >= 2);
    assert.strictEqual(failureReason, undefined);
  });

  test("should recover via delayed log discovery when SessionStart is unsupported", async () => {
    let failureReason: string | undefined;
    let discoverAttempts = 0;

    const coordinator = new CliInteractiveStartupCoordinator({
      logParser: {
        extractResponse: () => ({ events: [], metadata: {} }),
        isComplete: () => false,
        watchLogFile: () => ({ close() {} }) as any,
        readNewLines: async () => [{ type: "session.created" }],
        discoverSessionLog: async () => {
          discoverAttempts += 1;
          return discoverAttempts >= 2 ? "C:/logs/late-antigravity.log" : null;
        },
        extractSessionId: () => "late-session-id",
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
      setFailureReason: (reason: string) => {
        failureReason = reason;
      },
      startupTimeouts: {
        sessionStartSoftTimeoutMs: 5,
        sessionStartHardTimeoutMs: 25,
        sessionStartPollMs: 1,
        lateStartRecoveryPollMs: 1,
      },
    });

    const result = await coordinator.resolveSession({
      promptForDiscovery: "say hi",
      startTime: new Date(),
      runId: "run-4b",
    });

    assert.deepStrictEqual(result, {
      logPath: "C:/logs/late-antigravity.log",
      sessionId: "late-session-id",
    });
    assert.ok(discoverAttempts >= 2);
    assert.strictEqual(failureReason, undefined);
  });

  test("should fail after hard startup timeout when no hook or log ever arrives", async function () {
    this.timeout(1_000);

    let failureReason: string | undefined;
    let discoverAttempts = 0;

    const coordinator = new CliInteractiveStartupCoordinator({
      logParser: {
        extractResponse: () => ({ events: [], metadata: {} }),
        isComplete: () => false,
        watchLogFile: () => ({ close() {} }) as any,
        readNewLines: async () => [],
        discoverSessionLog: async () => {
          discoverAttempts += 1;
          return null;
        },
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
        waitForSessionStart: async () => ({
          completed: false,
          error: "Timeout waiting for SessionStart notification",
        }),
      },
      getWorkspaceRoot: () => process.cwd(),
      getAbortState: () => null,
      markProcessExitDuringStage: (_stage: string, exitCode: number) =>
        `process exit ${exitCode}`,
      setFailureReason: (reason: string) => {
        failureReason = reason;
      },
      startupTimeouts: {
        sessionStartSoftTimeoutMs: 5,
        sessionStartHardTimeoutMs: 20,
        sessionStartPollMs: 1,
        lateStartRecoveryPollMs: 1,
      },
    });

    const result = await coordinator.resolveSession({
      promptForDiscovery: "say hi",
      startTime: new Date(),
      runId: "run-5",
    });

    assert.strictEqual(result, null);
    assert.ok(discoverAttempts > 0);
    assert.strictEqual(
      failureReason,
      "Timed out waiting for interactive session startup after 20ms"
    );
  });
});
