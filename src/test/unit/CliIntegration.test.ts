import * as assert from "assert";
import { suite, test } from "mocha";
import type * as vscode from "vscode";
import { CliIntegration } from "../../flightpath/harness/CliIntegration";
import { EXECUTION_MODES } from "../../types/DashboardConstants";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
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

class MockHeadlessVsCodePlatform extends MockVsCodePlatform {
  override getConfig<T>(key: string, defaultValue: T): T {
    if (key === "cliExecutionMode") {
      return EXECUTION_MODES.HEADLESS as T;
    }

    return defaultValue;
  }
}

function createHeadlessIntegration(): CliIntegration {
  const provider = {
    config: {
      name: "test",
      displayName: "Test CLI",
      terminalName: "Test",
      installHint: "",
      shouldStreamHeadlessOutput: false,
    },
    responseParser: {
      parse: () => ({
        events: [
          {
            type: "text",
            data: { text: "headless response" },
          },
        ],
        metadata: { sessionId: "session-from-output" },
      }),
      parseTokenCounts: () => undefined,
    },
    notificationMonitor: {
      supportsSessionIdInFilename: true,
      supportsSessionStart: false,
      monitorForCompletion: async () => ({ completed: false }),
      buildHookConfig: () => ({ type: "none" as const }),
      getNotificationDirectory: () => process.cwd(),
    },
    toolPermissionMapper: {
      hasFullPermissions: () => true,
    },
    buildCliArgs: async () => ["--base"],
    buildHeadlessArgs: (baseArgs: string[], prompt: string) => [
      ...baseArgs,
      "--prompt",
      prompt,
    ],
    buildInteractiveTuiCommand: () => "test-cli",
    checkAvailability: async () => true,
  } as unknown as ICliProvider;

  return new CliIntegration(provider, new MockHeadlessVsCodePlatform(), false);
}

suite("CliIntegration", () => {
  test("should keep last result snapshot in sync after headless execution", async () => {
    const integration = createHeadlessIntegration();

    (integration as any).executionRunner.executeHeadless = async (session: {
      promptArgument: string;
      recordCommandPrepared(info: {
        promptArgument: string;
        cliCommand: string;
      }): void;
      recordHeadlessResponse(response: {
        success: boolean;
        parsedOutput: UniversalCliOutput;
        cliResult: {
          success: boolean;
          response: string;
          statistics: string;
        };
        extractedSessionId?: string;
      }): void;
    }) => {
      session.recordCommandPrepared({
        promptArgument: session.promptArgument,
        cliCommand: `test --prompt ${session.promptArgument}`,
      });
      session.recordHeadlessResponse({
        success: true,
        parsedOutput: {
          events: [
            {
              type: "text",
              data: { text: "headless response" },
            },
          ],
          metadata: { sessionId: "session-from-output" },
        },
        cliResult: {
          success: true,
          response: "headless response",
          statistics: "",
        },
        extractedSessionId: "session-from-output",
      });

      return true;
    };

    const success = await integration.sendPrompt({ prompt: "say hi" });

    assert.strictEqual(success, true);
    assert.strictEqual(
      integration.getLastResult()?.response,
      "headless response"
    );
    assert.strictEqual(
      integration.getLastParsedOutput()?.metadata.sessionId,
      "session-from-output"
    );
    assert.strictEqual(integration.getLastCliCommand(), "test --prompt say hi");
  });
});
