import * as assert from "assert";
import { suite, test } from "mocha";
import { CliTransportCoordinator } from "../../core/harness/shared/CliTransportCoordinator";
import type { HeadlessStreamingSource } from "../../core/harness/shared/HeadlessLogTail";
import type { ICliProvider } from "../../core/harness/shared/interfaces/ICliProvider";
import { MESSAGE_TYPES, SESSION_KINDS } from "../../types/DashboardConstants";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";

async function resolveCommand(command: string, args: string[]) {
  return {
    command,
    args,
    displayCommand: [command, ...args].join(" "),
    launcherKind: "direct" as const,
  };
}

suite("CliTransportCoordinator", () => {
  test("should preserve headless prompt text and emit prompt-ready info", async () => {
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
        buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
          promptText,
          ...baseArgs,
        ],
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {
        spawn: async (
          _command: string,
          args: string[],
          options?: { onStdout?: (chunk: string) => void; shell?: boolean }
        ) => {
          assert.strictEqual(args[0], "line one\nline two");
          assert.strictEqual(options?.shell, false);
          options?.onStdout?.("chunk");
          return { stdout: "stdout", stderr: "", exitCode: 0 };
        },
        isActive: () => false,
      } as any,
      resolveCliCommand: resolveCommand,
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
      cliCommand: "test-cli line one\nline two",
    });
    assert.deepStrictEqual(streamedChunks, ["chunk"]);
    assert.deepStrictEqual(cleanedTempPaths, [["temp-a.md"]]);
  });

  test("should stream migrated stdout events through the log parser mapping", async () => {
    const streamedEvents: string[] = [];
    const parser = {
      extractStructuredEventsFromEvent: (event: { type: string }) => [
        { type: "text", data: { text: event.type } },
      ],
      trackBackgroundWorkState: () => {},
      extractLiveContextWindow: () => null,
    } as any;
    const source: HeadlessStreamingSource = {
      parser,
      mode: "stdout",
      parseStdout: () => [{ type: "log-event" }],
    };

    const coordinator = new CliTransportCoordinator({
      provider: {
        config: {
          name: "test-cli",
          displayName: "Test CLI",
          terminalName: "Test",
          installHint: "",
          shouldStreamHeadlessOutput: false,
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
        buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
          promptText,
          ...baseArgs,
        ],
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {
        spawn: async (
          _command: string,
          _args: string[],
          options?: { onStdout?: (chunk: string) => void }
        ) => {
          options?.onStdout?.("stdout chunk");
          return { stdout: "stdout", stderr: "", exitCode: 0 };
        },
        isActive: () => false,
      } as any,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: {
        onBeforeInteractiveStart: () => {},
        onCommandPrepared: () => {},
        onStreamingChunk: () => {
          throw new Error("legacy streaming path should not run");
        },
        onStreamingEvents: (events) => {
          streamedEvents.push(
            ...events.map((event) => (event.data as { text: string }).text)
          );
        },
        onResponseComplete: () => {},
        onPtyExit: () => {},
        cleanupTempFiles: async () => {},
      },
    });

    const success = await coordinator.executeHeadless(
      [],
      "prompt",
      [],
      async () => true,
      undefined,
      source
    );

    assert.strictEqual(success, true);
    assert.deepStrictEqual(streamedEvents, ["log-event"]);
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
        buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
          promptText,
          ...baseArgs,
        ],
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {
        spawn: async () => ({
          stdout: '{"partial":true}\n',
          stderr: "",
          exitCode: 1,
        }),
        isActive: () => false,
      } as any,
      resolveCliCommand: resolveCommand,
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
      stdout: '{"partial":true}\n',
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
          buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
            promptText,
            ...baseArgs,
          ],
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
        resolveCliCommand: resolveCommand,
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
        buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
          "--interactive",
          promptText,
          ...baseArgs,
        ],
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {} as any,
      resolveCliCommand: resolveCommand,
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

  test("should merge provider.getInteractiveSpawnEnv() into the PTY spawn env", async () => {
    // Regression test: startInteractiveProcess() previously only merged process.env
    // with the caller's per-invocation env (hook vars etc.), silently dropping any
    // provider-level interactive env override — e.g. Copilot's OTel export path
    // (buildOtelSpawnEnv()) or Claude's CLAUDECODE removal. Both providers define
    // getInteractiveSpawnEnv() specifically so this call site would use it.
    let spawnedEnv: NodeJS.ProcessEnv | undefined;

    const coordinator = new CliTransportCoordinator({
      provider: {
        config: {
          name: "test-cli",
          displayName: "Test CLI",
          terminalName: "Test",
          installHint: "",
          shouldStreamHeadlessOutput: false,
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
        buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
          "--interactive",
          promptText,
          ...baseArgs,
        ],
        checkAvailability: async () => true,
        getInteractiveSpawnEnv: () => ({
          PROVIDER_OTEL_MARKER: "from-provider",
        }),
      } as unknown as ICliProvider,
      processManager: {} as any,
      resolveCliCommand: resolveCommand,
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
          getExpectedController: (_workflowId: string) => undefined,
          spawnPty: (config: {
            sessionId: string;
            workflowId: string;
            kind: string;
            env?: NodeJS.ProcessEnv;
          }) => {
            spawnedEnv = config.env;
            return {
              id: config.sessionId,
              workflowId: config.workflowId,
              kind: config.kind,
              reconnectBuffer: [],
            };
          },
        }) as any,
    });

    await coordinator.startInteractiveProcess([], "prompt", undefined, {
      CTRLYOKE_RUN_ID: "run-123",
    });

    assert.strictEqual(spawnedEnv?.PROVIDER_OTEL_MARKER, "from-provider");
    assert.strictEqual(spawnedEnv?.CTRLYOKE_RUN_ID, "run-123");
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
        buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
          "--interactive",
          promptText,
          ...baseArgs,
        ],
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {} as any,
      resolveCliCommand: resolveCommand,
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
        buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
          "--interactive",
          promptText,
          ...baseArgs,
        ],
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {} as any,
      resolveCliCommand: resolveCommand,
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
        buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
          "--interactive",
          promptText,
          ...baseArgs,
        ],
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
      resolveCliCommand: resolveCommand,
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
        buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
          "--interactive",
          promptText,
          ...baseArgs,
        ],
        checkAvailability: async () => true,
      } as unknown as ICliProvider,
      processManager: {
        spawnInteractive: async (_command: string, args: string[]) => {
          assert.deepStrictEqual(args, ["--interactive", "prompt"]);
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
        disposeProcess: () => {
          disposedProcess = true;
        },
      } as any,
      resolveCliCommand: resolveCommand,
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
