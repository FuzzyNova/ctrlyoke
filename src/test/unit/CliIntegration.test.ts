import * as assert from "assert";
import { suite, test } from "mocha";
import type * as vscode from "vscode";
import { CliIntegration } from "../../flightpath/harness/CliIntegration";
import type { ICliProvider } from "../../flightpath/harness/shared/interfaces/ICliProvider";
import { PlatformAdapter } from "../../platform/PlatformAdapter";

class MockVsCodePlatform implements PlatformAdapter {
  getConfig<T>(_key: string, defaultValue: T): T {
    return defaultValue;
  }

  getWorkspaceRoot(): string {
    return process.cwd();
  }

  log(_message: string): void {}

  warn(_message: string): void {}

  error(_message: string): void {}

  showProgress(_message: string): void {}

  async showChoice(
    _message: string,
    ..._options: string[]
  ): Promise<string | undefined> {
    return undefined;
  }

  getExtensionPath(): string {
    return process.cwd();
  }

  getExtensionContext(): vscode.ExtensionContext {
    return { subscriptions: [] } as unknown as vscode.ExtensionContext;
  }
}

function createIntegration(options?: {
  supportsSessionStart?: boolean;
  waitForSessionStart?: (
    onCancel?: () => boolean
  ) => Promise<{ completed: boolean; error?: string; data?: any }>;
  discoverSessionLog?: () => Promise<string | null>;
}): CliIntegration {
  const provider = {
    config: {
      name: "test",
      displayName: "Test CLI",
      terminalName: "Test",
      installHint: "",
      shouldStreamHeadlessOutput: false,
    },
    responseParser: {},
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
    toolPermissionMapper: {},
    logParser: {
      extractResponse: () => ({ events: [], metadata: {} }),
      isComplete: () => false,
      watchLogFile: () => ({ close() {} }),
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
    buildInteractiveTuiCommand: () => "test-cli",
    checkAvailability: async () => true,
  } as unknown as ICliProvider;

  return new CliIntegration(provider, new MockVsCodePlatform(), false);
}

suite("CliIntegration", () => {
  test("should flag PTY exit while waiting for SessionStart", async () => {
    let cancelObserved = false;
    const integration = createIntegration({
      waitForSessionStart: async (onCancel) => {
        cancelObserved = onCancel?.() ?? false;
        return {
          completed: false,
          error: cancelObserved ? "cancelled" : "still waiting",
        };
      },
    });

    (integration as any).startCliProcess = async () => {
      (integration as any).failureTracker.capturePtyExit(0, []);
    };

    const result = await (integration as any).executeInTerminal(
      [],
      "just say hi",
      [],
      undefined,
      undefined
    );

    assert.deepStrictEqual(result, { success: false });
    assert.strictEqual(cancelObserved, true);
    assert.strictEqual(integration.wasLastFailureProcessExit(), true);
    assert.match(
      integration.getLastFailureReason(),
      /waiting for SessionStart hook/iu
    );
  });

  test("should stop early when PTY exits during session log discovery", async function () {
    this.timeout(5_000);

    const integration = createIntegration({
      supportsSessionStart: false,
      discoverSessionLog: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return null;
      },
    });

    (integration as any).startCliProcess = async () => {
      (integration as any).failureTracker.capturePtyExit(0, []);
    };

    const startedAt = Date.now();
    const result = await (integration as any).executeInTerminal(
      [],
      "just say hi",
      [],
      undefined,
      undefined
    );
    const elapsedMs = Date.now() - startedAt;

    assert.deepStrictEqual(result, { success: false });
    assert.ok(
      elapsedMs < 300,
      `expected discovery to abort quickly after PTY exit, but it took ${elapsedMs}ms`
    );
    assert.strictEqual(integration.wasLastFailureProcessExit(), true);
    assert.match(
      integration.getLastFailureReason(),
      /discovering the session log/iu
    );
  });
});
