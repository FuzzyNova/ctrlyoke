import * as assert from "assert";
import { suite, test } from "mocha";
import { CliTransportCoordinator } from "../../flightpath/harness/shared/CliTransportCoordinator";
import type { ICliProvider } from "../../flightpath/harness/shared/interfaces/ICliProvider";
import { MESSAGE_TYPES, SESSION_KINDS } from "../../types/DashboardConstants";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";

suite("CliTransportCoordinator", () => {
  test("should normalize headless prompt text and emit prompt-ready info", async () => {
    let preparedCommand:
      | { promptArgument: string; cliCommand: string }
      | undefined;
    const streamedChunks: string[] = [];
    const cleanedTempPaths: string[][] = [];

    const coordinator = new CliTransportCoordinator({
      provider: {
        config: {
          name: "test-cli",
          displayName: "Test CLI",
          terminalName: "Test",
          installHint: "",
          shouldStreamHeadlessOutput: true,
        },
        responseParser: {
          parse: () => ({ events: [], metadata: {} }),
          parseTokenCounts: () => undefined,
          processStreamingChunk: (chunk: string) => `processed:${chunk}`,
        },
        notificationMonitor: {
          supportsSessionIdInFilename: true,
          supportsSessionStart: false,
          monitorForCompletion: async () => ({ completed: false }),
          buildHookConfig: () => ({ type: "none" as const }),
          getNotificationDirectory: () => process.cwd(),
        },
        toolPermissionMapper: {},
        buildCliArgs: async () => [],
        buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
          ...baseArgs,
          prompt,
        ],
        buildInteractiveTuiCommand: () => "test-cli",
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {
        spawn: async (
          _command: string,
          args: string[],
          options?: { onStdout?: (chunk: string) => void }
        ) => {
          assert.strictEqual(args[0], "line one line two");
          options?.onStdout?.("chunk");
          return { stdout: "stdout", stderr: "", exitCode: 0 };
        },
        isActive: () => false,
      } as any,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),

        isCancelling: () => false,
      },
      hostCallbacks: {
        onBeforeInteractiveStart: () => {},
        onCommandPrepared: (info) => {
          preparedCommand = info;
        },
        onStreamingChunk: (chunk) => streamedChunks.push(chunk),
        onStreamingEvents: () => {
          throw new Error("expected plain-text streaming path");
        },
        onResponseComplete: () => {},
        onPtyExit: () => {},
        cleanupTempFiles: async (tempFilePaths) => {
          cleanedTempPaths.push(tempFilePaths);
        },
      },
    });

    const success = await coordinator.executeHeadless(
      [],
      "line one\nline two",
      ["temp-a.md"],
      async (result) => {
        assert.deepStrictEqual(result, {
          stdout: "stdout",
          stderr: "",
          exitCode: 0,
        });
        return true;
      }
    );

    assert.strictEqual(success, true);
    assert.deepStrictEqual(preparedCommand, {
      promptArgument: "line one\nline two",
      cliCommand: "test-cli line one line two",
    });
    assert.deepStrictEqual(streamedChunks, ["processed:chunk"]);
    assert.deepStrictEqual(cleanedTempPaths, [["temp-a.md"]]);
  });

  test("should parse partial headless output when cancellation is requested", async () => {
    let callbackResult:
      | { stdout: string; stderr: string; exitCode: number }
      | undefined;
    const cleanedTempPaths: string[][] = [];

    const coordinator = new CliTransportCoordinator({
      provider: {
        config: {
          name: "test-cli",
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
          supportsSessionStart: false,
          monitorForCompletion: async () => ({ completed: false }),
          buildHookConfig: () => ({ type: "none" as const }),
          getNotificationDirectory: () => process.cwd(),
        },
        toolPermissionMapper: {},
        buildCliArgs: async () => [],
        buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
          ...baseArgs,
          prompt,
        ],
        buildInteractiveTuiCommand: () => "test-cli",
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {
        spawn: async () => ({
          stdout: "{\"partial\":true}\n",
          stderr: "",
          exitCode: 1,
        }),
        isActive: () => false,
      } as any,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => true,
      },
      hostCallbacks: {
        onBeforeInteractiveStart: () => {},
        onCommandPrepared: () => {},
        onStreamingChunk: () => {},
        onStreamingEvents: () => {},
        onResponseComplete: () => {},
        onPtyExit: () => {},
        cleanupTempFiles: async (tempFilePaths) => {
          cleanedTempPaths.push(tempFilePaths);
        },
      },
    });

    const success = await coordinator.executeHeadless(
      [],
      "stop me",
      ["temp-a.md"],
      async (result) => {
        callbackResult = result;
        return false;
      }
    );

    assert.strictEqual(success, false);
    assert.deepStrictEqual(callbackResult, {
      stdout: "{\"partial\":true}\n",
      stderr: "",
      exitCode: 1,
    });
    assert.deepStrictEqual(cleanedTempPaths, [["temp-a.md"]]);
  });

  test("should log raw streaming chunks when raw CLI logging is enabled", async () => {
    const debugMessages: string[] = [];
    const originalShouldLogRawCliOutput =
      ConfigurationUtils.shouldLogRawCliOutput;
    const originalDebug = Log.debug;
    (
      ConfigurationUtils as unknown as { shouldLogRawCliOutput: () => boolean }
    ).shouldLogRawCliOutput = () => true;
    (Log as unknown as { debug(message: string): void }).debug = (
      message: string
    ) => {
      debugMessages.push(message);
    };

    try {
      const coordinator = new CliTransportCoordinator({
        provider: {
          config: {
            name: "test-cli",
            displayName: "Test CLI",
            terminalName: "Test",
            installHint: "",
            shouldStreamHeadlessOutput: true,
          },
          responseParser: {
            parse: () => ({ events: [], metadata: {} }),
            parseTokenCounts: () => undefined,
            processStreamingChunk: (chunk: string) => chunk,
          },
          notificationMonitor: {
            supportsSessionIdInFilename: true,
            supportsSessionStart: false,
            monitorForCompletion: async () => ({ completed: false }),
            buildHookConfig: () => ({ type: "none" as const }),
            getNotificationDirectory: () => process.cwd(),
          },
          toolPermissionMapper: {},
          buildCliArgs: async () => [],
          buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
            ...baseArgs,
            prompt,
          ],
          buildInteractiveTuiCommand: () => "test-cli",
          checkAvailability: async () => true,
        } as unknown as ICliProvider,
        processManager: {
          spawn: async (
            _command: string,
            _args: string[],
            options?: { onStdout?: (chunk: string) => void }
          ) => {
            options?.onStdout?.("raw-chunk");
            return { stdout: "stdout", stderr: "", exitCode: 0 };
          },
          isActive: () => false,
        } as any,
        runtimeState: {
          getWorkspaceRoot: () => process.cwd(),

          isCancelling: () => false,
        },
        hostCallbacks: {
          onBeforeInteractiveStart: () => {},
          onCommandPrepared: () => {},
          onStreamingChunk: () => {},
          onStreamingEvents: () => {},
          onResponseComplete: () => {},
          onPtyExit: () => {},
          cleanupTempFiles: async () => {},
        },
      });

      const success = await coordinator.executeHeadless(
        [],
        "prompt",
        [],
        async () => true
      );

      assert.strictEqual(success, true);
      assert.ok(
        debugMessages.some((message) =>
          message.includes("[Test CLI RAW OUTPUT]: raw-chunk")
        )
      );
    } finally {
      (
        ConfigurationUtils as unknown as {
          shouldLogRawCliOutput: () => boolean;
        }
      ).shouldLogRawCliOutput = originalShouldLogRawCliOutput;
      (Log as unknown as { debug(message: string): void }).debug =
        originalDebug;
    }
  });

  test("should use workflow name as PTY workflow ID fallback", async () => {
    const postedMessages: Array<{ workflowId?: string }> = [];

    const coordinator = new CliTransportCoordinator({
      provider: {
        config: {
          name: "test-cli",
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
          supportsSessionStart: false,
          monitorForCompletion: async () => ({ completed: false }),
          buildHookConfig: () => ({ type: "none" as const }),
          getNotificationDirectory: () => process.cwd(),
        },
        toolPermissionMapper: {},
        buildCliArgs: async () => [],
        buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
          ...baseArgs,
          prompt,
        ],
        buildInteractiveTuiCommand: () => "test-cli --interactive",
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {} as any,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),

        getWorkflowName: () => "named-workflow",
        isCancelling: () => false,
      },
      hostCallbacks: {
        onBeforeInteractiveStart: () => {},
        onCommandPrepared: () => {},
        onStreamingChunk: () => {},
        onStreamingEvents: () => {},
        onResponseComplete: () => {},
        onPtyExit: () => {},
        cleanupTempFiles: async () => {},
      },
      postTerminalMessage: (message: unknown) => {
        postedMessages.push(message as { workflowId?: string });
      },
      getPtyManager: () =>
        ({
          getExpectedController: (_workflowId: string) => undefined,
          spawnPty: (config: {
            sessionId: string;
            workflowId: string;
            kind: string;
          }) => ({
            id: config.sessionId,
            workflowId: config.workflowId,
            kind: config.kind,
            reconnectBuffer: [],
          }),
        }) as any,
    });

    await coordinator.startInteractiveProcess([], "prompt");

    assert.strictEqual(postedMessages[0]?.workflowId, "named-workflow");
  });

  test("should refresh active PTY session metadata for inject reuse", async () => {
    const postedMessages: Array<{
      type?: string;
      workflowId?: string;
      sessionId?: string;
      stepName?: string;
      promptNumber?: number;
      kind?: string;
    }> = [];
    const spawnedSession: {
      id?: string;
      workflowId?: string;
      kind?: string;
      stepName?: string;
      promptNumber?: number;
      reconnectBuffer: string[];
    } = { reconnectBuffer: [] };

    const coordinator = new CliTransportCoordinator({
      provider: {
        config: {
          name: "test-cli",
          displayName: "Test CLI",
          terminalName: "Test",
          installHint: "",
          shouldStreamHeadlessOutput: false,
          harnessId: "copilot-cli",
        },
        responseParser: {
          parse: () => ({ events: [], metadata: {} }),
          parseTokenCounts: () => undefined,
        },
        notificationMonitor: {
          supportsSessionIdInFilename: true,
          supportsSessionStart: false,
          monitorForCompletion: async () => ({ completed: false }),
          buildHookConfig: () => ({ type: "none" as const }),
          getNotificationDirectory: () => process.cwd(),
        },
        toolPermissionMapper: {},
        buildCliArgs: async () => [],
        buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
          ...baseArgs,
          prompt,
        ],
        buildInteractiveTuiCommand: () => "test-cli --interactive",
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {} as any,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: {
        onBeforeInteractiveStart: () => {},
        onCommandPrepared: () => {},
        onStreamingChunk: () => {},
        onStreamingEvents: () => {},
        onResponseComplete: () => {},
        onPtyExit: () => {},
        cleanupTempFiles: async () => {},
      },
      postTerminalMessage: (message: unknown) => {
        postedMessages.push(message as (typeof postedMessages)[number]);
      },
      getPtyManager: () =>
        ({
          getExpectedController: (_workflowId: string) => undefined,
          spawnPty: (config: {
            sessionId: string;
            workflowId: string;
            kind: string;
            stepName: string;
            promptNumber?: number;
          }) => {
            Object.assign(spawnedSession, {
              id: config.sessionId,
              workflowId: config.workflowId,
              kind: config.kind,
              stepName: config.stepName,
              promptNumber: config.promptNumber,
            });
            return spawnedSession;
          },
        }) as any,
    });

    await coordinator.startInteractiveProcess([], "prompt", {
      promptIndex: 0,
      allPrompts: [{ prompt: "one" }, { name: "second", prompt: "two" }],
      instanceId: "workflow-1",
    } as any);

    postedMessages.length = 0;
    const refreshed = coordinator.updateCurrentPtySessionMetadata({
      promptIndex: 1,
      allPrompts: [{ prompt: "one" }, { name: "second", prompt: "two" }],
      instanceId: "workflow-1",
    } as any);

    assert.strictEqual(refreshed, true);
    assert.strictEqual(spawnedSession.stepName, "second");
    assert.strictEqual(spawnedSession.promptNumber, 2);
    assert.strictEqual(postedMessages.length, 1);
    assert.strictEqual(postedMessages[0].type, MESSAGE_TYPES.TERMINAL_STARTED);
    assert.strictEqual(postedMessages[0].workflowId, "workflow-1");
    assert.strictEqual(postedMessages[0].sessionId, spawnedSession.id);
    assert.strictEqual(postedMessages[0].stepName, "second");
    assert.strictEqual(postedMessages[0].promptNumber, 2);
    assert.strictEqual(postedMessages[0].kind, SESSION_KINDS.AI_CLI);
  });

  test("should terminate the active PTY session through the PTY manager", async () => {
    let killedSessionId: string | undefined;

    const coordinator = new CliTransportCoordinator({
      provider: {
        config: {
          name: "test-cli",
          displayName: "Test CLI",
          terminalName: "Test",
          installHint: "",
          shouldStreamHeadlessOutput: false,
          harnessId: "copilot-cli",
        },
        responseParser: {
          parse: () => ({ events: [], metadata: {} }),
          parseTokenCounts: () => undefined,
        },
        notificationMonitor: {
          supportsSessionIdInFilename: true,
          supportsSessionStart: false,
          monitorForCompletion: async () => ({ completed: false }),
          buildHookConfig: () => ({ type: "none" as const }),
          getNotificationDirectory: () => process.cwd(),
        },
        toolPermissionMapper: {},
        buildCliArgs: async () => [],
        buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
          ...baseArgs,
          prompt,
        ],
        buildInteractiveTuiCommand: () => "test-cli --interactive",
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {} as any,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: {
        onBeforeInteractiveStart: () => {},
        onCommandPrepared: () => {},
        onStreamingChunk: () => {},
        onStreamingEvents: () => {},
        onResponseComplete: () => {},
        onPtyExit: () => {},
        cleanupTempFiles: async () => {},
      },
      postTerminalMessage: () => {},
      getPtyManager: () =>
        ({
          getExpectedController: () => undefined,
          gracefulKillAiCliSession: async (sessionId: string) => {
            killedSessionId = sessionId;
          },
          spawnPty: (config: { sessionId: string; workflowId: string }) => ({
            id: config.sessionId,
            workflowId: config.workflowId,
            kind: SESSION_KINDS.AI_CLI,
            reconnectBuffer: [],
          }),
        }) as any,
    });

    await coordinator.startInteractiveProcess([], "prompt", {
      promptIndex: 0,
      allPrompts: [{ prompt: "one" }],
      instanceId: "workflow-1",
    } as any);

    const terminatedSessionId =
      await coordinator.terminateCurrentPtySession("headless resume");

    assert.ok(terminatedSessionId);
    assert.strictEqual(killedSessionId, terminatedSessionId);
    assert.strictEqual(
      await coordinator.terminateCurrentPtySession("second call"),
      undefined
    );
  });

  test("should honor closeTerminalOnComplete for active PTY sessions", async () => {
    const killedSessionIds: string[] = [];
    let disposedProcess = false;
    let disposedAll = false;

    const coordinator = new CliTransportCoordinator({
      provider: {
        config: {
          name: "test-cli",
          displayName: "Test CLI",
          terminalName: "Test",
          installHint: "",
          shouldStreamHeadlessOutput: false,
          harnessId: "copilot-cli",
        },
        responseParser: {
          parse: () => ({ events: [], metadata: {} }),
          parseTokenCounts: () => undefined,
        },
        notificationMonitor: {
          supportsSessionIdInFilename: true,
          supportsSessionStart: false,
          monitorForCompletion: async () => ({ completed: false }),
          buildHookConfig: () => ({ type: "none" as const }),
          getNotificationDirectory: () => process.cwd(),
        },
        toolPermissionMapper: {},
        buildCliArgs: async () => [],
        buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
          ...baseArgs,
          prompt,
        ],
        buildInteractiveTuiCommand: () => "test-cli --interactive",
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {
        disposeProcess: () => {
          disposedProcess = true;
        },
        dispose: () => {
          disposedAll = true;
        },
      } as any,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: {
        onBeforeInteractiveStart: () => {},
        onCommandPrepared: () => {},
        onStreamingChunk: () => {},
        onStreamingEvents: () => {},
        onResponseComplete: () => {},
        onPtyExit: () => {},
        cleanupTempFiles: async () => {},
      },
      postTerminalMessage: () => {},
      getPtyManager: () =>
        ({
          getExpectedController: () => undefined,
          gracefulKillAiCliSession: async (sessionId: string) => {
            killedSessionIds.push(sessionId);
          },
          spawnPty: (config: { sessionId: string; workflowId: string }) => ({
            id: config.sessionId,
            workflowId: config.workflowId,
            kind: SESSION_KINDS.AI_CLI,
            reconnectBuffer: [],
          }),
        }) as any,
    });

    await coordinator.startInteractiveProcess([], "prompt", {
      promptIndex: 0,
      allPrompts: [{ prompt: "one" }],
      instanceId: "workflow-1",
    } as any);

    coordinator.dispose(false);

    assert.strictEqual(disposedProcess, true);
    assert.strictEqual(disposedAll, false);
    assert.deepStrictEqual(killedSessionIds, []);

    coordinator.closeTerminal();

    assert.strictEqual(killedSessionIds.length, 1);

    await coordinator.startInteractiveProcess([], "prompt", {
      promptIndex: 0,
      allPrompts: [{ prompt: "one" }],
      instanceId: "workflow-1",
    } as any);

    coordinator.dispose(true);

    assert.strictEqual(disposedAll, true);
    assert.strictEqual(killedSessionIds.length, 2);
  });

  test("should run standalone interactive launch and stop-hook monitor", async () => {
    let disposedProcess = false;
    let responseCompleted: string | undefined;

    const coordinator = new CliTransportCoordinator({
      provider: {
        config: {
          name: "test-cli",
          displayName: "Test CLI",
          terminalName: "Test",
          installHint: "",
          shouldStreamHeadlessOutput: false,
          usesInteractiveNotificationMonitor: true,
        },
        responseParser: {
          parse: () => ({ events: [], metadata: {} }),
          parseTokenCounts: () => undefined,
        },
        notificationMonitor: {
          supportsSessionIdInFilename: true,
          supportsSessionStart: false,
          monitorForCompletion: async () => ({
            completed: true,
            data: { sessionId: "hook-session" },
          }),
          buildHookConfig: () => ({ type: "none" as const }),
          getNotificationDirectory: () => process.cwd(),
          extractSessionId: () => "hook-session",
        },
        toolPermissionMapper: {},
        buildCliArgs: async () => [],
        buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
          ...baseArgs,
          prompt,
        ],
        buildInteractiveTuiCommand: () => "test-cli --interactive",
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {
        spawnInteractive: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
        disposeProcess: () => {
          disposedProcess = true;
        },
      } as any,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),

        isCancelling: () => false,
      },
      hostCallbacks: {
        onBeforeInteractiveStart: () => {},
        onCommandPrepared: () => {},
        onStreamingChunk: () => {},
        onStreamingEvents: () => {},
        onResponseComplete: (response) => {
          responseCompleted = response;
        },
        onPtyExit: () => {},
        cleanupTempFiles: async () => {},
      },
    });

    const result = await coordinator.executeStandaloneInteractiveProcess(
      [],
      "prompt",
      [],
      undefined
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(disposedProcess, true);
    assert.strictEqual(responseCompleted, "Interactive session ended");
  });
});
