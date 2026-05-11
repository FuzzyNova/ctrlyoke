import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import type * as vscode from "vscode";
import { CliIntegration } from "../../flightpath/harness/CliIntegration";
import { EXECUTION_MODES } from "../../types/DashboardConstants";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import type { ICliProvider } from "../../flightpath/harness/shared/interfaces/ICliProvider";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { PromptStep } from "../../types/FlightPathTypes";
import { configService } from "../../config/FlightPathConfigService";

class MockVsCodePlatform implements PlatformAdapter {
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

class TestCliIntegration extends CliIntegration {
  public formatRefs(
    agentRefs: string[],
    skillRefs: string[],
    directRefs: string[],
    contextRefs: string[],
    excerptRefs: string[],
    promptRefs: string[]
  ): string {
    return this.formatCategorizedReferences(
      agentRefs,
      skillRefs,
      directRefs,
      contextRefs,
      excerptRefs,
      promptRefs
    );
  }
}

function createProvider(overrides?: Partial<ICliProvider>): ICliProvider {
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
    buildInteractiveArgs: (baseArgs: string[], promptText: string) => [
      "--prompt",
      promptText,
      ...baseArgs,
    ],
    checkAvailability: async () => true,
  } as unknown as ICliProvider;

  return {
    ...provider,
    ...overrides,
    config: {
      ...provider.config,
      ...(overrides?.config ?? {}),
    },
    responseParser: {
      ...provider.responseParser,
      ...(overrides?.responseParser ?? {}),
    },
    notificationMonitor: {
      ...provider.notificationMonitor,
      ...(overrides?.notificationMonitor ?? {}),
    },
    toolPermissionMapper: {
      ...provider.toolPermissionMapper,
      ...(overrides?.toolPermissionMapper ?? {}),
    },
  } as unknown as ICliProvider;
}

function createHeadlessIntegration(
  overrides?: Partial<ICliProvider>
): CliIntegration {
  return new CliIntegration(
    createProvider(overrides),
    new MockVsCodePlatform(),
    false
  );
}

function createTestIntegration(
  overrides?: Partial<ICliProvider>
): TestCliIntegration {
  return new TestCliIntegration(
    createProvider(overrides),
    new MockVsCodePlatform(),
    false
  );
}

suite("CliIntegration", () => {
  setup(() => {
    configService.setCliOverlay({
      execution: { mode: EXECUTION_MODES.HEADLESS },
    });
  });

  teardown(() => {
    configService.setCliOverlay({});
  });
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

  test("should keep categorized CLI wrapper prompts on one line", () => {
    const integration = createTestIntegration();

    const formatted = integration.formatRefs(
      [],
      [],
      ["@src/ui/webview-react/components/output/CliOutput.tsx"],
      [],
      [],
      ["@.flightpath/temp/example.prompt.md"]
    );

    assert.strictEqual(
      formatted,
      "using these file references @src/ui/webview-react/components/output/CliOutput.tsx, follow the instructions in @.flightpath/temp/example.prompt.md "
    );
    assert.strictEqual(/[\r\n]/u.test(formatted), false);
  });

  test("should reuse resolved session IDs when the runner does not extract a new one", async () => {
    const integration = createHeadlessIntegration();
    const prompt: PromptStep = { prompt: "say hi" };

    (integration as any).sessionResolverAdapter.resolve = () => ({
      resolvedProperties: undefined,
      resolvedSessionId: "session-existing",
    });

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
      }): void;
    }) => {
      session.recordCommandPrepared({
        promptArgument: session.promptArgument,
        cliCommand: `test --prompt ${session.promptArgument}`,
      });
      session.recordHeadlessResponse({
        success: true,
        parsedOutput: {
          events: [],
          metadata: {},
        },
        cliResult: {
          success: true,
          response: "headless response",
          statistics: "",
        },
      });

      return true;
    };

    const success = await integration.sendPrompt(prompt);

    assert.strictEqual(success, true);
    assert.strictEqual(
      integration.getLastParsedOutput()?.metadata.sessionId,
      "session-existing"
    );
  });

  test("should retire a retained interactive PTY before headless resume of the same session", async () => {
    const integration = createHeadlessIntegration();
    const prompt: PromptStep = { prompt: "continue" };
    let retiredReason: string | undefined;
    let clearedInteractiveContext = false;
    let headlessCalled = false;

    (integration as any).sessionResolverAdapter.resolve = () => ({
      resolvedProperties: { resumeSession: true },
      resolvedSessionId: "session-existing",
    });

    (integration as any).executionRunner.getLastInteractiveContext = () => ({
      logPath: "session.log",
      sessionId: "session-existing",
      spawnedWithSessionId: "session-existing",
    });
    (integration as any).executionRunner.clearInteractiveContext = () => {
      clearedInteractiveContext = true;
    };
    (integration as any).transportCoordinator.terminateCurrentPtySession = (
      reason: string
    ) => {
      retiredReason = reason;
      return "pty-existing";
    };
    (integration as any).executionRunner.executeHeadless = async (session: {
      recordHeadlessResponse(response: {
        success: boolean;
        parsedOutput: UniversalCliOutput;
        cliResult: {
          success: boolean;
          response: string;
          statistics: string;
        };
      }): void;
    }) => {
      headlessCalled = true;
      session.recordHeadlessResponse({
        success: true,
        parsedOutput: {
          events: [],
          metadata: {},
        },
        cliResult: {
          success: true,
          response: "headless response",
          statistics: "",
        },
      });
      return true;
    };

    const success = await integration.sendPrompt(prompt);

    assert.strictEqual(success, true);
    assert.strictEqual(headlessCalled, true);
    assert.strictEqual(clearedInteractiveContext, true);
    assert.match(retiredReason ?? "", /headless resume of AI session/u);
  });

  test("should persist cancelled prompt runtime when a sendPrompt attempt is cancelled", async () => {
    const integration = createHeadlessIntegration();
    const prompt: PromptStep = { prompt: "say hi" };
    let updateWorkingFileCalls = 0;

    (integration as any).sessionResolverAdapter.resolve = () => ({
      resolvedProperties: undefined,
      resolvedSessionId: "session-existing",
    });

    (integration as any).executionRunner.executeHeadless = async () => {
      (integration as any).isCancelling = true;
      return false;
    };

    const success = await integration.sendPrompt(prompt, true, {
      promptIndex: 0,
      allPrompts: [prompt],
      workingFilePersistence: {
        updateWorkingFile: async () => {
          updateWorkingFileCalls += 1;
        },
      },
    } as any);

    assert.strictEqual(success, false);
    assert.strictEqual(updateWorkingFileCalls, 1);
    assert.ok(prompt._runtime?.startedAt);
    assert.strictEqual(prompt._runtime?.sessionId, "session-existing");
  });

  test("should use the dedicated finalStep response callback during prompt preparation", async () => {
    const integration = createHeadlessIntegration();
    const prompt: PromptStep = { prompt: "say hi" };
    let capturedFinalStepResponseTexts: string[] | undefined;

    (integration as any).promptPreparer.preparePrompt = async (
      promptStep: PromptStep,
      _workflowContext: unknown,
      _resolvedProperties: unknown,
      _resolvedSessionId: unknown,
      finalStepResponseTexts?: string[]
    ) => {
      capturedFinalStepResponseTexts = finalStepResponseTexts;
      return {
        promptWithInstruction: promptStep.prompt,
        tempFilePaths: [],
      };
    };

    (integration as any).executionRunner.executeHeadless = async (session: {
      recordHeadlessResponse(response: {
        success: boolean;
        parsedOutput: UniversalCliOutput;
        cliResult: {
          success: boolean;
          response: string;
          statistics: string;
        };
      }): void;
    }) => {
      session.recordHeadlessResponse({
        success: true,
        parsedOutput: {
          events: [],
          metadata: {},
        },
        cliResult: {
          success: true,
          response: "headless response",
          statistics: "",
        },
      });

      return true;
    };

    const success = await integration.sendPrompt(prompt, true, {
      promptIndex: 0,
      allPrompts: [prompt],
      getFinalStepResponseTexts: () => ["final loop response"],
    } as any);

    assert.strictEqual(success, true);
    assert.deepStrictEqual(capturedFinalStepResponseTexts, [
      "final loop response",
    ]);
  });

  test("should return false and expose the failure reason when execution throws", async () => {
    const integration = createHeadlessIntegration();

    (integration as any).executionRunner.executeHeadless = async (session: {
      promptArgument: string;
      recordCommandPrepared(info: {
        promptArgument: string;
        cliCommand: string;
      }): void;
    }) => {
      session.recordCommandPrepared({
        promptArgument: session.promptArgument,
        cliCommand: `test --prompt ${session.promptArgument}`,
      });
      throw new Error("runner exploded");
    };

    const success = await integration.sendPrompt({ prompt: "say hi" });

    assert.strictEqual(success, false);
    assert.strictEqual(integration.getLastFailureReason(), "runner exploded");
    assert.strictEqual(integration.getLastCliCommand(), "test --prompt say hi");
  });

  test("should clean up workflow artifacts and delegate workspace cleanup", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "flightpath-cli-integration-")
    );
    const mcpConfigPath = path.join(workspaceRoot, "mcp-config.json");
    const extraPath = path.join(workspaceRoot, "extra-artifact.json");
    let cleanupArgs:
      | { workspaceRoot: string; workingFilePath: string | undefined }
      | undefined;

    await fs.promises.writeFile(mcpConfigPath, "{}", "utf8");
    await fs.promises.writeFile(extraPath, "{}", "utf8");

    try {
      const integration = createHeadlessIntegration({
        getMcpConfigFilePath: () => mcpConfigPath,
        getAdditionalCleanupFilePaths: () => [extraPath],
        cleanupWorkspaceArtifacts: async (
          actualWorkspaceRoot: string,
          workingFilePath?: string
        ) => {
          cleanupArgs = {
            workspaceRoot: actualWorkspaceRoot,
            workingFilePath,
          };
        },
      });

      await integration.cleanupWorkflowArtifacts(
        "workflow.working.json",
        workspaceRoot
      );

      assert.strictEqual(fs.existsSync(mcpConfigPath), false);
      assert.strictEqual(fs.existsSync(extraPath), false);
      assert.deepStrictEqual(cleanupArgs, {
        workspaceRoot,
        workingFilePath: "workflow.working.json",
      });
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
