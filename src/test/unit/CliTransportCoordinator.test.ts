import * as assert from "assert";
import { suite, test } from "mocha";
import { CliTransportCoordinator } from "../../core/harness/shared/CliTransportCoordinator";
import { PtyProcessManager } from "../../core/harness/PtyProcessManager";
import { CliTransportError } from "../../core/harness/shared/CliTransportError";
import type { HeadlessStreamingSource } from "../../core/harness/shared/HeadlessLogTail";
import type { ICliProvider } from "../../core/harness/shared/interfaces/ICliProvider";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import { OpenCodeCliProvider } from "../../core/harness/opencode/OpenCodeCliProvider";
import {
  HARNESS_IDS,
  HEADLESS_SOURCE_MODES,
  FAILURE_KINDS,
  MESSAGE_TYPES,
  SESSION_KINDS,
  TERMINAL_END_REASONS,
  type TerminalEndReason,
} from "../../types/DashboardConstants";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { CliProcessTimeoutError } from "../../utils/CliProcessManager";
import {
  REDACTION_MARKER,
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";
import { Log } from "../../utils/Log";
import type {
  CliProcessManager,
  InteractiveExitResult,
} from "../../utils/CliProcessManager";

async function resolveCommand(command: string, args: string[]) {
  return {
    command,
    args,
    displayCommand: [command, ...args].join(" "),
    launcherKind: "direct" as const,
  };
}

function createHeadlessProvider(): ICliProvider {
  return {
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
  } as unknown as ICliProvider;
}

function createHeadlessHostCallbacks() {
  return {
    onBeforeInteractiveStart: () => {},
    onCommandPrepared: () => {},
    onStreamingChunk: () => {},
    onStreamingEvents: () => {},
    onResponseComplete: () => {},
    onPtyExit: () => {},
    cleanupTempFiles: async () => {},
  };
}

async function runStdoutSpawns(
  provider: ICliProvider,
  spawnChunks: readonly (readonly string[])[]
): Promise<{ streamedIds: string[]; countsAfterChunks: number[] }> {
  const streamedIds: string[] = [];
  const countsAfterChunks: number[] = [];
  const parser = provider.logParser;
  if (!parser || !provider.parseHeadlessStdout) {
    throw new Error("stdout provider fixture is missing its parser");
  }

  parser.extractStructuredEventsFromEvent = (event) => [
    { type: "text", data: { text: String(event.id) } },
  ];
  parser.trackBackgroundWorkState = () => {};
  parser.extractLiveContextWindow = undefined;

  const source: HeadlessStreamingSource = {
    parser,
    mode: HEADLESS_SOURCE_MODES.STDOUT,
    parseStdout: provider.parseHeadlessStdout.bind(provider),
  };
  let spawnIndex = 0;

  const coordinator = new CliTransportCoordinator({
    provider,
    processManager: {
      spawn: async (
        _command: string,
        _args: string[],
        options?: { onStdout?: (chunk: string) => void }
      ) => {
        for (const chunk of spawnChunks[spawnIndex++] ?? []) {
          options?.onStdout?.(chunk);
          countsAfterChunks.push(streamedIds.length);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
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
      onStreamingEvents: (events) => {
        streamedIds.push(
          ...events.map((event) => (event.data as { text: string }).text)
        );
      },
      onResponseComplete: () => {},
      onPtyExit: () => {},
      cleanupTempFiles: async () => {},
    },
  });

  for (let index = 0; index < spawnChunks.length; index++) {
    assert.strictEqual(
      await coordinator.executeHeadless(
        [],
        "prompt",
        [],
        async () => true,
        undefined,
        source
      ),
      true
    );
  }

  return { streamedIds, countsAfterChunks };
}

const stdoutProviderFactories: ReadonlyArray<{
  name: string;
  create: () => ICliProvider;
}> = [
  { name: "Copilot", create: () => new CopilotCliProvider() },
  { name: "Claude", create: () => new ClaudeCliProvider() },
  { name: "OpenCode", create: () => new OpenCodeCliProvider() },
];

suite("CliTransportCoordinator", () => {
  test("passes the configured prompt limit to headless spawn", async () => {
    const originalTimeoutReader =
      ConfigurationUtils.getMaxPromptExecutionTimeMs;
    const timeoutValues: Array<number | undefined> = [];
    const passedTimeouts: Array<number | undefined> = [];
    ConfigurationUtils.getMaxPromptExecutionTimeMs = () =>
      timeoutValues.shift();
    const coordinator = new CliTransportCoordinator({
      provider: createHeadlessProvider(),
      processManager: {
        spawn: async (
          _command: string,
          _args: string[],
          options: { timeout?: number }
        ) => {
          passedTimeouts.push(options.timeout);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        isActive: () => false,
      } as any,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: createHeadlessHostCallbacks(),
    });

    try {
      timeoutValues.push(undefined, 2500);
      await coordinator.executeHeadless([], "unlimited", [], async () => true);
      await coordinator.executeHeadless([], "finite", [], async () => true);
      assert.deepStrictEqual(passedTimeouts, [undefined, 2500]);
    } finally {
      ConfigurationUtils.getMaxPromptExecutionTimeMs = originalTimeoutReader;
    }
  });

  test("classifies headless prompt expiry as a timeout transport failure", async () => {
    const originalTimeoutReader =
      ConfigurationUtils.getMaxPromptExecutionTimeMs;
    ConfigurationUtils.getMaxPromptExecutionTimeMs = () => 25;
    const coordinator = new CliTransportCoordinator({
      provider: createHeadlessProvider(),
      processManager: {
        spawn: async () => {
          throw new CliProcessTimeoutError(25);
        },
        isActive: () => false,
      } as any,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: createHeadlessHostCallbacks(),
    });

    try {
      await assert.rejects(
        coordinator.executeHeadless([], "prompt", [], async () => true),
        (error: unknown) => {
          assert.ok(error instanceof CliTransportError);
          assert.strictEqual(error.failureKind, FAILURE_KINDS.TIMEOUT);
          assert.match(error.message, /timed out after 25ms/);
          return true;
        }
      );
    } finally {
      ConfigurationUtils.getMaxPromptExecutionTimeMs = originalTimeoutReader;
    }
  });

  test("streams split secrets redacted to terminal messages and replay buffer", async () => {
    let dataHandler: ((chunk: string) => void) | undefined;
    let exitHandler: ((event: { exitCode: number }) => void) | undefined;
    const fakePty = {
      process: "fake-cli",
      pid: 123,
      onData: (handler: (chunk: string) => void) => {
        dataHandler = handler;
        return { dispose: () => {} };
      },
      onExit: (handler: (event: { exitCode: number }) => void) => {
        exitHandler = handler;
        return { dispose: () => {} };
      },
      write: () => {},
      kill: () => {},
      resize: () => {},
    };
    class TestPtyProcessManager extends PtyProcessManager {
      protected override loadNodePty(): any {
        return { spawn: () => fakePty };
      }
    }
    const ptyManager = new TestPtyProcessManager();
    const secretRedactor = new RunSecretRedactor();
    secretRedactor.addResolvedValues({ TOKEN: "secret-value" });
    const releaseSecret = secretRedactionService.register(secretRedactor);
    const postedMessages: Array<{ type?: string; data?: string }> = [];
    const coordinator = new CliTransportCoordinator({
      provider: createHeadlessProvider(),
      processManager: {} as any,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: createHeadlessHostCallbacks(),
      postTerminalMessage: (message: unknown) => {
        postedMessages.push(message as { type?: string; data?: string });
      },
      getPtyManager: () => ptyManager,
    });

    try {
      await coordinator.startInteractiveProcess([], "prompt");
      const session = ptyManager.getAllSessions()[0];
      assert.ok(dataHandler);
      dataHandler("before secret");
      dataHandler("-value after");
      exitHandler?.({ exitCode: 0 });

      const outputMessages = postedMessages.filter(
        (message) => message.type === MESSAGE_TYPES.TERMINAL_OUTPUT
      );
      const output = outputMessages
        .map((message) => message.data ?? "")
        .join("");
      assert.strictEqual(output, `before ${REDACTION_MARKER} after`);
      assert.ok(!output.includes("secret-value"));
      assert.strictEqual(session?.reconnectBuffer.join(""), output);
    } finally {
      releaseSecret();
      ptyManager.dispose();
    }
  });

  test("classifies an ENOENT spawn as a missing harness", async () => {
    const spawnError = Object.assign(new Error("spawn test-cli ENOENT"), {
      code: "ENOENT",
    });
    const coordinator = new CliTransportCoordinator({
      provider: createHeadlessProvider(),
      processManager: {
        spawn: async () => {
          throw spawnError;
        },
        isActive: () => false,
      } as any,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: createHeadlessHostCallbacks(),
    });

    await assert.rejects(
      coordinator.executeHeadless([], "prompt", [], async () => true),
      (error: unknown) => {
        assert.ok(error instanceof CliTransportError);
        assert.strictEqual(
          error.failureKind,
          FAILURE_KINDS.HARNESS_NOT_INSTALLED
        );
        return true;
      }
    );
  });

  test("fails an interactive start when the host has no PTY manager", async () => {
    const postedMessages: unknown[] = [];
    const coordinator = new CliTransportCoordinator({
      provider: createHeadlessProvider(),
      processManager: {} as any,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: createHeadlessHostCallbacks(),
      postTerminalMessage: (message: unknown) => postedMessages.push(message),
      getPtyManager: () => null,
    });

    // Returning normally left the step waiting on a harness that never started.
    await assert.rejects(
      coordinator.startInteractiveProcess([], "prompt"),
      (error: unknown) => {
        assert.ok(error instanceof CliTransportError);
        assert.strictEqual(error.failureKind, FAILURE_KINDS.HARNESS_ERROR);
        assert.match(error.message, /Embedded terminal is unavailable/);
        return true;
      }
    );
    assert.deepStrictEqual(postedMessages, []);
  });

  test("should keep Codex headless hook arguments out of the shell", async () => {
    let preparedCommand:
      { promptArgument: string; cliCommand: string } | undefined;
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
          harnessId: HARNESS_IDS.CODEX_CLI,
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
          assert.ok(
            args.some((arg) => arg.includes("<session-flags>")),
            "the regression fixture must contain Codex's synthetic key"
          );
          assert.strictEqual(args[args.length - 1], "line one\nline two");
          assert.strictEqual(options?.shell, false);
          options?.onStdout?.("before secret-");
          options?.onStdout?.("value after");
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

    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: "secret-value" });
    const releaseSecret = secretRedactionService.register(redactor);
    try {
      const success = await coordinator.executeHeadless(
        [
          "-c",
          String.raw`hooks.state={"C:\<session-flags>\config.toml:stop:0:0" = {}}`,
        ],
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
        cliCommand: String.raw`test-cli -c hooks.state={"C:\<session-flags>\config.toml:stop:0:0" = {}} line one
line two`,
      });
      assert.strictEqual(
        streamedChunks.join(""),
        `before ${REDACTION_MARKER} after`
      );
      assert.ok(!streamedChunks.join("").includes("secret-value"));
      assert.deepStrictEqual(cleanedTempPaths, [["temp-a.md"]]);
    } finally {
      releaseSecret();
    }
  });

  test("should stream migrated stdout events through the log parser mapping", async () => {
    const streamedEvents: string[] = [];
    const classifiedPrompts: (string | undefined)[] = [];
    const parser = {
      extractStructuredEventsFromEvent: (event: { type: string }) => [
        { type: "text", data: { text: event.type } },
      ],
      trackBackgroundWorkState: () => {},
      extractLiveContextWindow: () => null,
      // Without the dispatched prompt, a harness that echoes it back (Copilot's
      // user.message) cannot tell it from a human steer.
      classifyUserEvent: (
        _event: unknown,
        ctx: { dispatchedPromptText?: string }
      ) => {
        classifiedPrompts.push(ctx.dispatchedPromptText);
        return "other";
      },
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
    assert.deepStrictEqual(classifiedPrompts, ["prompt"]);
  });

  for (const providerFactory of stdoutProviderFactories) {
    suite(`${providerFactory.name} stdout record boundaries`, () => {
      test("emits one event when a record spans two chunks", async () => {
        const record = JSON.stringify({ type: "event", id: "split" });
        const splitAt = Math.floor(record.length / 2);
        const result = await runStdoutSpawns(providerFactory.create(), [
          [record.slice(0, splitAt), `${record.slice(splitAt)}\n`],
        ]);

        assert.deepStrictEqual(result.streamedIds, ["split"]);
        assert.deepStrictEqual(result.countsAfterChunks, [0, 1]);
      });

      test("holds a partial tail while emitting complete records", async () => {
        const first = JSON.stringify({ type: "event", id: "first" });
        const second = JSON.stringify({ type: "event", id: "second" });
        const tail = JSON.stringify({ type: "event", id: "tail" });
        const result = await runStdoutSpawns(providerFactory.create(), [
          [`${first}\n${second}\n${tail.slice(0, 8)}`, `${tail.slice(8)}\n`],
        ]);

        assert.deepStrictEqual(result.streamedIds, ["first", "second", "tail"]);
        assert.deepStrictEqual(result.countsAfterChunks, [2, 3]);
      });

      test("flushes an unterminated final record exactly once", async () => {
        const finalRecord = JSON.stringify({ type: "event", id: "final" });
        const result = await runStdoutSpawns(providerFactory.create(), [
          [finalRecord],
        ]);

        assert.deepStrictEqual(result.streamedIds, ["final"]);
        assert.deepStrictEqual(result.countsAfterChunks, [0]);
      });

      test("does not carry the accumulator into a second spawn", async () => {
        const first = JSON.stringify({ type: "event", id: "first" });
        const second = JSON.stringify({ type: "event", id: "second" });
        const result = await runStdoutSpawns(providerFactory.create(), [
          [first],
          [`${second}\n`],
        ]);

        assert.deepStrictEqual(result.streamedIds, ["first", "second"]);
        assert.deepStrictEqual(result.countsAfterChunks, [0, 2]);
      });
    });
  }

  test("should parse partial headless output when cancellation is requested", async () => {
    let callbackResult:
      { stdout: string; stderr: string; exitCode: number } | undefined;
    const cleanedTempPaths: string[][] = [];
    let cancelling = false;

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
        spawn: async () => {
          // The Stop arrives while the process is running, which is the only
          // way a cancel reaches this branch — a cancel that lands *before* the
          // spawn is refused outright (see the pre-spawn gate test below).
          cancelling = true;
          return {
            stdout: '{"partial":true}\n',
            stderr: "",
            exitCode: 1,
          };
        },
        isActive: () => false,
      } as any,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => cancelling,
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
    const traceMessages: string[] = [];
    const originalShouldLogRawCliOutput =
      ConfigurationUtils.shouldLogRawCliOutput;
    const originalTrace = Log.trace;
    (
      ConfigurationUtils as unknown as { shouldLogRawCliOutput: () => boolean }
    ).shouldLogRawCliOutput = () => true;
    (Log as unknown as { trace(message: string): void }).trace = (
      message: string
    ) => {
      traceMessages.push(message);
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
        traceMessages.some((message) =>
          message.includes("[Test CLI RAW OUTPUT]: raw-chunk")
        )
      );
    } finally {
      (
        ConfigurationUtils as unknown as {
          shouldLogRawCliOutput: () => boolean;
        }
      ).shouldLogRawCliOutput = originalShouldLogRawCliOutput;
      (Log as unknown as { trace(message: string): void }).trace =
        originalTrace;
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
      stepIndex?: number;
      promptNumber?: number;
      kind?: string;
    }> = [];
    const spawnedSession: {
      id?: string;
      workflowId?: string;
      kind?: string;
      stepName?: string;
      stepIndex?: number;
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
            stepIndex: number;
            promptNumber?: number;
          }) => {
            Object.assign(spawnedSession, {
              id: config.sessionId,
              workflowId: config.workflowId,
              kind: config.kind,
              stepName: config.stepName,
              stepIndex: config.stepIndex,
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
      terminalStepIndex: -1,
      allPrompts: [{ prompt: "one" }, { name: "second", prompt: "two" }],
      instanceId: "workflow-1",
    } as any);

    assert.strictEqual(refreshed, true);
    assert.strictEqual(spawnedSession.stepName, "second");
    assert.strictEqual(spawnedSession.stepIndex, -1);
    assert.strictEqual(spawnedSession.promptNumber, 2);
    assert.strictEqual(postedMessages.length, 1);
    assert.strictEqual(postedMessages[0].type, MESSAGE_TYPES.TERMINAL_STARTED);
    assert.strictEqual(postedMessages[0].workflowId, "workflow-1");
    assert.strictEqual(postedMessages[0].sessionId, spawnedSession.id);
    assert.strictEqual(postedMessages[0].stepName, "second");
    assert.strictEqual(postedMessages[0].stepIndex, -1);
    assert.strictEqual(postedMessages[0].promptNumber, 2);
    assert.strictEqual(postedMessages[0].kind, SESSION_KINDS.AI_CLI);

    // A context that omits terminalStepIndex falls back to promptIndex, which
    // is what keeps ordinary queue steps numbered. That fallback is only safe
    // while every final-step context sets terminalStepIndex — a final-step
    // context that forgets it would stamp a positive index that
    // getActiveStepIndices() no longer reports, un-gating a live terminal.
    postedMessages.length = 0;
    coordinator.updateCurrentPtySessionMetadata({
      promptIndex: 1,
      allPrompts: [{ prompt: "one" }, { name: "second", prompt: "two" }],
      instanceId: "workflow-1",
    } as any);
    assert.strictEqual(spawnedSession.stepIndex, 1);
    assert.strictEqual(postedMessages[0].stepIndex, 1);
  });

  test("should terminate the active PTY session through the PTY manager", async () => {
    let killedSessionId: string | undefined;
    let killReason: TerminalEndReason | undefined;

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
          gracefulKillAiCliSession: async (
            sessionId: string,
            reason: TerminalEndReason
          ) => {
            killedSessionId = sessionId;
            killReason = reason;
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
    assert.strictEqual(killReason, TERMINAL_END_REASONS.SUPERSEDED);
    assert.strictEqual(
      await coordinator.terminateCurrentPtySession("second call"),
      undefined
    );
  });

  test("should honor closeTerminalOnComplete for active PTY sessions", async () => {
    const killedSessionIds: string[] = [];
    const killReasons: TerminalEndReason[] = [];
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
          gracefulKillAiCliSession: async (
            sessionId: string,
            reason: TerminalEndReason
          ) => {
            killedSessionIds.push(sessionId);
            killReasons.push(reason);
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

    coordinator.closeTerminal(TERMINAL_END_REASONS.CLOSED);

    assert.strictEqual(killedSessionIds.length, 1);

    await coordinator.startInteractiveProcess([], "prompt", {
      promptIndex: 0,
      allPrompts: [{ prompt: "one" }],
      instanceId: "workflow-1",
    } as any);

    coordinator.dispose(true);

    assert.strictEqual(disposedAll, true);
    assert.strictEqual(killedSessionIds.length, 2);
    // closeTerminalOnComplete is teardown after finished work, not a failure.
    assert.deepStrictEqual(killReasons, [
      TERMINAL_END_REASONS.CLOSED,
      TERMINAL_END_REASONS.STEP_COMPLETE,
    ]);
  });

  test("starts a standalone interactive process without waiting for it to exit", async () => {
    let disposedProcess = false;
    let preparedCommand: string | undefined;
    const secretName = "CTRLYOKE_TEST_COORDINATOR_SECRET";
    const previousSecret = process.env[secretName];
    delete process.env[secretName];
    let concurrentSpawnSecret: string | undefined;
    let exitProcess: (exit: InteractiveExitResult) => void = () => {};
    const processExit = new Promise<InteractiveExitResult>((resolve) => {
      exitProcess = resolve;
    });

    try {
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
            monitorForCompletion: async () => {
              throw new Error(
                "completion belongs to the caller's log monitor, not the transport"
              );
            },
            getNotificationDirectory: () => process.cwd(),
          },
          buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
            "--interactive",
            promptText,
            ...baseArgs,
          ],
        } as unknown as ICliProvider,
        processManager: {
          spawnInteractive: async (
            _command: string,
            args: string[],
            _cwd: string,
            env: Record<string, string>
          ) => {
            assert.deepStrictEqual(args, ["--interactive", "prompt"]);
            assert.strictEqual(env[secretName], "secret-value");
            assert.strictEqual(env.HOOK_TOKEN, "hook-value");
            assert.strictEqual(
              process.env[secretName],
              undefined,
              "a granted value must stay out of the host environment"
            );
            const sibling = new CliTransportCoordinator({
              provider: createHeadlessProvider(),
              processManager: {
                spawn: async (
                  _command: string,
                  _args: string[],
                  options?: { env?: Record<string, string> }
                ) => {
                  concurrentSpawnSecret = options?.env?.[secretName];
                  return { stdout: "", stderr: "", exitCode: 0 };
                },
                isActive: () => false,
              } as any,
              resolveCliCommand: resolveCommand,
              runtimeState: {
                getWorkspaceRoot: () => process.cwd(),
                isCancelling: () => false,
              },
              hostCallbacks: createHeadlessHostCallbacks(),
            });
            await sibling.executeHeadless([], "sibling", [], async () => true);
            return processExit;
          },
          disposeProcess: () => {
            disposedProcess = true;
            exitProcess({ exitCode: null, terminatedByManager: true });
          },
        } as unknown as CliProcessManager,
        resolveCliCommand: resolveCommand,
        resolveSecretEnvironment: async (names) => {
          assert.deepStrictEqual(names, [secretName]);
          return { [secretName]: "secret-value" };
        },
        runtimeState: {
          getWorkspaceRoot: () => process.cwd(),
          isCancelling: () => false,
        },
        hostCallbacks: {
          ...createHeadlessHostCallbacks(),
          onCommandPrepared: ({ cliCommand }) => {
            preparedCommand = cliCommand;
          },
        },
      });

      const started = await coordinator.startStandaloneInteractiveProcess(
        [],
        "prompt",
        { HOOK_TOKEN: "hook-value" },
        undefined,
        [secretName]
      );

      assert.strictEqual(started.command, "test-cli");
      assert.strictEqual(preparedCommand, "test-cli --interactive prompt");
      assert.strictEqual(disposedProcess, false);
      assert.deepStrictEqual(await started.terminate(), {
        exitCode: null,
        terminatedByManager: true,
      });
      assert.strictEqual(disposedProcess, true);
      assert.strictEqual(
        concurrentSpawnSecret,
        undefined,
        "a concurrent child must not inherit another action's secret"
      );
      assert.strictEqual(process.env[secretName], undefined);
    } finally {
      if (previousSecret !== undefined) {
        process.env[secretName] = previousSecret;
      }
    }
  });

  test("terminating an exited standalone process resolves with its own exit", async () => {
    const exit: InteractiveExitResult = {
      exitCode: 1,
      terminatedByManager: false,
    };
    const coordinator = new CliTransportCoordinator({
      provider: {
        config: { name: "test-cli" },
        buildInteractiveArgs: (_baseArgs: string[], promptText: string) => [
          promptText,
        ],
      } as unknown as ICliProvider,
      processManager: {
        spawnInteractive: async () => exit,
        // Disposing an already-exited process is a no-op in CliProcessManager.
        disposeProcess: () => {},
      } as unknown as CliProcessManager,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: createHeadlessHostCallbacks(),
    });

    const started = await coordinator.startStandaloneInteractiveProcess(
      [],
      "prompt"
    );

    assert.strictEqual(await started.exit, exit);
    assert.strictEqual(await started.terminate(), exit);
  });

  test("should refuse to spawn when cancellation lands while the log tail starts", async () => {
    // The gap between preparing a prompt and owning a process is where a Stop
    // does the most damage: `cancel()` sees no process, so it retires the
    // workflow instance at once. A spawn after that point belongs to nobody —
    // it keeps editing the workspace and delivers its completion to whichever
    // instance is live by then.
    let spawnCalls = 0;
    let callbackCalls = 0;
    let aborted = false;
    let cancelling = false;
    const source = {
      parser: {} as any,
      mode: "log" as const,
      logTail: {
        start: async () => {
          cancelling = true;
        },
        abort: () => {
          aborted = true;
        },
        finish: async () => ({ events: [] }),
        onStdoutChunk: () => {},
      } as any,
    };

    const coordinator = new CliTransportCoordinator({
      provider: createHeadlessProvider(),
      processManager: {
        spawn: async () => {
          spawnCalls += 1;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        isActive: () => false,
      } as any,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => cancelling,
      },
      hostCallbacks: createHeadlessHostCallbacks(),
    });

    const success = await coordinator.executeHeadless(
      [],
      "prompt",
      [],
      async () => {
        callbackCalls += 1;
        return true;
      },
      undefined,
      source
    );

    assert.strictEqual(success, false);
    assert.strictEqual(
      spawnCalls,
      0,
      "no process may be launched after a stop"
    );
    assert.strictEqual(callbackCalls, 0);
    assert.strictEqual(aborted, true, "the tail's discovery must be aborted");
  });

  test("should abort the in-flight headless log tail on cancel", async () => {
    // Session-log discovery retries for minutes and is the one part of a
    // headless run already working before a process exists, so `cancel()` is
    // the only thing that can stop it.
    let aborted = false;
    let releaseSpawn: () => void = () => {};
    const spawnBlocked = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const source = {
      parser: {} as any,
      mode: "log" as const,
      logTail: {
        start: async () => {},
        abort: () => {
          aborted = true;
        },
        finish: async () => ({ events: [] }),
        onStdoutChunk: () => {},
      } as any,
    };

    const coordinator = new CliTransportCoordinator({
      provider: createHeadlessProvider(),
      processManager: {
        spawn: async () => {
          await spawnBlocked;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        isActive: () => false,
      } as any,
      resolveCliCommand: resolveCommand,
      runtimeState: {
        getWorkspaceRoot: () => process.cwd(),
        isCancelling: () => false,
      },
      hostCallbacks: createHeadlessHostCallbacks(),
    });

    const execution = coordinator.executeHeadless(
      [],
      "prompt",
      [],
      async () => true,
      undefined,
      source
    );
    await new Promise((resolve) => setTimeout(resolve, 1));

    // `isActive()` is false here, which is exactly the case that used to leave
    // discovery running: the caller is told there was no process to kill.
    const hadActiveProcess = await coordinator.cancel();
    assert.strictEqual(hadActiveProcess, false);
    assert.strictEqual(aborted, true);

    releaseSpawn();
    await execution;
  });
});
