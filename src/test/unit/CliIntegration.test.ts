import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import type * as vscode from "vscode";
import { CliIntegration } from "../../core/harness/CliIntegration";
import {
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import { HARNESS_IDS, PERMISSION_MODES } from "../../types/DashboardConstants";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import type { ICliProvider } from "../../core/harness/shared/interfaces/ICliProvider";
import type {
  BaseCliEvent,
  ILogParser,
} from "../../core/harness/shared/interfaces/ILogParser";
import { CliAdapter } from "../../platform/CliAdapter";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { VsCodeAdapter } from "../../platform/VsCodeAdapter";
import type { McpServerConfig, PromptStep } from "../../types/CtrlYokeTypes";
import { configService } from "../../config/CtrlYokeConfigService";
import type { InteractiveInjectContext } from "../../core/harness/shared/CliExecutionRunner";
import type { ResolvedProperties } from "../../utils/PropertyResolver";
import type { CompatibilityDiagnostic } from "../../types/CompatibilityTypes";
import type { ExecutionWorkspace } from "../../types/WorkflowContextTypes";
import type { ManagedMcpServer } from "../../types/WebviewMessageTypes";
import { McpServerNormalizer } from "../../utils/McpServerNormalizer";

class MockVsCodePlatform
  implements PlatformAdapter, Pick<VsCodeAdapter, "getExtensionContext">
{
  getWorkspaceRoot(): string {
    return process.cwd();
  }

  getWorkspaceRoots(): string[] {
    return [process.cwd()];
  }

  getNamedWorkspaceRoots() {
    return [{ name: "root", fsPath: process.cwd() }];
  }

  getExtensionPath(): string {
    return process.cwd();
  }

  getExtensionContext(): vscode.ExtensionContext {
    return { subscriptions: [] } as unknown as vscode.ExtensionContext;
  }
}

class TestCliIntegration extends CliIntegration {
  public extractSlashCommand(text: string): string | null {
    return this.extractLeadingSlashCommand(text);
  }

  public configuredExecutionMode(): string {
    return this.getExecutionMode();
  }

  public formatRefs(
    agentRefs: string[],
    skillRefs: string[],
    directRefs: string[],
    contextRefs: string[],
    excerptRefs: string[],
    promptRefs: string[],
    secretRefs: string[] = []
  ): string {
    return this.formatCategorizedReferences(
      agentRefs,
      skillRefs,
      directRefs,
      contextRefs,
      excerptRefs,
      promptRefs,
      secretRefs
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
    parseHeadlessStdout: () => [],
    logParser: {
      extractResponse: () => ({
        events: [
          {
            type: "text",
            data: { text: "headless response" },
          },
        ],
        metadata: { sessionId: "session-from-output" },
      }),
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

function createResolvedProperties(
  overrides: Partial<ResolvedProperties> = {}
): ResolvedProperties {
  return {
    harness: HARNESS_IDS.CLAUDE_CLI,
    model: "test-model",
    executionMode: EXECUTION_MODES.INTERACTIVE,
    resumeSession: true,
    mcpServers: null,
    hooks: null,
    toolPermissions: null,
    ...overrides,
  };
}

function createInteractiveInjectContext(
  spawnedWith?: ResolvedProperties
): InteractiveInjectContext {
  return {
    logPath: "session.log",
    sessionId: "session-existing",
    spawnedWith,
    spawnedWithSessionId: "session-existing",
  };
}

function getInjectIncompatibilityReason(
  ctx: InteractiveInjectContext,
  curr: ResolvedProperties | undefined,
  currSessionId: string | undefined
): string | null {
  return (CliIntegration as any).getInjectIncompatibilityReason(
    ctx,
    curr,
    currSessionId
  );
}

suite("CliIntegration", () => {
  setup(() => {
    configService.setCliOverlay({
      defaults: { executionMode: EXECUTION_MODES.HEADLESS },
    });
  });

  teardown(() => {
    configService.setCliOverlay({});
  });

  suite("inject compatibility", () => {
    test("forces a restart when the spawnedWith snapshot is missing", () => {
      const reason = getInjectIncompatibilityReason(
        createInteractiveInjectContext(),
        createResolvedProperties(),
        "session-existing"
      );

      assert.match(reason ?? "", /spawnedWith snapshot is missing/u);
    });

    test("forces a restart when current resolved properties are missing", () => {
      const reason = getInjectIncompatibilityReason(
        createInteractiveInjectContext(createResolvedProperties()),
        undefined,
        "session-existing"
      );

      assert.match(reason ?? "", /current resolved properties are missing/u);
    });

    test("permits inject when the spawn-time snapshot fully matches", () => {
      const properties = createResolvedProperties();

      assert.strictEqual(
        getInjectIncompatibilityReason(
          createInteractiveInjectContext(properties),
          properties,
          "session-existing"
        ),
        null
      );
    });

    test("retires the PTY when a queued MCP reference changes the normalized server set", async () => {
      const playwright: McpServerConfig = {
        id: "playwright",
        command: "node",
        args: ["playwright-server.js"],
      };
      const managedServers: ManagedMcpServer[] = [
        {
          id: playwright.id,
          displayName: "Playwright",
          config: playwright,
          locations: [],
        },
      ];
      const initial = await McpServerNormalizer.apply(
        createResolvedProperties({ mcpServers: [] }),
        managedServers,
        "plain prompt"
      );
      const queued = await McpServerNormalizer.apply(
        createResolvedProperties({ mcpServers: [] }),
        managedServers,
        "use /mcp:playwright for the UI"
      );

      assert.deepStrictEqual(initial.mcpServers, []);
      assert.deepStrictEqual(queued.mcpServers, [playwright]);
      assert.strictEqual(
        getInjectIncompatibilityReason(
          createInteractiveInjectContext(initial),
          queued,
          "session-existing"
        ),
        "mcpServers changed"
      );
    });
  });

  test("does not classify ctrlyoke slash references as native commands", () => {
    const integration = createTestIntegration();

    assert.strictEqual(integration.extractSlashCommand("/commit"), "/commit");
    assert.strictEqual(integration.extractSlashCommand("/mcp"), "/mcp");
    assert.strictEqual(integration.extractSlashCommand("/skill:commit"), null);
    assert.strictEqual(
      integration.extractSlashCommand("/mcp:playwright"),
      null
    );
  });

  test("should delegate retained artifact policy to the CLI provider", () => {
    assert.strictEqual(
      createHeadlessIntegration().shouldRetainWorkflowArtifactsForReuse(),
      false
    );
    assert.strictEqual(
      createHeadlessIntegration({
        shouldRetainWorkflowArtifactsForReuse: () => true,
      }).shouldRetainWorkflowArtifactsForReuse(),
      true
    );
  });

  test("should include install and sign-in guidance when unavailable", async () => {
    const integration = createHeadlessIntegration({
      config: {
        installHint: "Install via: npm install -g test-cli",
      } as ICliProvider["config"],
      checkAvailability: async () => false,
    });

    await integration.initialize();

    assert.strictEqual(
      integration.getDetailedStatus().message,
      "❌ Test CLI unavailable. Install via: npm install -g test-cli. Then sign in with the CLI before running a workflow."
    );
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

  test("streams a log-sourced headless response in standalone CLI context", async function () {
    this.timeout(15_000);
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-standalone-")
    );
    const rawLogEvents: BaseCliEvent[][] = [
      [],
      [{ type: "text", text: "standalone log response" }],
    ];
    const parser = {
      discoverSessionLog: async () => "standalone-session.log",
      readNewLines: async () => rawLogEvents.shift() ?? [],
      extractTimestamp: () => null,
      extractSessionId: () => "standalone-session",
      extractStructuredEventsFromEvent: (event: BaseCliEvent) =>
        event.type === "text"
          ? [{ type: "text", data: { text: String(event.text) } }]
          : [],
      extractResponse: (events: BaseCliEvent[]) => ({
        events: events
          .filter((event) => event.type === "text")
          .map((event) => ({
            type: "text",
            data: { text: String(event.text) },
          })),
        metadata: { sessionId: "standalone-session" },
      }),
      isComplete: () => false,
      extractContentFromEvent: () => undefined,
      formatStatistics: () => "",
      watchLogFile: () => ({ close() {} }) as never,
    } as unknown as ILogParser;
    const provider = createProvider({
      config: {
        ...createProvider().config,
        harnessId: HARNESS_IDS.COPILOT_CLI,
      },
      headlessSource: "log",
      parseHeadlessStdout: undefined,
      logParser: parser,
    });
    const platform = new CliAdapter({
      harness: HARNESS_IDS.COPILOT_CLI,
      cwd: workspaceRoot,
      timeout: 10_000,
      scriptTimeout: 10_000,
      permissionMode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
      allowedTools: [],
      deniedTools: [],
      additionalDirs: [],
      verbose: false,
      quiet: true,
      json: false,
      color: false,
      cliExecutionMode: EXECUTION_MODES.HEADLESS,
      vars: {},
    });
    const integration = new CliIntegration(provider, platform, false);
    const streamed: string[] = [];
    const completed: string[] = [];
    const streamingDisposable = integration.onStreamingEvents((events) => {
      streamed.push(
        ...events.map((event) => (event.data as { text: string }).text)
      );
    });
    const completeDisposable = integration.onResponseComplete((response) => {
      completed.push(response);
    });

    try {
      const processManager = (integration as any).processManager as {
        spawn: (
          command: string,
          args: string[],
          options: { onStdout?: (chunk: string) => void }
        ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      };
      processManager.spawn = async (_command, _args, options) => {
        options.onStdout?.("standalone stdout clock\n");
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      const success = await integration.sendPrompt({ prompt: "say hi" });

      assert.strictEqual(success, true);
      assert.deepStrictEqual(streamed, ["standalone log response"]);
      assert.deepStrictEqual(completed, ["standalone log response"]);
      assert.strictEqual(
        (integration as any).provider.logParser,
        parser,
        "the standalone path must use the provider's configured log parser"
      );
    } finally {
      streamingDisposable.dispose();
      completeDisposable.dispose();
      integration.dispose();
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("should use the session execution mode for dispatch over the global setting", async () => {
    const integration = createTestIntegration();
    let interactiveCalled = false;
    let headlessCalled = false;

    (integration as any).sessionResolverAdapter.resolve = () => ({
      resolvedProperties: { executionMode: EXECUTION_MODES.INTERACTIVE },
      resolvedSessionId: undefined,
    });
    (integration as any).executionRunner.executeInteractive = async () => {
      interactiveCalled = true;
      return true;
    };
    (integration as any).executionRunner.executeHeadless = async () => {
      headlessCalled = true;
      return true;
    };

    const success = await integration.sendPrompt({ prompt: "interactive" });

    assert.strictEqual(success, true);
    assert.strictEqual(interactiveCalled, true);
    assert.strictEqual(headlessCalled, false);
  });

  test("routes runtime permission diagnostics through the workflow status callback", async () => {
    const diagnostic: CompatibilityDiagnostic = {
      code: "compatibility.permissions.deniedTools.notEnforced",
      severity: "warning",
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      capability: "deniedTools",
      state: {
        fidelity: "unsupported",
        mechanism: "none",
        verification: "unknown",
      },
      message: "Denied tools are not enforced.",
    };
    const surfaced: CompatibilityDiagnostic[] = [];
    const integration = createHeadlessIntegration({
      prepareToolPermissions: async () => ({
        cliArgs: [],
        diagnostics: [diagnostic],
      }),
    });
    (integration as any).sessionResolverAdapter.resolve = () => ({
      resolvedProperties: createResolvedProperties({
        executionMode: EXECUTION_MODES.HEADLESS,
        toolPermissions: {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: [],
          deniedTools: ["mcp__ctrlyoke__append_queue"],
        },
      }),
      resolvedSessionId: undefined,
    });
    (integration as any).executionRunner.executeHeadless = async () => true;

    try {
      const success = await integration.sendPrompt({ prompt: "run" }, true, {
        promptIndex: 1,
        allPrompts: [{ prompt: "first" }, { prompt: "run" }],
        reportCompatibilityDiagnostics: (diagnostics) =>
          surfaced.push(...diagnostics),
      });

      assert.strictEqual(success, true);
      assert.strictEqual(surfaced.length, 1);
      assert.deepStrictEqual(surfaced[0].consumer, {
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex: 1,
      });
    } finally {
      integration.dispose();
    }
  });

  test("should dispatch a headless session when the global setting is interactive", async () => {
    configService.setCliOverlay({
      defaults: { executionMode: EXECUTION_MODES.INTERACTIVE },
    });
    const integration = createTestIntegration();
    let headlessCalled = false;

    (integration as any).sessionResolverAdapter.resolve = () => ({
      resolvedProperties: { executionMode: EXECUTION_MODES.HEADLESS },
      resolvedSessionId: undefined,
    });
    (integration as any).executionRunner.executeHeadless = async () => {
      headlessCalled = true;
      return true;
    };

    const success = await integration.sendPrompt({ prompt: "headless" });

    assert.strictEqual(success, true);
    assert.strictEqual(headlessCalled, true);
  });

  test("starts and stops the execution sidecar around both execution branches", async () => {
    for (const executionMode of [
      EXECUTION_MODES.INTERACTIVE,
      EXECUTION_MODES.HEADLESS,
    ]) {
      const lifecycle: string[] = [];
      const integration = createTestIntegration({
        startExecutionSidecar: (deps) => {
          lifecycle.push("start");
          assert.strictEqual(deps.workspaceRoot, process.cwd());
          assert.strictEqual(deps.model, "test-model");
          assert.strictEqual(typeof deps.onStreamingEvents, "function");
          assert.strictEqual(typeof deps.onContextWindowUpdate, "function");
          return {
            stop: () => lifecycle.push("stop"),
          };
        },
      });

      (integration as any).sessionResolverAdapter.resolve = () => ({
        resolvedProperties: {
          executionMode,
          model: "test-model",
        },
        resolvedSessionId: undefined,
      });
      (integration as any).executionRunner[
        executionMode === EXECUTION_MODES.INTERACTIVE
          ? "executeInteractive"
          : "executeHeadless"
      ] = async () => {
        lifecycle.push("execute");
        return true;
      };

      assert.strictEqual(
        await integration.sendPrompt({ prompt: executionMode }),
        true
      );
      assert.deepStrictEqual(lifecycle, ["start", "execute", "stop"]);
      integration.dispose();
    }
  });

  test("starts and stops the execution sidecar around an injected turn", async () => {
    configService.setCliOverlay({
      defaults: { executionMode: EXECUTION_MODES.INTERACTIVE },
    });
    const lifecycle: string[] = [];
    const integration = createTestIntegration({
      startExecutionSidecar: () => {
        lifecycle.push("start");
        return {
          stop: () => lifecycle.push("stop"),
        };
      },
    });
    (integration as any).sessionResolverAdapter.resolve = () => ({
      resolvedProperties: createResolvedProperties(),
      resolvedSessionId: "session-existing",
    });
    (integration as any).shouldUseInjectMode = () => true;
    (integration as any).executionRunner.executeInteractiveInject =
      async () => {
        lifecycle.push("execute");
        return { injected: true, success: true };
      };

    assert.strictEqual(
      await integration.sendPrompt({ prompt: "continue" }),
      true
    );
    assert.deepStrictEqual(lifecycle, ["start", "execute", "stop"]);
    integration.dispose();
  });

  test("should skip inject mode for a headless session", async () => {
    configService.setCliOverlay({
      defaults: { executionMode: EXECUTION_MODES.INTERACTIVE },
    });
    const integration = createTestIntegration();
    let shouldUseInjectModeCalled = false;
    let headlessCalled = false;

    (integration as any).sessionResolverAdapter.resolve = () => ({
      resolvedProperties: { executionMode: EXECUTION_MODES.HEADLESS },
      resolvedSessionId: undefined,
    });
    (integration as any).shouldUseInjectMode = () => {
      shouldUseInjectModeCalled = true;
      return true;
    };
    (integration as any).executionRunner.executeHeadless = async () => {
      headlessCalled = true;
      return true;
    };

    const success = await integration.sendPrompt({ prompt: "headless" });

    assert.strictEqual(success, true);
    assert.strictEqual(headlessCalled, true);
    assert.strictEqual(shouldUseInjectModeCalled, false);
  });

  test("should use the global execution mode when no session properties exist", () => {
    const integration = createTestIntegration();

    assert.strictEqual(
      integration.configuredExecutionMode(),
      EXECUTION_MODES.HEADLESS
    );

    configService.setCliOverlay({
      defaults: { executionMode: EXECUTION_MODES.INTERACTIVE },
    });
    assert.strictEqual(
      integration.configuredExecutionMode(),
      EXECUTION_MODES.INTERACTIVE
    );
  });

  test("passes every workspace root to CLI providers", async () => {
    const primaryRoot = path.join(os.tmpdir(), "ctrlyoke-primary-root");
    const secondaryRoot = path.join(os.tmpdir(), "ctrlyoke-secondary-root");
    let receivedWorkspaceRoots: readonly string[] | undefined;

    class MultiRootPlatform extends MockVsCodePlatform {
      override getWorkspaceRoot(): string {
        return primaryRoot;
      }

      override getWorkspaceRoots(): string[] {
        return [primaryRoot, secondaryRoot];
      }
    }

    const integration = new CliIntegration(
      createProvider({
        buildCliArgs: async (
          _prompt,
          _isInteractive,
          _extensionPath,
          _workspaceRoot,
          _sessionId,
          _workflowContext,
          workspaceRoots
        ) => {
          receivedWorkspaceRoots = workspaceRoots;
          return ["--base"];
        },
      }),
      new MultiRootPlatform(),
      false
    );
    (integration as any).executionRunner.executeHeadless = async () => true;

    const success = await integration.sendPrompt({ prompt: "say hi" });

    assert.strictEqual(success, true);
    assert.deepStrictEqual(receivedWorkspaceRoots, [
      primaryRoot,
      secondaryRoot,
    ]);
  });

  test("routes execution calls through execution roots while preserving state root access", async () => {
    const stateRoot = path.join(os.tmpdir(), "ctrlyoke-state-root");
    const executionRoot = path.join(os.tmpdir(), "ctrlyoke-execution-root");
    const executionWorkspace: ExecutionWorkspace = {
      stateRoot,
      executionRoot,
      workspaceRoots: [executionRoot],
      namedWorkspaceRoots: [{ name: "root", fsPath: executionRoot }],
      approvedExternalRoots: [],
    };
    let receivedRoot: string | undefined;
    let receivedRoots: readonly string[] | undefined;

    const integration = new CliIntegration(
      createProvider({
        buildCliArgs: async (
          _prompt,
          _isInteractive,
          _extensionPath,
          workspaceRoot,
          _sessionId,
          _workflowContext,
          workspaceRoots
        ) => {
          receivedRoot = workspaceRoot;
          receivedRoots = workspaceRoots;
          return ["--base"];
        },
      }),
      new MockVsCodePlatform(),
      false,
      undefined,
      undefined,
      executionWorkspace
    );
    (integration as any).executionRunner.executeHeadless = async () => true;

    assert.strictEqual(integration.getStateRoot(), stateRoot);
    assert.strictEqual(integration.getExecutionRoot(), executionRoot);
    assert.strictEqual(
      await integration.sendPrompt({ prompt: "route this" }),
      true
    );
    assert.strictEqual(receivedRoot, executionRoot);
    assert.deepStrictEqual(receivedRoots, [executionRoot]);
  });

  test("should keep categorized CLI wrapper prompts on one line", () => {
    const integration = createTestIntegration();

    const formatted = integration.formatRefs(
      [],
      [],
      ["@src/ui/webview-react/components/output/CliOutput.tsx"],
      [],
      [],
      ["@.ctrlyoke/temp/example.prompt.md"]
    );

    assert.strictEqual(
      formatted,
      "using these file references @src/ui/webview-react/components/output/CliOutput.tsx, follow the instructions in @.ctrlyoke/temp/example.prompt.md "
    );
    assert.strictEqual(/[\r\n]/u.test(formatted), false);
  });

  test("places available secrets after agents and before skills", () => {
    const integration = createTestIntegration();

    const formatted = integration.formatRefs(
      ["@agent.md"],
      ["@skills.md"],
      ["@src/file.ts"],
      [],
      ["@excerpt.md"],
      ["@prompt.md"],
      ["@secrets.md"]
    );

    assert.strictEqual(
      formatted,
      "Following these agent instructions @agent.md, using these secrets @secrets.md, using these available skills @skills.md, using these file references @src/file.ts, and these attachment excerpts @excerpt.md, follow the instructions in @prompt.md "
    );
  });

  test("keeps excerpt prefix as using when it is the first optional clause", () => {
    const integration = createTestIntegration();

    assert.strictEqual(
      integration.formatRefs([], [], [], [], ["@excerpt.md"], ["@prompt.md"]),
      "using these attachment excerpts @excerpt.md, follow the instructions in @prompt.md "
    );
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

  test("does not pass a finalStep response callback during prompt preparation", async () => {
    const integration = createHeadlessIntegration();
    const prompt: PromptStep = { prompt: "say hi" };
    let promptPreparationArguments: any[] = [];

    (integration as any).promptPreparer.preparePrompt = async (
      ...args: any[]
    ) => {
      promptPreparationArguments = args;
      const promptStep = args[0] as PromptStep;
      return {
        promptWithInstruction: promptStep.prompt,
        tempFilePaths: [],
        diagnostics: [],
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
    } as any);

    assert.strictEqual(success, true);
    assert.strictEqual(promptPreparationArguments.length, 5);
    assert.strictEqual(promptPreparationArguments[4], false);
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
      path.join(os.tmpdir(), "ctrlyoke-cli-integration-")
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
        "workflow.ctrlyoke.json",
        workspaceRoot
      );

      assert.strictEqual(fs.existsSync(mcpConfigPath), false);
      assert.strictEqual(fs.existsSync(extraPath), false);
      assert.deepStrictEqual(cleanupArgs, {
        workspaceRoot,
        workingFilePath: "workflow.ctrlyoke.json",
      });
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  suite("effective absolute file references", () => {
    class MockMultiRootPlatform extends MockVsCodePlatform {
      override getWorkspaceRoots(): string[] {
        return [process.cwd(), path.resolve(process.cwd(), "..")];
      }
      override getNamedWorkspaceRoots() {
        return [
          { name: "root", fsPath: process.cwd() },
          { name: "other", fsPath: path.resolve(process.cwd(), "..") },
        ];
      }
    }

    function integrationWithPlatform(
      platform: PlatformAdapter,
      overrides?: Partial<ICliProvider>
    ): CliIntegration {
      return new CliIntegration(createProvider(overrides), platform, false);
    }

    setup(() => {
      configService.setCliOverlay({});
    });

    teardown(() => {
      configService.setCliOverlay({});
    });

    test("single-root, setting off: renders relative", () => {
      configService.setCliOverlay({
        ui: { useAbsolutePathReferences: false },
      });
      const integration = integrationWithPlatform(new MockVsCodePlatform());
      const absolutePath = path.join(process.cwd(), "src", "a.ts");

      const result = (integration as any).formatDirectFileRef(absolutePath);

      assert.strictEqual(result, `@${path.join("src", "a.ts")}`);
    });

    test("single-root, setting on: renders absolute", () => {
      configService.setCliOverlay({
        ui: { useAbsolutePathReferences: true },
      });
      const integration = integrationWithPlatform(new MockVsCodePlatform());
      const absolutePath = path.join(process.cwd(), "src", "a.ts");

      const result = (integration as any).formatDirectFileRef(absolutePath);

      assert.strictEqual(result, `@${absolutePath}`);
    });

    test("multi-root forces absolute even with setting off", () => {
      configService.setCliOverlay({
        ui: { useAbsolutePathReferences: false },
      });
      const integration = integrationWithPlatform(new MockMultiRootPlatform());
      const absolutePath = path.join(process.cwd(), "src", "a.ts");

      const result = (integration as any).formatDirectFileRef(absolutePath);

      assert.strictEqual(result, `@${absolutePath}`);
    });

    test("formatTempFileRef agrees with the same effective-absolute decision", () => {
      configService.setCliOverlay({
        ui: { useAbsolutePathReferences: true },
      });
      const integration = integrationWithPlatform(new MockVsCodePlatform());
      const absolutePath = path.join(
        process.cwd(),
        ".ctrlyoke",
        "temp",
        "x.md"
      );
      const mockTempMgr = {
        getRelativePath: (p: string) => path.relative(process.cwd(), p),
      };

      const result = (integration as any).formatTempFileRef(
        mockTempMgr,
        absolutePath
      );

      assert.strictEqual(result, `@${absolutePath}`);
    });
  });

  suite("buildPromptSections inline reference sanitization", () => {
    class MockDualRootPlatform extends MockVsCodePlatform {
      constructor(
        private readonly primary: string,
        private readonly secondary: string
      ) {
        super();
      }
      override getWorkspaceRoot(): string {
        return this.primary;
      }
      override getWorkspaceRoots(): string[] {
        return [this.primary, this.secondary];
      }
      override getNamedWorkspaceRoots() {
        return [
          { name: "root1", fsPath: this.primary },
          { name: "root2", fsPath: this.secondary },
        ];
      }
    }

    class MockSingleRootPlatform extends MockVsCodePlatform {
      constructor(private readonly root: string) {
        super();
      }
      override getWorkspaceRoot(): string {
        return this.root;
      }
      override getWorkspaceRoots(): string[] {
        return [this.root];
      }
      override getNamedWorkspaceRoots() {
        return [{ name: "root", fsPath: this.root }];
      }
    }

    let tempDirs: string[];

    setup(() => {
      tempDirs = [];
      configService.setCliOverlay({});
    });

    teardown(() => {
      configService.setCliOverlay({});
      for (const dir of tempDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    });

    function mkTempDir(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    }

    test("rewrites a folder-prefixed @ref to its absolute path so the simple-prompt fast path sends a resolvable reference", async () => {
      const root = mkTempDir("fp-cli-");
      const secondRoot = mkTempDir("fp-cli-second-");
      const secondFile = path.join(secondRoot, "b.ts");
      fs.writeFileSync(secondFile, "export const b = true;\n");

      const integration = new TestCliIntegration(
        createProvider(),
        new MockDualRootPlatform(root, secondRoot),
        false
      );

      const sections = await (integration as any).buildPromptSections({
        prompt: "Please fix @root2/b.ts before merging.",
      } as PromptStep);

      assert.strictEqual(
        sections.userPromptText,
        `Please fix @${secondFile} before merging.`
      );
    });

    test("rewrites a folder-prefixed #sym: ref to its absolute path", async () => {
      const root = mkTempDir("fp-cli-");
      const secondRoot = mkTempDir("fp-cli-second-");
      const secondFile = path.join(secondRoot, "b.ts");
      fs.writeFileSync(secondFile, "export function foo() {}\n");

      const integration = new TestCliIntegration(
        createProvider(),
        new MockDualRootPlatform(root, secondRoot),
        false
      );

      const sections = await (integration as any).buildPromptSections({
        prompt: "When #sym:root2/b.ts:foo:1-1 runs, log the result.",
      } as PromptStep);

      // Absolute paths carry the drive colon, which is also the #sym: field
      // separator, so the rewritten path must be quoted to stay parseable.
      assert.strictEqual(
        sections.userPromptText,
        `When #sym:"${secondFile}":foo:1-1 runs, log the result.`
      );
    });

    test("strips the @ prefix for a Codex-like provider even in single-root", async () => {
      const root = mkTempDir("fp-cli-");
      fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");

      const integration = new TestCliIntegration(
        createProvider({
          formatFileReference: (relativeFilePath: string) => relativeFilePath,
        }),
        new MockSingleRootPlatform(root),
        false
      );

      const sections = await (integration as any).buildPromptSections({
        prompt: "Please review @a.ts for issues.",
      } as PromptStep);

      assert.strictEqual(
        sections.userPromptText,
        "Please review a.ts for issues."
      );
    });

    test("single-root, non-Codex provider: leaves an unprefixed @ref textually unchanged", async () => {
      const root = mkTempDir("fp-cli-");
      fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");

      const integration = new TestCliIntegration(
        createProvider(),
        new MockSingleRootPlatform(root),
        false
      );

      const sections = await (integration as any).buildPromptSections({
        prompt: "Please review @a.ts for issues.",
      } as PromptStep);

      assert.strictEqual(
        sections.userPromptText,
        "Please review @a.ts for issues."
      );
    });
  });
});
