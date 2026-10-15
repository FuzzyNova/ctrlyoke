import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import {
  CTRLYOKE_ENV_VARS,
  FAILURE_KINDS,
  INTERACTIVE_TERMINAL_MODES,
  type InteractiveTerminalMode,
} from "../../types/DashboardConstants";
import { CliLogMonitor } from "../../core/harness/CliLogMonitor";
import { CliExecutionSession } from "../../core/harness/shared/CliExecutionSession";
import {
  CliExecutionRunner,
  type InteractiveInjectContext,
} from "../../core/harness/shared/CliExecutionRunner";
import { CliFailureTracker } from "../../core/harness/shared/CliFailureTracker";
import { CliTransportError } from "../../core/harness/shared/CliTransportError";
import { CliInteractiveStartupCoordinator } from "../../core/harness/shared/CliInteractiveStartupCoordinator";
import type { ICliProvider } from "../../core/harness/shared/interfaces/ICliProvider";
import type { InteractiveExitResult } from "../../utils/CliProcessManager";
import { getTranscriptText } from "../../utils/StepOutputText";

function createProvider(options?: {
  supportsSessionStart?: boolean;
  waitForSessionStart?: (
    onCancel?: () => boolean
  ) => Promise<{ completed: boolean; error?: string; data?: unknown }>;
  discoverSessionLog?: () => Promise<string | null>;
  recoverableSessionError?: boolean;
}): ICliProvider {
  return {
    config: {
      name: "test",
      displayName: "Test CLI",
      terminalName: "Test",
      installHint: "",
      shouldStreamHeadlessOutput: false,
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
    ...(options?.recoverableSessionError
      ? {
          isRecoverableSessionError: (
            input: string | Error | { stderr?: string }
          ) => {
            const message =
              typeof input === "string"
                ? input
                : input instanceof Error
                  ? input.message
                  : (input.stderr ?? "");
            return message.includes("No conversation found with session ID");
          },
        }
      : {}),
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
  interactiveTerminal?: InteractiveTerminalMode;
  /** How the standalone TUI ends on its own; unset, it runs until terminated. */
  standaloneExit?: InteractiveExitResult;
  collectedHeadlessResponse?: {
    success: boolean;
    error?: string;
    sessionId?: string;
  };
  headlessError?: Error;
  cleanupTempFiles?: (paths: string[]) => Promise<void>;
  recoverableSessionError?: boolean;
  headlessResponses?: Array<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  onHeadlessAttempt?: (args: string[], keepTempFiles: boolean) => Promise<void>;
  onRetryPlan?: (resolvedSessionId?: string) => Promise<{
    args: string[];
    resolvedCommand?: unknown;
    tempFilePaths?: string[];
  }>;
}) {
  const failureTracker = new CliFailureTracker();
  let failureReason: string | undefined;
  let observedHeadlessEnv: Record<string, string> | undefined;
  let observedStandaloneEnv: Record<string, string> | undefined;
  let standaloneTerminations = 0;
  let embeddedPtyStarts = 0;
  let inheritedStdioStarts = 0;
  let headlessAttempt = 0;
  const provider = createProvider(options);

  const runner = new CliExecutionRunner({
    provider,
    executionPlanBuilder: {
      plan: async (session) => {
        const planned = await options?.onRetryPlan?.(session.resolvedSessionId);
        return {
          cliArgs: planned?.args ?? [],
          resolvedCommand:
            planned?.resolvedCommand ?? { args: planned?.args ?? [] },
          tempFilePaths: planned?.tempFilePaths ?? [],
          deferredHookEnvironmentFilePaths: [],
        } as never;
      },
      apply: async () => {},
    },
    transportCoordinator: {
      startStandaloneInteractiveProcess: async (_args, _prompt, env) => {
        inheritedStdioStarts++;
        observedStandaloneEnv = env;
        let settle: (exit: InteractiveExitResult) => void = () => {};
        const exit = new Promise<InteractiveExitResult>((resolve) => {
          settle = resolve;
        });
        const ownExit = options?.standaloneExit;
        if (ownExit) {
          setTimeout(() => settle(ownExit), 0);
        }
        return {
          command: "test",
          exit,
          terminate: () => {
            standaloneTerminations++;
            settle({ exitCode: null, terminatedByManager: true });
            return exit;
          },
        };
      },
      startInteractiveProcess: async () => {
        embeddedPtyStarts++;
        failureTracker.capturePtyExit(0, []);
      },
      executeHeadless: async (
        args,
        _prompt,
        tempFiles,
        callback,
        env,
        _source,
        _resolvedCommand,
        _secretNames,
        keepTempFiles
      ) => {
        observedHeadlessEnv = env;
        const attempt = headlessAttempt++;
        try {
          await options?.onHeadlessAttempt?.(args, keepTempFiles ?? false);
          if (options?.headlessError) {
            throw options.headlessError;
          }
          return await callback(
            options?.headlessResponses?.[attempt] ?? {
              stdout: "",
              stderr: options?.collectedHeadlessResponse?.error ?? "",
              exitCode:
                options?.collectedHeadlessResponse?.success === false ? 1 : 0,
            }
          );
        } finally {
          if (!keepTempFiles) {
            await options?.cleanupTempFiles?.(tempFiles);
          }
        }
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
      cleanupTempFiles: options?.cleanupTempFiles ?? (async () => {}),
    },
    runtimeState: {
      getWorkspaceRoot: () => process.cwd(),
      getExtensionPath: () => process.cwd(),
      interactiveTerminal:
        options?.interactiveTerminal ?? INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY,
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
    getHeadlessEnv: () => observedHeadlessEnv,
    getStandaloneEnv: () => observedStandaloneEnv,
    getStandaloneTerminations: () => standaloneTerminations,
    getEmbeddedPtyStarts: () => embeddedPtyStarts,
    getInheritedStdioStarts: () => inheritedStdioStarts,
  };
}

suite("CliExecutionRunner", () => {
  test("keeps deferred hook env files available after a turn", async () => {
    const tempPath = require("path").join(
      require("os").tmpdir(),
      `ctrlyoke-hook-env-cleanup-${Date.now()}.json`
    ) as string;
    const fs = require("fs/promises") as typeof import("fs/promises");
    await fs.writeFile(tempPath, "{}");
    const counters = createRunner({
      cleanupTempFiles: async (paths) => {
        await Promise.all(
          paths.map((filePath) => fs.rm(filePath, { force: true }))
        );
      },
    });
    const session = new CliExecutionSession({ prompt: { prompt: "cleanup" } });
    session.addDeferredHookEnvironmentFilePath(tempPath);

    await counters.runner.executeHeadless(session, []);
    await fs.access(tempPath);
    await fs.rm(tempPath, { force: true });
  });

  test("retries a rejected session without resume and cleans prompt files afterward", async () => {
    const tempPath = path.join(
      os.tmpdir(),
      `ctrlyoke-session-retry-${Date.now()}.txt`
    );
    await fs.writeFile(tempPath, "prompt attachment");
    let cleanupCalls = 0;
    let attempt = 0;
    const attempts: string[][] = [];
    const counters = createRunner({
      recoverableSessionError: true,
      headlessResponses: [
        {
          stdout: "",
          stderr: "No conversation found with session ID x",
          exitCode: 1,
        },
        { stdout: "retry succeeded", stderr: "", exitCode: 0 },
      ],
      collectedHeadlessResponse: { success: true, sessionId: "fresh-session" },
      onHeadlessAttempt: async (args, keepTempFiles) => {
        attempts.push(args);
        attempt++;
        assert.strictEqual(keepTempFiles, true);
        if (attempt === 2) {
          assert.strictEqual(args.includes("-r"), false);
          await fs.access(tempPath);
        }
      },
      onRetryPlan: async (resolvedSessionId) => {
        assert.strictEqual(resolvedSessionId, undefined);
        return {
          args: [
            "--permission-mode",
            "default",
            "--allowedTools",
            "Read",
            "--disallowedTools",
            "Write",
            "--settings",
            "hooks.json",
            "prompt",
          ],
        };
      },
      cleanupTempFiles: async (paths) => {
        cleanupCalls++;
        await Promise.all(
          paths.map((filePath) => fs.rm(filePath, { force: true }))
        );
      },
    });
    const session = new CliExecutionSession({
      prompt: { prompt: "retry this" },
      resolvedSessionId: "x",
    });
    session.preparePrompt("@prompt.txt", [tempPath]);

    try {
      assert.strictEqual(
        await counters.runner.executeHeadless(session, [
          "--permission-mode",
          "default",
          "--allowedTools",
          "Read",
          "--disallowedTools",
          "Write",
          "--settings",
          "hooks.json",
          "-r",
          "x",
          "prompt",
        ]),
        true
      );
      assert.strictEqual(attempt, 2);
      assert.deepStrictEqual(attempts[1], [
        "--permission-mode",
        "default",
        "--allowedTools",
        "Read",
        "--disallowedTools",
        "Write",
        "--settings",
        "hooks.json",
        "prompt",
      ]);
      assert.deepStrictEqual(attempts[1], [
        ...attempts[0].slice(0, attempts[0].indexOf("-r")),
        ...attempts[0].slice(attempts[0].indexOf("x") + 1),
      ]);
      assert.strictEqual(session.effectiveSessionId, "fresh-session");
      assert.strictEqual(cleanupCalls, 1);
      await assert.rejects(fs.access(tempPath));
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  });

  test("does not retry a session error when no session was resumed", async () => {
    let attempts = 0;
    const counters = createRunner({
      recoverableSessionError: true,
      headlessResponses: [
        {
          stdout: "",
          stderr: "No conversation found with session ID x",
          exitCode: 1,
        },
      ],
      collectedHeadlessResponse: {
        success: false,
        error: "No conversation found with session ID x",
      },
      onHeadlessAttempt: async () => {
        attempts++;
      },
      onRetryPlan: async () => {
        throw new Error("retry plan should not be built");
      },
    });

    assert.strictEqual(
      await counters.runner.executeHeadless(
        new CliExecutionSession({ prompt: { prompt: "fresh launch" } }),
        []
      ),
      false
    );
    assert.strictEqual(attempts, 1);
  });

  test(
    "clears a rejected session ID before a retry that cannot discover a new ID",
    async () => {
      const persistedIds: string[] = [];
      const counters = createRunner({
        recoverableSessionError: true,
        headlessResponses: [
          {
            stdout: "",
            stderr: "No conversation found with session ID dead-session",
            exitCode: 1,
          },
          { stdout: "", stderr: "retry failed", exitCode: 1 },
        ],
        collectedHeadlessResponse: { success: false, error: "retry failed" },
        onRetryPlan: async (resolvedSessionId) => {
          assert.strictEqual(resolvedSessionId, undefined);
          return { args: ["fresh launch"] };
        },
      });
      const session = new CliExecutionSession({
        prompt: { prompt: "retry" },
        resolvedSessionId: "dead-session",
        workflowContext: {
          promptIndex: 0,
          allPrompts: [{ prompt: "retry" }],
          workingFilePersistence: {
            updateWorkingFile: async () => {},
            persistSessionId: async (_promptIndex, sessionId) => {
              persistedIds.push(sessionId);
            },
          },
        },
      });

      assert.strictEqual(
        await counters.runner.executeHeadless(session, ["-r"]),
        false
      );
      assert.strictEqual(session.resolvedSessionId, undefined);
      assert.strictEqual(session.effectiveSessionId, undefined);
      assert.deepStrictEqual(persistedIds, [""]);
    }
  );

  test("cleans prompt files once when a recoverable-session provider does not retry", async () => {
    const tempPath = path.join(
      os.tmpdir(),
      `ctrlyoke-session-no-retry-${Date.now()}.txt`
    );
    await fs.writeFile(tempPath, "prompt attachment");
    let cleanupCalls = 0;
    const counters = createRunner({
      recoverableSessionError: true,
      onHeadlessAttempt: async (_args, keepTempFiles) => {
        assert.strictEqual(keepTempFiles, true);
      },
      cleanupTempFiles: async (paths) => {
        cleanupCalls++;
        await Promise.all(
          paths.map((filePath) => fs.rm(filePath, { force: true }))
        );
      },
    });
    const session = new CliExecutionSession({ prompt: { prompt: "no retry" } });
    session.preparePrompt("@prompt.txt", [tempPath]);

    try {
      assert.strictEqual(
        await counters.runner.executeHeadless(session, []),
        true
      );
      assert.strictEqual(cleanupCalls, 1);
      await assert.rejects(fs.access(tempPath));
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  });

  test("keeps hook env files until the user Stop hook can run", async () => {
    const fs = require("fs/promises") as typeof import("fs/promises");
    const tempPath = require("path").join(
      require("os").tmpdir(),
      `ctrlyoke-hook-env-stop-${Date.now()}.json`
    ) as string;
    await fs.writeFile(tempPath, "{}");
    const counters = createRunner({
      writeToCurrentPtySession: () => true,
    });
    (counters.runner as any).lastInteractiveContext = {
      logPath: "test.log",
      sessionId: "test-session",
    };
    (counters.runner as any).monitorLogFile = async () => ({ success: true });
    const session = new CliExecutionSession({ prompt: { prompt: "stop" } });
    session.addDeferredHookEnvironmentFilePath(tempPath);

    try {
      assert.deepStrictEqual(
        await counters.runner.executeInteractiveInject(session),
        { injected: true, success: true }
      );
      await fs.access(tempPath);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  });

  test("does not add user hook environment values to the harness process", async () => {
    const counters = createRunner();
    const session = new CliExecutionSession({
      prompt: { prompt: "env isolation" },
      resolvedProperties: {
        harness: "claude-cli",
        model: "model-x",
        executionMode: "headless",
        resumeSession: false,
        mcpServers: null,
        hooks: [
          {
            event: "stop",
            command: "node hook.js",
            env: { PRIVATE_HOOK_VALUE: "secret" },
          },
        ],
        toolPermissions: null,
      },
    });

    await counters.runner.executeHeadless(session, []);
    assert.strictEqual(
      counters.getHeadlessEnv()?.PRIVATE_HOOK_VALUE,
      undefined
    );
  });

  test("selects the interactive path from the host capability", async () => {
    for (const [interactiveTerminal, expectedPath] of [
      [INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY, "pty"],
      [INTERACTIVE_TERMINAL_MODES.INHERIT_STDIO, "stdio"],
    ] as const) {
      // This capability object has no VS Code identity or ExtensionContext.
      const host = { interactiveTerminal };
      const counters = createRunner({
        interactiveTerminal: host.interactiveTerminal,
        supportsSessionStart: false,
        ...(expectedPath === "stdio"
          ? { standaloneExit: { exitCode: 1, terminatedByManager: false } }
          : {}),
        waitForSessionStart: async () => ({
          completed: false,
          error: "not started",
        }),
      });
      await counters.runner.executeInteractive(
        new CliExecutionSession({ prompt: { prompt: "capability test" } }),
        []
      );
      assert.strictEqual(
        counters.getEmbeddedPtyStarts() > 0,
        expectedPath === "pty"
      );
      assert.strictEqual(
        counters.getInheritedStdioStarts() > 0,
        expectedPath === "stdio"
      );
    }
  });

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

  test("should stop early when PTY exits during session log discovery", async () => {
    // Discovery sleeps far longer than the assertion below allows, so "aborted
    // on PTY exit" stays distinguishable from "discovery simply finished" even
    // when the host is loaded enough to blow past a few hundred milliseconds.
    const { runner, failureTracker, getFailureReason } = createRunner({
      supportsSessionStart: false,
      discoverSessionLog: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
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
      elapsedMs < 10_000,
      `expected discovery to abort quickly after PTY exit, but it took ${elapsedMs}ms`
    );
    assert.strictEqual(failureTracker.wasLastFailureProcessExit(), true);
    const failureReason = getFailureReason();
    assert.ok(failureReason);
    assert.match(failureReason, /discovering the session log/iu);
  });

  test("should send inject prompt in chunks with repeated focus and submit pulses", async function () {
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

  test("should return false when a live PTY write fails", async function () {
    const writes: string[] = [];
    const { runner } = createRunner({
      writeToCurrentPtySession: (text) => {
        writes.push(text);
        return false;
      },
    });

    const success = await runner.writeTurnToLivePty("prompt");

    assert.strictEqual(success, false);
    assert.deepStrictEqual(writes, ["\x1b[I"]);
  });

  test("should return false when the PTY terminates after writing", async function () {
    const writes: string[] = [];
    const { runner, failureTracker } = createRunner({
      writeToCurrentPtySession: (text) => {
        writes.push(text);
        if (text === "\r") {
          failureTracker.capturePtyExit(0, []);
        }
        return true;
      },
    });

    const success = await runner.writeTurnToLivePty("prompt");

    assert.strictEqual(success, false);
    assert.deepStrictEqual(writes, ["\x1b[I", "\x1b[I", "prompt", "\r", "\r"]);
  });

  test("should serialize concurrent turn writers without interleaving chunks", async function () {
    const writes: string[] = [];
    const { runner } = createRunner({
      writeToCurrentPtySession: (text) => {
        writes.push(text);
        return true;
      },
    });
    const firstPrompt = "a".repeat(257);
    const secondPrompt = "b".repeat(257);

    const results = await Promise.all([
      runner.writeTurnToLivePty(firstPrompt),
      runner.writeTurnToLivePty(secondPrompt),
    ]);

    assert.deepStrictEqual(results, [true, true]);
    assert.deepStrictEqual(writes, [
      "\x1b[I",
      "\x1b[I",
      "a".repeat(256),
      "a",
      "\r",
      "\r",
      "\x1b[I",
      "\x1b[I",
      "b".repeat(256),
      "b",
      "\r",
      "\r",
    ]);
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

  test("records a headless prompt timeout as a step-level TIMEOUT failure", async () => {
    const { runner, failureTracker, getFailureReason } = createRunner({
      headlessError: new CliTransportError(
        "Prompt execution timed out after 25ms",
        FAILURE_KINDS.TIMEOUT
      ),
    });
    const session = new CliExecutionSession({
      prompt: { prompt: "just say hi" },
    });

    assert.strictEqual(await runner.executeHeadless(session, []), false);
    assert.strictEqual(session.failureKind, FAILURE_KINDS.TIMEOUT);
    assert.strictEqual(failureTracker.wasLastFailureTimeout(), true);
    assert.strictEqual(
      getFailureReason(),
      "Prompt execution timed out after 25ms"
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

  test("exports the parallel group identity on a spawned step", async () => {
    const { runner, getHeadlessEnv } = createRunner();
    const session = new CliExecutionSession({
      prompt: { prompt: "group member" },
      workflowContext: {
        promptIndex: 1,
        allPrompts: [{ prompt: "first" }, { prompt: "group member" }],
        workflowFile: {
          steps: [{ prompt: "first" }, { prompt: "group member" }],
          parallelGroups: [
            { id: "group-1", startIndex: 1, endIndex: 1, failFast: true },
          ],
        },
      },
    });

    assert.strictEqual(await runner.executeHeadless(session, []), true);
    assert.strictEqual(getHeadlessEnv()?.CTRLYOKE_PROMPT_INDEX, "1");
    assert.strictEqual(getHeadlessEnv()?.CTRLYOKE_PARALLEL_GROUP_ID, "group-1");
  });

  test("exports the active working file to the harness process", async () => {
    const { runner, getHeadlessEnv } = createRunner();
    const session = new CliExecutionSession({
      prompt: { prompt: "working file env" },
      workflowContext: {
        promptIndex: 0,
        allPrompts: [{ prompt: "working file env" }],
        workingFilePath: "C:\\workspace\\run\\workflow.ctrlyoke.json",
      },
    });

    assert.strictEqual(await runner.executeHeadless(session, []), true);
    assert.strictEqual(
      getHeadlessEnv()?.[CTRLYOKE_ENV_VARS.WORKING_FILE],
      "C:/workspace/run/workflow.ctrlyoke.json"
    );
  });

  suite("standalone interactive", () => {
    const originalMonitor = CliLogMonitor.prototype.monitor;

    teardown(() => {
      CliLogMonitor.prototype.monitor = originalMonitor;
    });

    // `ctrlyoke run --interactive` used to wait on the stop hook alone and
    // record the placeholder "Interactive session ended" as the response, with
    // no events or usage. It now runs the same discovery and log monitor as
    // the VS Code PTY path.
    test("records the session log's response, events and usage", async () => {
      const { runner, getStandaloneEnv, getStandaloneTerminations } =
        createRunner({
          interactiveTerminal: INTERACTIVE_TERMINAL_MODES.INHERIT_STDIO,
          supportsSessionStart: false,
          discoverSessionLog: async () => "session.jsonl",
        });
      const parsedOutput = {
        events: [{ type: "text", data: { text: "the real answer" } }],
        metadata: {
          sessionId: "session-1",
          usage: { inputTokens: 12, outputTokens: 3 },
        },
      };
      let monitored:
        { logPath: string; dispatchedPromptText?: string } | undefined;
      let terminationsWhileMonitoring: number | undefined;
      CliLogMonitor.prototype.monitor = async function (
        logPath,
        _sessionId,
        _startTime,
        _model,
        dispatchedPromptText
      ) {
        monitored = { logPath, dispatchedPromptText };
        terminationsWhileMonitoring = getStandaloneTerminations();
        return {
          success: true,
          sessionId: "session-1",
          parsedOutput: parsedOutput as never,
          cliResult: {
            success: true,
            response: "the real answer",
            statistics: "",
            exitCode: 0,
            sessionId: "session-1",
          },
        };
      };
      const session = new CliExecutionSession({
        prompt: { prompt: "just say hi" },
      });

      assert.strictEqual(await runner.executeInteractive(session, []), true);

      assert.deepStrictEqual(monitored, {
        logPath: "session.jsonl",
        dispatchedPromptText: session.promptArgument,
      });
      assert.strictEqual(
        getTranscriptText(session.parsedOutput?.events ?? []),
        "the real answer"
      );
      assert.deepStrictEqual(session.parsedOutput, parsedOutput);
      assert.strictEqual(session.effectiveSessionId, "session-1");
      // The OpenCode completion plugin reads its notification directory from
      // the environment; without it the step never sees its stop signal.
      assert.strictEqual(
        getStandaloneEnv()?.CTRLYOKE_NOTIFY_DIR,
        process.cwd()
      );
      assert.ok(getStandaloneEnv()?.CTRLYOKE_RUN_ID);
      // The TUI is ended only once the monitor has drained the session log.
      assert.strictEqual(terminationsWhileMonitoring, 0);
      assert.strictEqual(getStandaloneTerminations(), 1);
      // Nothing is left running to inject a later step into.
      assert.strictEqual(runner.hasInteractiveContext(), false);
    });

    // Codex 0.156 exits 1 ("stdin is not a terminal") without ever running.
    test("fails when the TUI exits before the session starts", async () => {
      const { runner, failureTracker, getFailureReason } = createRunner({
        interactiveTerminal: INTERACTIVE_TERMINAL_MODES.INHERIT_STDIO,
        supportsSessionStart: false,
        discoverSessionLog: () => new Promise(() => {}),
        standaloneExit: { exitCode: 1, terminatedByManager: false },
      });

      assert.strictEqual(
        await runner.executeInteractive(
          new CliExecutionSession({ prompt: { prompt: "just say hi" } }),
          []
        ),
        false
      );
      assert.strictEqual(failureTracker.wasLastFailureProcessExit(), true);
      assert.match(
        getFailureReason() ?? "",
        /exited unexpectedly.*exit code 1/
      );
    });

    test("names a harness that could not be launched", async () => {
      const { runner, failureTracker, getFailureReason } = createRunner({
        interactiveTerminal: INTERACTIVE_TERMINAL_MODES.INHERIT_STDIO,
        supportsSessionStart: false,
        discoverSessionLog: () => new Promise(() => {}),
        standaloneExit: {
          exitCode: null,
          error: "spawn ENOENT",
          terminatedByManager: false,
        },
      });
      const session = new CliExecutionSession({
        prompt: { prompt: "just say hi" },
      });

      assert.strictEqual(await runner.executeInteractive(session, []), false);
      assert.strictEqual(
        failureTracker.getLastFailureKind(),
        FAILURE_KINDS.HARNESS_NOT_INSTALLED
      );
      assert.strictEqual(
        session.failureKind,
        FAILURE_KINDS.HARNESS_NOT_INSTALLED
      );
      assert.strictEqual(
        getFailureReason(),
        "test could not be started: spawn ENOENT"
      );
    });

    test("ends the TUI when the log monitor reports a harness error", async () => {
      const { runner, failureTracker, getStandaloneTerminations } =
        createRunner({
          interactiveTerminal: INTERACTIVE_TERMINAL_MODES.INHERIT_STDIO,
          supportsSessionStart: false,
          discoverSessionLog: async () => "session.jsonl",
        });
      CliLogMonitor.prototype.monitor = async () => ({
        success: false,
        failureKind: FAILURE_KINDS.HARNESS_ERROR,
        failureMessage: "could not submit the prompt",
      });

      assert.strictEqual(
        await runner.executeInteractive(
          new CliExecutionSession({ prompt: { prompt: "just say hi" } }),
          []
        ),
        false
      );
      assert.strictEqual(failureTracker.wasLastFailureHarnessError(), true);
      assert.strictEqual(getStandaloneTerminations(), 1);
    });
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
