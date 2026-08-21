import * as assert from "assert";
import { X509Certificate } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test, afterEach } from "mocha";
import { WebviewSettingsSync } from "../../ui/WebviewSettingsSync";
import { WebviewMessageRouter } from "../../ui/WebviewMessageRouter";
import {
  MESSAGE_TYPES,
  HARNESS_IDS,
  PROMPT_PROPERTIES,
  PERMISSION_MODES,
  PANEL_CLIENT_ID,
  type SettingWriteScope,
  type StatusLineTrackingHarnessId,
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
import { CONFIG_KEYS } from "../../utils/ConfigurationUtils";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import type { StatusLineTrackingSettings } from "../../types/CtrlYokeSettings";
import { DEFAULT_STATUS_LINE_FORMAT } from "../../utils/StatuslineFormat";
import {
  StatuslineManager,
  type StatuslineManagerLike,
} from "../../core/harness/shared/StatuslineManager";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOrchestrator(
  workingFilePath: string | undefined,
  viewFilePath: string | null = null
) {
  return {
    getViewFilePath: (_clientId: string) => viewFilePath,
    getQueueState: (_clientId: string) => ({ workingFilePath }),
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

suite("WebviewSettingsSync", () => {
  const tempPaths: string[] = [];
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  );

  function tempFile(name?: string): string {
    const p = path.join(
      os.tmpdir(),
      `fp-wss-${name ?? Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    tempPaths.push(p);
    return p;
  }

  afterEach(async () => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(
        globalThis,
        "navigator",
        originalNavigatorDescriptor
      );
    }
    for (const p of tempPaths.splice(0)) {
      try {
        await fs.rm(p, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function tempDir(name?: string): string {
    const p = path.join(
      os.tmpdir(),
      `fp-wss-${name ?? Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tempPaths.push(p);
    return p;
  }

  suite("disable statusline tracking", () => {
    class FakeStatuslineManager implements StatuslineManagerLike {
      readonly uninstallCalls: Array<{
        workspaceRoot: string;
        restoreCustomCommand: boolean;
      }> = [];

      constructor(readonly settings: StatusLineTrackingSettings) {}

      getSettings(): StatusLineTrackingSettings {
        return this.settings;
      }

      async uninstall(
        workspaceRoot: string,
        restoreCustomCommand: boolean
      ): Promise<void> {
        this.uninstallCalls.push({ workspaceRoot, restoreCustomCommand });
      }
    }

    function makeSync(
      managers: Partial<
        Record<StatusLineTrackingHarnessId, FakeStatuslineManager>
      >,
      messages: unknown[],
      feedback: unknown[] = []
    ): WebviewSettingsSync {
      const sync = new WebviewSettingsSync(
        (message) => messages.push(message),
        () =>
          ({
            getUserFeedbackSink: () => ({
              notify: (message: unknown) => feedback.push(message),
            }),
          }) as any,
        undefined,
        (harnessId) => {
          const manager = managers[harnessId];
          if (!manager) {
            throw new Error(`missing fake manager for ${harnessId}`);
          }
          return manager;
        }
      );
      return sync;
    }

    test("disables both supported harnesses with restore and delete choices", async () => {
      const originalSet = configService.set;
      const writes: Array<{ key: string; value: unknown; scope: string }> = [];

      try {
        configService.set = (async (key, value, scope) => {
          writes.push({ key, value, scope });
        }) as typeof configService.set;

        for (const [harnessId, restoreCustomCommand] of [
          [HARNESS_IDS.CLAUDE_CLI, true],
          [HARNESS_IDS.ANTIGRAVITY_CLI, false],
        ] as const) {
          const manager = new FakeStatuslineManager({
            enabled: true,
            customCommand: "node user-statusline.js",
            useCtrlyokeStyle: true,
            format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
          });
          const messages: unknown[] = [];
          const sync = makeSync({ [harnessId]: manager }, messages);
          let refreshCount = 0;
          sync.handleGlobalSettingsLoadRequest = async () => {
            refreshCount++;
          };

          await sync.handleDisableStatusLineTracking({
            type: MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING,
            harnessId,
            restoreCustomCommand,
          });

          assert.strictEqual(manager.uninstallCalls.length, 1);
          assert.strictEqual(
            manager.uninstallCalls[0].restoreCustomCommand,
            restoreCustomCommand
          );
          assert.strictEqual(refreshCount, 1);
          assert.deepStrictEqual(messages, [
            {
              type: MESSAGE_TYPES.GLOBAL_SETTING_UPDATED,
              path: `${CONFIG_KEYS.PERMISSIONS_STATUS_LINE_TRACKING}.${StatuslineManager.providerForHarness(harnessId)}`,
              value: {
                enabled: false,
                customCommand: "node user-statusline.js",
                useCtrlyokeStyle: true,
                format: DEFAULT_STATUS_LINE_FORMAT,
              },
              source: "user",
            },
          ]);
        }
      } finally {
        configService.set = originalSet;
      }

      assert.deepStrictEqual(
        writes.map(({ key, value, scope }) => ({
          key,
          value,
          scope,
        })),
        [
          {
            key: `${CONFIG_KEYS.PERMISSIONS_STATUS_LINE_TRACKING}.claude`,
            value: {
              enabled: false,
              customCommand: "node user-statusline.js",
              useCtrlyokeStyle: true,
              format: DEFAULT_STATUS_LINE_FORMAT,
            },
            scope: "user",
          },
          {
            key: `${CONFIG_KEYS.PERMISSIONS_STATUS_LINE_TRACKING}.antigravity`,
            value: {
              enabled: false,
              customCommand: "node user-statusline.js",
              useCtrlyokeStyle: true,
              format: DEFAULT_STATUS_LINE_FORMAT,
            },
            scope: "user",
          },
        ]
      );
    });

    test("rolls back the enabled setting and reports a harness-file failure", async () => {
      const originalSet = configService.set;
      const writes: Array<{ value: unknown; scope: string }> = [];
      const feedback: unknown[] = [];
      const manager = new FakeStatuslineManager({
        enabled: true,
        customCommand: "node user-statusline.js",
        useCtrlyokeStyle: false,
        format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      });
      manager.uninstall = async () => {
        throw new Error("settings file is locked");
      };
      const messages: unknown[] = [];
      const sync = makeSync(
        { [HARNESS_IDS.CLAUDE_CLI]: manager },
        messages,
        feedback
      );
      let refreshCount = 0;
      sync.handleGlobalSettingsLoadRequest = async () => {
        refreshCount++;
      };

      try {
        configService.set = (async (_key, value, scope) => {
          writes.push({ value, scope });
        }) as typeof configService.set;

        await sync.handleDisableStatusLineTracking({
          type: MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING,
          harnessId: HARNESS_IDS.CLAUDE_CLI,
          restoreCustomCommand: true,
        });
      } finally {
        configService.set = originalSet;
      }

      assert.strictEqual(refreshCount, 0);
      assert.deepStrictEqual(messages, []);
      assert.deepStrictEqual(writes, [
        {
          value: {
            enabled: false,
            customCommand: "node user-statusline.js",
            useCtrlyokeStyle: false,
            format: DEFAULT_STATUS_LINE_FORMAT,
          },
          scope: "user",
        },
        {
          value: {
            enabled: true,
            customCommand: "node user-statusline.js",
            useCtrlyokeStyle: false,
            format: DEFAULT_STATUS_LINE_FORMAT,
          },
          scope: "user",
        },
      ]);
      assert.strictEqual(feedback.length, 1);
      assert.match(
        (feedback[0] as { message: string }).message,
        /tracking remains enabled/
      );
    });

    test("reports a config failure without touching the harness file", async () => {
      const originalSet = configService.set;
      const feedback: unknown[] = [];
      const manager = new FakeStatuslineManager({
        enabled: true,
        customCommand: "node user-statusline.js",
        useCtrlyokeStyle: true,
        format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      });
      const sync = makeSync(
        { [HARNESS_IDS.ANTIGRAVITY_CLI]: manager },
        [],
        feedback
      );

      try {
        configService.set = (async () => {
          throw new Error("user settings unavailable");
        }) as typeof configService.set;

        await sync.handleDisableStatusLineTracking({
          type: MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING,
          harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
          restoreCustomCommand: false,
        });
      } finally {
        configService.set = originalSet;
      }

      assert.strictEqual(manager.uninstallCalls.length, 0);
      assert.strictEqual(feedback.length, 1);
      assert.match(
        (feedback[0] as { message: string }).message,
        /Could not disable statusline tracking/
      );
    });

    test("rejects unsupported harness ids without changing config or files", async () => {
      const originalSet = configService.set;
      const writes: unknown[] = [];
      const feedback: unknown[] = [];
      const manager = new FakeStatuslineManager({
        enabled: true,
        customCommand: "node user-statusline.js",
        useCtrlyokeStyle: true,
        format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      });
      const sync = makeSync(
        { [HARNESS_IDS.CLAUDE_CLI]: manager },
        [],
        feedback
      );

      try {
        configService.set = (async (...args: unknown[]) => {
          writes.push(args);
        }) as typeof configService.set;

        await sync.handleDisableStatusLineTracking({
          type: MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING,
          harnessId: HARNESS_IDS.COPILOT_CLI,
          restoreCustomCommand: false,
        } as any);
      } finally {
        configService.set = originalSet;
      }

      assert.deepStrictEqual(writes, []);
      assert.strictEqual(manager.uninstallCalls.length, 0);
      assert.strictEqual(feedback.length, 1);
    });
  });

  suite("notifyHarnessAvailability", () => {
    test("should forward provider install guidance with availability updates", () => {
      const messages: any[] = [];
      const sync = new WebviewSettingsSync(
        (message) => messages.push(message),
        () => undefined
      );

      sync.notifyHarnessAvailability(
        HARNESS_IDS.CODEX_CLI,
        false,
        "Install via: npm install -g @openai/codex-cli"
      );

      const update = messages.find(
        (message) => message.type === MESSAGE_TYPES.HARNESS_STATUS_UPDATE
      );
      assert.deepStrictEqual(update.data.harnessStatus[HARNESS_IDS.CODEX_CLI], {
        available: false,
        status: "unavailable",
        installHint: "Install via: npm install -g @openai/codex-cli",
      });
    });

    test("publishes the shared capability snapshot after refreshing a harness", async () => {
      const messages: any[] = [];
      const snapshot = {
        schemaVersion: 1,
        enabledDomains: ["permissions"],
        harnesses: {},
      };
      let refreshed: string | undefined;
      const sync = new WebviewSettingsSync(
        (message) => messages.push(message),
        () =>
          ({
            getCompatibilityRegistry: () => ({
              refresh: async (harnessId: string) => {
                refreshed = harnessId;
              },
              getSnapshot: async () => snapshot,
            }),
          }) as any
      );

      await sync.sendHarnessCapabilitySnapshot(
        (message) => messages.push(message),
        HARNESS_IDS.CODEX_CLI
      );

      assert.strictEqual(refreshed, HARNESS_IDS.CODEX_CLI);
      assert.deepStrictEqual(
        messages.find(
          (message) =>
            message.type === MESSAGE_TYPES.HARNESS_CAPABILITY_SNAPSHOT
        ),
        {
          type: MESSAGE_TYPES.HARNESS_CAPABILITY_SNAPSHOT,
          data: { snapshot },
        }
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Regression: INIT is a per-client message, so its workflow half must describe
  // the receiving client. It used to read PANEL_CLIENT_ID unconditionally, and
  // `getInstanceForClient` falls back to the panel's instance for any client
  // with no binding of its own. Browser clients are unbound on every socket
  // close (`unregisterClient` clears their viewed id), so each reconnect READY
  // pushed the *panel's* workflow to the browser and the dashboard visibly
  // jumped off whatever the user was viewing — repeatedly, on a flaky link.
  // ────────────────────────────────────────────────────────────────────────────
  suite("sendInitialState workflow scoping", () => {
    /**
     * `views` maps a client to the workflow its bound instance holds.
     * `bound` is the separate viewer-registry answer, mirroring the real
     * orchestrator: the panel resolves to a lazily created instance even when
     * it is not registered, every other client resolves to nothing.
     */
    function makeViewOrchestrator(
      views: Record<string, string | undefined>,
      bound: string[] = Object.keys(views)
    ) {
      return {
        hasViewedWorkflow: (clientId: string) => bound.includes(clientId),
        getQueueState: (clientId: string) => ({
          workflowName: views[clientId],
          steps: views[clientId] ? [{ prompt: "step one" }] : [],
          status: "idle",
          currentIndex: 0,
          results: [],
        }),
        getCurrentPromptFile: (clientId: string) =>
          views[clientId]
            ? { fileName: `${views[clientId]}.json`, steps: [] }
            : null,
        getActivePromptQueue: () => null,
        getCompatibilityRegistry: () => undefined,
      } as any;
    }

    test("sends the requesting client's own workflow, not the panel's", async () => {
      const messages: any[] = [];
      const postMessage = (msg: any) => messages.push(msg);
      const sync = new WebviewSettingsSync(postMessage, () =>
        makeViewOrchestrator({
          [PANEL_CLIENT_ID]: "panel-workflow",
          "browser:1": "browser-workflow",
        })
      );

      await sync.sendInitialState(postMessage, "browser:1");

      const init = messages.find((m) => m.type === MESSAGE_TYPES.INIT);
      assert.strictEqual(
        init.data.workflowName,
        "browser-workflow",
        "INIT must describe the client it is sent to"
      );
      assert.strictEqual(init.data.fileName, "browser-workflow.json");
    });

    test("sends an empty workflow to a client with no view of its own", async () => {
      const messages: any[] = [];
      const postMessage = (msg: any) => messages.push(msg);
      const sync = new WebviewSettingsSync(postMessage, () =>
        makeViewOrchestrator({ [PANEL_CLIENT_ID]: "panel-workflow" })
      );

      // A browser client that just reconnected: registered, but not yet bound
      // to a workflow. handleClientReady replays its real view moments later.
      await sync.sendInitialState(postMessage, "browser:1");

      const init = messages.find((m) => m.type === MESSAGE_TYPES.INIT);
      assert.deepStrictEqual(
        init.data.steps,
        [],
        "an empty steps array is what makes the webview's INIT handler leave the client's current view untouched"
      );
      assert.strictEqual(init.data.workflowName, "");
      assert.strictEqual(init.data.fileName, "");
    });

    test("still describes the panel's lazily created instance for an unbound panel", async () => {
      const messages: any[] = [];
      const postMessage = (msg: any) => messages.push(msg);
      // Nothing is bound in the viewer registry — the state the panel gets here
      // comes from the instance `getActiveInstance()` creates on demand, which
      // is the one client legitimately entitled to that fallback.
      const sync = new WebviewSettingsSync(postMessage, () =>
        makeViewOrchestrator({ [PANEL_CLIENT_ID]: "panel-workflow" }, [])
      );

      await sync.sendInitialState(postMessage);

      const init = messages.find((m) => m.type === MESSAGE_TYPES.INIT);
      assert.strictEqual(init.data.workflowName, "panel-workflow");
    });
  });

  suite("handleGlobalSettingsLoadRequest", () => {
    test("should include notifications settings and leaf-level source metadata", async () => {
      const originalGetAll = configService.getAll.bind(configService);
      const originalGetLeafSources =
        configService.getLeafSources.bind(configService);

      try {
        configService.getAll = (() => ({
          ...CTRLYOKE_SETTINGS_DEFAULTS,
          notifications: {
            ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
            browser: {
              ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.browser,
              mode: "push",
            },
          },
        })) as typeof configService.getAll;

        configService.getLeafSources = (() => ({
          "notifications.browser.mode": "workspace",
        })) as typeof configService.getLeafSources;

        const messages: any[] = [];
        const postMessage = (msg: any) => messages.push(msg);
        const sync = new WebviewSettingsSync(postMessage, () => undefined);

        await sync.handleGlobalSettingsLoadRequest(postMessage);

        const settingsMsg = messages.find(
          (m) => m.type === MESSAGE_TYPES.GLOBAL_SETTINGS_LOADED
        );
        assert.ok(settingsMsg, "GLOBAL_SETTINGS_LOADED should be sent");
        assert.strictEqual(
          settingsMsg.settings.settings.notifications.browser.mode,
          "push"
        );
        assert.strictEqual(
          settingsMsg.settings.sources["notifications.browser.mode"],
          "workspace"
        );
      } finally {
        configService.getAll = originalGetAll;
        configService.getLeafSources = originalGetLeafSources;
      }
    });
  });

  suite("discoverAgents", () => {
    test("should expose bundled agents when no workspace is open", async () => {
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      const messages: any[] = [];

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: undefined,
          configurable: true,
        });
        const sync = new WebviewSettingsSync(
          (message) => messages.push(message),
          () => undefined
        );

        await sync.discoverAgents();

        const update = messages.find(
          (message) => message.type === MESSAGE_TYPES.AGENTS_UPDATE
        );
        assert.ok(update, "agent discovery should notify the dashboard");
        assert.ok(
          update.data.availableAgents.some(
            (agent: { name: string }) =>
              agent.name === "ctrlyoke-workflow-composer"
          ),
          "the bundled workflow composer should be available without a workspace"
        );
      } finally {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
      }
    });
  });

  suite("handleGenerateServerCert", () => {
    function hideGlobalNavigator(): void {
      Object.defineProperty(globalThis, "navigator", {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }

    test("should save generated certs to the user ctrlyoke folder when scope is user", async function () {
      // Real RSA-2048 keygen via selfsigned/node-forge is synchronous and slow;
      // this test also pays the one-time `import("selfsigned")` cost, so the
      // default 2000ms mocha timeout is too tight.
      this.timeout(20_000);

      const originalGet = configService.get.bind(configService);
      const originalSet = configService.set.bind(configService);

      const homeDir = tempDir("user-home");
      const setCalls: Array<{ key: string; value: unknown; scope: string }> =
        [];

      try {
        configService.get = ((key: string) =>
          key === CONFIG_KEYS.SERVER
            ? { bindAddress: "127.0.0.1" }
            : undefined) as typeof configService.get;
        configService.set = (async (key, value, scope) => {
          setCalls.push({ key, value, scope });
        }) as typeof configService.set;

        const messages: any[] = [];
        const postMessage = (msg: any) => messages.push(msg);
        const sync = new WebviewSettingsSync(postMessage, () => undefined);

        hideGlobalNavigator();
        await sync.handleGenerateServerCert(postMessage, "user", () => homeDir);

        const expectedCertPath = path.join(
          homeDir,
          ".ctrlyoke",
          "certs",
          "cert.pem"
        );
        const expectedKeyPath = path.join(
          homeDir,
          ".ctrlyoke",
          "certs",
          "key.pem"
        );

        await fs.access(expectedCertPath);
        await fs.access(expectedKeyPath);

        const certPem = await fs.readFile(expectedCertPath, "utf8");
        const keyPem = await fs.readFile(expectedKeyPath, "utf8");
        const cert = new X509Certificate(certPem);

        assert.match(
          keyPem,
          /^-----BEGIN PRIVATE KEY-----/m,
          "generated key should remain a Node-compatible PKCS#8 private key"
        );
        assert.strictEqual(
          cert.ca,
          true,
          "generated certificate must remain a CA certificate for the mobile trust flow"
        );
        assert.match(
          cert.subject,
          /CN=ctrlyoke Local CA/,
          "generated certificate should preserve the expected common name"
        );
        assert.match(
          cert.subjectAltName ?? "",
          /DNS:localhost/,
          "generated certificate should include localhost as a DNS SAN"
        );
        assert.match(
          cert.subjectAltName ?? "",
          /IP Address:127\.0\.0\.1/,
          "generated certificate should include loopback as an IP SAN"
        );

        assert.deepStrictEqual(
          setCalls,
          [
            {
              key: CONFIG_KEYS.SERVER_TLS_CERT_PATH,
              value: expectedCertPath,
              scope: "user",
            },
            {
              key: CONFIG_KEYS.SERVER_TLS_KEY_PATH,
              value: expectedKeyPath,
              scope: "user",
            },
          ],
          "user-scoped cert generation should save paths under ~/.ctrlyoke/certs and persist them to user settings"
        );
      } finally {
        configService.get = originalGet;
        configService.set = originalSet;
      }
    });

    test("should save generated certs to the workspace ctrlyoke folder when scope is workspace", async function () {
      // Real RSA-2048 keygen is synchronous and slow — see the user-scope test above.
      this.timeout(20_000);

      const originalGet = configService.get.bind(configService);
      const originalSet = configService.set.bind(configService);
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;

      const workspaceRoot = tempDir("workspace-root");
      const setCalls: Array<{ key: string; value: unknown; scope: string }> =
        [];

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: [{ uri: vscode.Uri.file(workspaceRoot) }],
          configurable: true,
        });
        configService.get = ((key: string) =>
          key === CONFIG_KEYS.SERVER
            ? { bindAddress: "127.0.0.1" }
            : undefined) as typeof configService.get;
        configService.set = (async (key, value, scope) => {
          setCalls.push({ key, value, scope });
        }) as typeof configService.set;

        const messages: any[] = [];
        const postMessage = (msg: any) => messages.push(msg);
        const sync = new WebviewSettingsSync(postMessage, () => undefined);

        hideGlobalNavigator();
        await sync.handleGenerateServerCert(postMessage, "workspace");

        // Use the URI's fsPath so drive-letter casing matches what the implementation sees.
        const workspaceFsPath = vscode.Uri.file(workspaceRoot).fsPath;
        const expectedCertPath = path.join(
          workspaceFsPath,
          ".ctrlyoke",
          "certs",
          "cert.pem"
        );
        const expectedKeyPath = path.join(
          workspaceFsPath,
          ".ctrlyoke",
          "certs",
          "key.pem"
        );

        await fs.access(expectedCertPath);
        await fs.access(expectedKeyPath);
        assert.deepStrictEqual(
          setCalls,
          [
            {
              key: CONFIG_KEYS.SERVER_TLS_CERT_PATH,
              value: expectedCertPath,
              scope: "workspace",
            },
            {
              key: CONFIG_KEYS.SERVER_TLS_KEY_PATH,
              value: expectedKeyPath,
              scope: "workspace",
            },
          ],
          "workspace-scoped cert generation should save paths under the workspace .ctrlyoke/certs directory and persist them to workspace settings"
        );
      } finally {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        configService.get = originalGet;
        configService.set = originalSet;
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  suite("sendWorkflowPropertiesToSettings", () => {
    /**
     * Regression: switching to an existing workflow must populate
     * WorkflowPropertiesPanel with all workflow-level properties from the
     * working file.  applyWorkflowChange() no longer clears workflowProperties
     * eagerly (that caused a flash of global defaults) — WORKFLOW_PROPERTIES_UPDATE
     * does a full atomic replacement instead.  This test verifies all 13
     * workflow-level fields survive the round-trip through sendWorkflowPropertiesToSettings.
     */
    test("should load all workflow properties from working file when switching to an existing workflow", async () => {
      const workingFile = {
        workflowName: "existing-workflow",
        startedAt: Date.now(),
        lastModifiedAt: Date.now(),
        harness: "claude-cli",
        model: "claude-opus-4",
        agent: "my-agent.md",
        skills: ["skill-one", "skill-two"],
        resumeSession: true,
        sessionId: "abc-123",
        mcpServers: ["ctrlyoke"],
        hooks: [{ type: "postToolUse", command: "echo done" }],
        errorBehavior: { onError: "retry", maxRetries: 3, retryDelayMs: 2000 },
        endCondition: {
          script: "npm test",
          returns: "true",
          maxRetries: 3,
          timeout: 60,
          retryPrompt: "Fix the failing tests",
        },
        preCondition: { script: "check.sh", returns: "ok" },
        priorContext: "last",
        additionalArgs: "--verbose",
        toolPermissions: {
          mode: "custom",
          allowedTools: ["write"],
          deniedTools: ["shell(rm:*)"],
        },
        steps: [{ prompt: "do the thing" }],
        _runtime: { currentIndex: 0, executionState: "idle" },
      };

      const filePath = tempFile("existing-workflow");
      await fs.writeFile(filePath, JSON.stringify(workingFile), "utf-8");

      const messages: any[] = [];
      const postMessage = (msg: any) => messages.push(msg);
      const sync = new WebviewSettingsSync(postMessage, () =>
        makeOrchestrator(filePath)
      );

      await sync.sendWorkflowPropertiesToSettings(postMessage, "panel");

      const propsMsg = messages.find(
        (m) => m.type === MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE
      );
      assert.ok(
        propsMsg,
        "WORKFLOW_PROPERTIES_UPDATE message should be sent on workflow switch"
      );

      const props = propsMsg.workflowProperties;
      assert.strictEqual(
        props.harness,
        "claude-cli",
        "harness should be loaded from working file"
      );
      assert.strictEqual(
        props.model,
        "claude-opus-4",
        "model should be loaded from working file"
      );
      assert.strictEqual(
        props.agent,
        "my-agent.md",
        "agent should be loaded from working file"
      );
      assert.deepStrictEqual(
        props.skills,
        ["skill-one", "skill-two"],
        "skills should be loaded from working file"
      );
      assert.strictEqual(
        props.resumeSession,
        true,
        "resumeSession should be loaded from working file"
      );
      assert.strictEqual(
        props.sessionId,
        "abc-123",
        "sessionId should be loaded from working file"
      );
      assert.deepStrictEqual(
        props.mcpServers,
        ["ctrlyoke"],
        "mcpServers should be loaded from working file"
      );
      assert.deepStrictEqual(
        props.hooks,
        [{ type: "postToolUse", command: "echo done" }],
        "hooks should be loaded from working file"
      );
      assert.deepStrictEqual(
        props.errorBehavior,
        { onError: "retry", maxRetries: 3, retryDelayMs: 2000 },
        "errorBehavior should be loaded from working file"
      );
      assert.deepStrictEqual(
        props.endCondition,
        workingFile.endCondition,
        "endCondition should be loaded from working file"
      );
      assert.deepStrictEqual(
        props.preCondition,
        workingFile.preCondition,
        "preCondition should be loaded from working file"
      );
      assert.strictEqual(
        props.priorContext,
        "last",
        "priorContext should be loaded from working file"
      );
      assert.strictEqual(
        props.additionalArgs,
        "--verbose",
        "additionalArgs should be loaded from working file"
      );
      assert.deepStrictEqual(
        props.toolPermissions,
        workingFile.toolPermissions,
        "toolPermissions should be loaded from working file"
      );

      const loadedMsg = messages.find(
        (m) => m.type === MESSAGE_TYPES.WORKFLOW_LOADED
      );
      assert.ok(
        loadedMsg,
        "WORKFLOW_LOADED message should be sent after properties"
      );
    });

    test("should send WORKFLOW_PROPERTIES_UPDATE with undefined optional fields for a minimal working file", async () => {
      const workingFile = {
        workflowName: "minimal-workflow",
        startedAt: Date.now(),
        lastModifiedAt: Date.now(),
        steps: [{ prompt: "step one" }],
        _runtime: { currentIndex: 0, executionState: "idle" },
      };

      const filePath = tempFile("minimal");
      await fs.writeFile(filePath, JSON.stringify(workingFile), "utf-8");

      const messages: any[] = [];
      const postMessage = (msg: any) => messages.push(msg);
      const sync = new WebviewSettingsSync(postMessage, () =>
        makeOrchestrator(filePath)
      );

      await sync.sendWorkflowPropertiesToSettings(postMessage, "panel");

      const propsMsg = messages.find(
        (m) => m.type === MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE
      );
      assert.ok(
        propsMsg,
        "WORKFLOW_PROPERTIES_UPDATE should be sent even for a minimal working file"
      );

      const props = propsMsg.workflowProperties;
      assert.strictEqual(
        props.harness,
        undefined,
        "harness should be undefined when not set in working file"
      );
      assert.strictEqual(
        props.model,
        undefined,
        "model should be undefined when not set in working file"
      );
      assert.strictEqual(
        props.endCondition,
        undefined,
        "endCondition should be undefined when not set in working file"
      );
      assert.strictEqual(
        props.errorBehavior,
        undefined,
        "errorBehavior should be undefined when not set in working file"
      );
    });

    /**
     * Regression: `loadRunViewForClient` moves a client's view address without
     * rebinding its executor, so the bound instance still points at the workflow
     * the user just left. Reading the instance's file here republished the
     * previous workflow's properties over the ones the panel had just received.
     */
    test("should read the client's viewed definition, not its bound instance's working file", async () => {
      const viewedPath = tempFile("viewed");
      const instancePath = tempFile("bound-instance");
      await fs.writeFile(
        viewedPath,
        JSON.stringify({ harness: "codex-cli", model: "gpt-5.5" }),
        "utf-8"
      );
      await fs.writeFile(
        instancePath,
        JSON.stringify({ harness: "claude-cli", model: "claude-opus-4" }),
        "utf-8"
      );

      const messages: any[] = [];
      const postMessage = (msg: any) => messages.push(msg);
      const sync = new WebviewSettingsSync(postMessage, () =>
        makeOrchestrator(instancePath, viewedPath)
      );

      await sync.sendWorkflowPropertiesToSettings(postMessage, "panel");

      const props = messages.find(
        (m) => m.type === MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE
      )?.workflowProperties;
      assert.strictEqual(props.harness, "codex-cli");
      assert.strictEqual(props.model, "gpt-5.5");
    });

    test("should fall back to the bound instance when the addressed file is gone", async () => {
      const instancePath = tempFile("fallback-instance");
      await fs.writeFile(
        instancePath,
        JSON.stringify({ harness: "claude-cli" }),
        "utf-8"
      );

      const messages: any[] = [];
      const postMessage = (msg: any) => messages.push(msg);
      // A promoted draft's file is deleted; the address can name it briefly.
      const sync = new WebviewSettingsSync(postMessage, () =>
        makeOrchestrator(instancePath, tempFile("deleted-draft"))
      );

      await sync.sendWorkflowPropertiesToSettings(postMessage, "panel");

      const props = messages.find(
        (m) => m.type === MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE
      )?.workflowProperties;
      assert.strictEqual(props.harness, "claude-cli");
    });

    test("should send no messages when orchestrator has no working file path", async () => {
      const messages: any[] = [];
      const postMessage = (msg: any) => messages.push(msg);
      const sync = new WebviewSettingsSync(postMessage, () =>
        makeOrchestrator(undefined)
      );

      await sync.sendWorkflowPropertiesToSettings(postMessage, "panel");

      assert.strictEqual(
        messages.length,
        0,
        "No messages should be sent when working file path is missing"
      );
    });

    test("should send no messages when orchestrator is unavailable", async () => {
      const messages: any[] = [];
      const postMessage = (msg: any) => messages.push(msg);
      const sync = new WebviewSettingsSync(postMessage, () => undefined);

      await sync.sendWorkflowPropertiesToSettings(postMessage, "panel");

      assert.strictEqual(
        messages.length,
        0,
        "No messages should be sent when orchestrator is undefined"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Regression: LOAD_WORKFLOW must repopulate WorkflowPropertiesPanel
  //
  // RUN_VIEW_LOADED (emitted by loadRunViewForClient) triggers applyWorkflowChange()
  // in the webview which calls clearWorkflowProperties().  Without a follow-up
  // sendWorkflowPropertiesToSettings() call the properties panel stays blank after
  // switching to an existing workflow via the recent workflows dropdown.
  // ────────────────────────────────────────────────────────────────────────────
  suite("WebviewMessageRouter — LOAD_WORKFLOW handler", () => {
    test("should call sendWorkflowPropertiesToSettings after loading an existing workflow", async () => {
      let sendPropsCalled = false;

      const mockSettingsSync = {
        sendWorkflowPropertiesToSettings: async (
          _postMessage: any,
          _clientId: string
        ) => {
          sendPropsCalled = true;
        },
      } as any;

      const mockOrchestrator = {
        loadRunViewForClient: async () => {
          /* no-op */
        },
      } as any;

      const router = new WebviewMessageRouter(
        () => {},
        mockSettingsSync,
        {} as any,
        () => mockOrchestrator,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({
        type: MESSAGE_TYPES.LOAD_WORKFLOW,
        address: {
          workflowKey: "my-workflow" as never,
          kind: "run",
          runRef: "run-2026-01-01T00-00-00-000Z" as never,
        },
      });

      assert.ok(
        sendPropsCalled,
        "sendWorkflowPropertiesToSettings must be called after LOAD_WORKFLOW so WorkflowPropertiesPanel is populated with the loaded workflow's saved properties"
      );
    });

    // Regression: LOAD_WORKFLOW also arrives carrying a source `filePath` — the
    // standalone "Load from File" picker and the workspace-editor context menu
    // both send that shape. An address-only handler dropped them on the floor,
    // so loading a workflow from file did nothing at all (and logged nothing).
    test("should load a source file when the message carries filePath instead of address", async () => {
      const loadedPaths: string[] = [];
      let sendPropsCalled = false;

      const mockSettingsSync = {
        sendWorkflowPropertiesToSettings: async () => {
          sendPropsCalled = true;
        },
      } as any;

      const mockOrchestrator = {
        loadRunViewForClient: async () => {
          assert.fail(
            "a filePath-only LOAD_WORKFLOW must not be routed as a run address"
          );
        },
        loadPromptFileForClient: async (filePath: string) => {
          loadedPaths.push(filePath);
        },
      } as any;

      const router = new WebviewMessageRouter(
        () => {},
        mockSettingsSync,
        {} as any,
        () => mockOrchestrator,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({
        type: MESSAGE_TYPES.LOAD_WORKFLOW,
        filePath: "flows/example.ctrlyoke.yaml",
      });

      assert.strictEqual(
        loadedPaths.length,
        1,
        "LOAD_WORKFLOW with a filePath must load that source file for the requesting client"
      );
      assert.ok(
        loadedPaths[0]
          .replace(/\\/g, "/")
          .endsWith("flows/example.ctrlyoke.yaml"),
        `expected the requested file to be loaded, got "${loadedPaths[0]}"`
      );
      assert.ok(
        sendPropsCalled,
        "the loaded file's properties must be synced to the PropertiesPanel"
      );
    });

    test("should NOT call sendWorkflowPropertiesToSettings when orchestrator is unavailable (falls back to serializer)", async () => {
      let sendPropsCalled = false;

      const mockSettingsSync = {
        sendWorkflowPropertiesToSettings: async () => {
          sendPropsCalled = true;
        },
      } as any;

      const mockSerializer = {
        handleLoadWorkflow: (_message: any) => {
          /* no-op */
        },
      } as any;

      const router = new WebviewMessageRouter(
        () => {},
        mockSettingsSync,
        mockSerializer,
        () => undefined, // no orchestrator
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({
        type: MESSAGE_TYPES.LOAD_WORKFLOW,
        address: {
          workflowKey: "my-workflow" as never,
          kind: "run",
          runRef: "run-2026-01-01T00-00-00-000Z" as never,
        },
      });

      assert.strictEqual(
        sendPropsCalled,
        false,
        "sendWorkflowPropertiesToSettings should not be called when falling back to the serializer (no orchestrator)"
      );
    });
  });

  suite("WebviewMessageRouter — READY handler", () => {
    test("tells sendInitialState which client the INIT is for", async () => {
      const initClientIds: string[] = [];

      const mockSettingsSync = {
        sendInitialState: async (_postMessage: any, clientId: string) => {
          initClientIds.push(clientId);
        },
      } as any;

      const router = new WebviewMessageRouter(
        () => {},
        mockSettingsSync,
        {} as any,
        () => undefined,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route(
        { type: MESSAGE_TYPES.READY },
        { postMessage: () => {}, clientTag: "browser:1" }
      );
      await router.route({ type: MESSAGE_TYPES.READY });

      assert.deepStrictEqual(
        initClientIds,
        ["browser:1", PANEL_CLIENT_ID],
        "INIT's workflow payload is client-scoped, so READY must forward the sending client's id"
      );
    });

    test("ignores duplicate panel READY messages for the same webview", async () => {
      let panelReady = false;
      let initialStateSendCount = 0;

      const mockSettingsSync = {
        sendInitialState: async () => {
          initialStateSendCount++;
        },
      } as any;

      const router = new WebviewMessageRouter(
        () => {},
        mockSettingsSync,
        {} as any,
        () => undefined,
        {} as any,
        {
          handleClearWorkflow: async () => {},
          updateWorkflowName: () => {},
          onPanelReady: () => {
            if (panelReady) return false;
            panelReady = true;
            return true;
          },
        }
      );

      await router.route({ type: MESSAGE_TYPES.READY });
      await router.route({ type: MESSAGE_TYPES.READY });

      assert.strictEqual(
        initialStateSendCount,
        1,
        "duplicate READY must not restart initial state and workflow replay"
      );
    });
  });

  suite("WebviewMessageRouter — CREATE_WORKFLOW handler", () => {
    test("should sync seeded properties after creating a workflow from a template", async () => {
      let sendPropsCalled = false;

      const mockSettingsSync = {
        sendWorkflowPropertiesToSettings: async (
          _postMessage: any,
          _clientId: string
        ) => {
          sendPropsCalled = true;
        },
      } as any;

      const mockSerializer = {
        handleCreateWorkflow: async () => true,
      } as any;

      const router = new WebviewMessageRouter(
        () => {},
        mockSettingsSync,
        mockSerializer,
        () => undefined,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({ type: MESSAGE_TYPES.CREATE_WORKFLOW });

      assert.ok(
        sendPropsCalled,
        "sendWorkflowPropertiesToSettings must be called after CREATE_WORKFLOW so WorkflowPropertiesPanel receives the new workflow's seeded defaults"
      );
    });

    test("should not sync properties when workflow creation fails", async () => {
      let sendPropsCalled = false;

      const mockSettingsSync = {
        sendWorkflowPropertiesToSettings: async () => {
          sendPropsCalled = true;
        },
      } as any;

      const mockSerializer = {
        handleCreateWorkflow: async () => false,
      } as any;

      const router = new WebviewMessageRouter(
        () => {},
        mockSettingsSync,
        mockSerializer,
        () => undefined,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({ type: MESSAGE_TYPES.CREATE_WORKFLOW });

      assert.strictEqual(sendPropsCalled, false);
    });
  });

  suite("WebviewMessageRouter — THEME_VARS_CAPTURED handler", () => {
    function makeRouter() {
      return new WebviewMessageRouter(
        () => {},
        {} as any,
        {} as any,
        () => undefined,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );
    }

    test("applies theme vars sent by the trusted in-panel client", async () => {
      const router = makeRouter();
      let received: Record<string, string> | undefined;
      router.setThemeVarsCapturedCallback((vars) => {
        received = vars;
      });

      await router.route(
        { type: MESSAGE_TYPES.THEME_VARS_CAPTURED, vars: { "--x": "#fff" } },
        { clientTag: PANEL_CLIENT_ID }
      );

      assert.deepStrictEqual(received, { "--x": "#fff" });
    });

    test("ignores theme vars sent by a non-panel (external browser) client", async () => {
      const router = makeRouter();
      let calls = 0;
      router.setThemeVarsCapturedCallback(() => {
        calls++;
      });

      await router.route(
        { type: MESSAGE_TYPES.THEME_VARS_CAPTURED, vars: { "--x": "#fff" } },
        { clientTag: "some-external-dashboard-client" }
      );

      assert.strictEqual(
        calls,
        0,
        "THEME_VARS_CAPTURED from a non-panel client must not update the shared, HTML-embedded theme snapshot"
      );
    });
  });

  suite("WebviewMessageRouter — GENERATE_SERVER_CERT handler", () => {
    test("should forward the active scope to WebviewSettingsSync", async () => {
      let receivedScope: SettingWriteScope | undefined;

      const mockSettingsSync = {
        handleGenerateServerCert: async (
          _postMessage: any,
          scope: SettingWriteScope
        ) => {
          receivedScope = scope;
        },
      } as any;

      const router = new WebviewMessageRouter(
        () => {},
        mockSettingsSync,
        {} as any,
        () => undefined,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({
        type: MESSAGE_TYPES.GENERATE_SERVER_CERT,
        scope: "workspace",
      });

      assert.strictEqual(
        receivedScope,
        "workspace",
        "GENERATE_SERVER_CERT should preserve the active settings scope"
      );
    });
  });

  suite("WebviewMessageRouter — DOWNLOAD_SERVER_CERT handler", () => {
    test("should forward the requesting client's postMessage to WebviewSettingsSync", async () => {
      let received: any;
      const sentinelPostMessage = () => {};

      const mockSettingsSync = {
        handleDownloadServerCert: async (postMessage: any) => {
          received = postMessage;
        },
      } as any;

      const router = new WebviewMessageRouter(
        () => {},
        mockSettingsSync,
        {} as any,
        () => undefined,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route(
        { type: MESSAGE_TYPES.DOWNLOAD_SERVER_CERT },
        { postMessage: sentinelPostMessage }
      );

      assert.strictEqual(
        received,
        sentinelPostMessage,
        "DOWNLOAD_SERVER_CERT should forward the requesting client's postMessage so the reply routes back to it"
      );
    });
  });

  // ─── handleSetAsDefault ─────────────────────────────────────────────────────

  suite("handleSetAsDefault", () => {
    const defaultsPropertyCoverage = new Set([
      "harness",
      "models.*",
      "additionalArgs.*",
      "agent",
      "skills",
      "secrets",
      "executionMode",
      "resumeSession",
      "priorContext",
      "mcpServers",
      "hooks",
      "errorBehavior",
      "toolPermissions",
      "endCondition",
      "preCondition",
      "worktree",
    ]);

    async function captureSetAsDefaultWrite(
      property: string,
      value: unknown,
      harness?: string
    ): Promise<Array<{ key: string; value: unknown; scope: string }>> {
      const originalSet = configService.set.bind(configService);
      const setCalls: Array<{ key: string; value: unknown; scope: string }> =
        [];

      try {
        configService.set = (async (key, value, scope) => {
          setCalls.push({ key, value, scope });
        }) as typeof configService.set;

        const sync = new WebviewSettingsSync(
          () => {},
          () => undefined
        );
        await sync.handleSetAsDefault(property, value, harness);
      } finally {
        configService.set = originalSet;
      }

      return setCalls;
    }

    test("should keep test coverage in sync with defaults from settings-schema", async () => {
      const schemaPath = path.resolve(
        __dirname,
        "../../../schemas/settings-schema.json"
      );
      const schema = JSON.parse(await fs.readFile(schemaPath, "utf8")) as {
        properties?: {
          defaults?: {
            properties?: Record<string, unknown>;
          };
        };
      };

      const defaultsProperties = Object.keys(
        schema.properties?.defaults?.properties ?? {}
      );
      const normalizedSchemaCoverage = new Set(
        defaultsProperties.map((property) => {
          if (property === "models") return "models.*";
          if (property === "additionalArgs") return "additionalArgs.*";
          return property;
        })
      );

      assert.deepStrictEqual(
        [...normalizedSchemaCoverage].sort(),
        [...defaultsPropertyCoverage].sort(),
        "Add or update handleSetAsDefault tests when defaults.* changes in settings-schema.json"
      );
    });

    test("should write the expected config path for each schema-backed workflow default", async () => {
      const endCondition = {
        script: "npm test",
        returns: "true",
      };
      const preCondition = {
        script: "npm run lint",
        returns: "0",
      };
      const hook = { event: "postToolUse", command: "echo done" };
      const errorBehavior = {
        onError: "retry",
        maxRetries: 2,
        retryDelayMs: 1500,
      };

      const cases: Array<{
        property: string;
        value: unknown;
        harness?: string;
        expectedKey: string;
        expectedValue: unknown;
      }> = [
        {
          property: PROMPT_PROPERTIES.HARNESS,
          value: HARNESS_IDS.CODEX_CLI,
          expectedKey: CONFIG_KEYS.DEFAULTS_HARNESS,
          expectedValue: HARNESS_IDS.CODEX_CLI,
        },
        {
          property: PROMPT_PROPERTIES.MODEL,
          value: "gpt-5.5",
          harness: HARNESS_IDS.CODEX_CLI,
          expectedKey: `${CONFIG_KEYS.DEFAULTS_MODELS}.${HARNESS_IDS.CODEX_CLI}`,
          expectedValue: "gpt-5.5",
        },
        {
          property: PROMPT_PROPERTIES.ADDITIONAL_ARGS,
          value: "--effort high",
          harness: HARNESS_IDS.CODEX_CLI,
          expectedKey: `${CONFIG_KEYS.DEFAULTS_ADDITIONAL_ARGS}.${HARNESS_IDS.CODEX_CLI}`,
          expectedValue: "--effort high",
        },
        {
          property: PROMPT_PROPERTIES.AGENT,
          value: "default.agent.md",
          expectedKey: CONFIG_KEYS.DEFAULTS_AGENT,
          expectedValue: "default.agent.md",
        },
        {
          property: PROMPT_PROPERTIES.SKILLS,
          value: ["refactor", "test"],
          expectedKey: CONFIG_KEYS.DEFAULTS_SKILLS,
          expectedValue: ["refactor", "test"],
        },
        {
          property: PROMPT_PROPERTIES.SECRETS,
          value: ["API_TOKEN", "DATABASE_PASSWORD"],
          expectedKey: CONFIG_KEYS.DEFAULTS_SECRETS,
          expectedValue: ["API_TOKEN", "DATABASE_PASSWORD"],
        },
        {
          property: PROMPT_PROPERTIES.EXECUTION_MODE,
          value: "headless",
          expectedKey: CONFIG_KEYS.EXECUTION_MODE,
          expectedValue: "headless",
        },
        {
          property: PROMPT_PROPERTIES.RESUME_SESSION,
          value: true,
          expectedKey: CONFIG_KEYS.DEFAULTS_RESUME_SESSION,
          expectedValue: true,
        },
        {
          property: PROMPT_PROPERTIES.PRIOR_CONTEXT,
          value: "last",
          expectedKey: CONFIG_KEYS.DEFAULTS_PRIOR_CONTEXT,
          expectedValue: "last",
        },
        {
          property: PROMPT_PROPERTIES.MCP_SERVERS,
          value: ["ctrlyoke"],
          expectedKey: CONFIG_KEYS.DEFAULTS_MCP_SERVERS,
          expectedValue: ["ctrlyoke"],
        },
        {
          property: PROMPT_PROPERTIES.HOOKS,
          value: [hook],
          expectedKey: CONFIG_KEYS.DEFAULTS_HOOKS,
          expectedValue: [hook],
        },
        {
          property: PROMPT_PROPERTIES.ERROR_BEHAVIOR,
          value: errorBehavior,
          expectedKey: CONFIG_KEYS.DEFAULTS_ERROR_BEHAVIOR,
          expectedValue: errorBehavior,
        },
        {
          property: PROMPT_PROPERTIES.TOOL_PERMISSIONS,
          value: {
            mode: PERMISSION_MODES.CUSTOM,
            allowedTools: ["read", "write"],
            deniedTools: ["bash"],
          },
          expectedKey: CONFIG_KEYS.DEFAULTS_TOOL_PERMISSIONS,
          expectedValue: {
            mode: PERMISSION_MODES.CUSTOM,
            allowedTools: ["read", "write"],
            deniedTools: ["bash"],
          },
        },
        {
          property: PROMPT_PROPERTIES.END_CONDITION,
          value: endCondition,
          expectedKey: CONFIG_KEYS.DEFAULTS_END_CONDITION,
          expectedValue: endCondition,
        },
        {
          property: PROMPT_PROPERTIES.PRE_CONDITION,
          value: preCondition,
          expectedKey: CONFIG_KEYS.DEFAULTS_PRE_CONDITION,
          expectedValue: preCondition,
        },
        {
          property: PROMPT_PROPERTIES.WORKTREE,
          value: "feature/default",
          expectedKey: CONFIG_KEYS.DEFAULTS_WORKTREE,
          expectedValue: { mode: "named", branch: "feature/default" },
        },
      ];

      for (const testCase of cases) {
        const setCalls = await captureSetAsDefaultWrite(
          testCase.property,
          testCase.value,
          testCase.harness
        );

        assert.strictEqual(
          setCalls.length,
          1,
          `expected exactly one config write for ${testCase.property}`
        );
        assert.strictEqual(
          setCalls[0].key,
          testCase.expectedKey,
          `unexpected config key for ${testCase.property}`
        );
        assert.deepStrictEqual(
          setCalls[0].value,
          testCase.expectedValue,
          `unexpected config value for ${testCase.property}`
        );
        assert.strictEqual(
          setCalls[0].scope,
          "user",
          `unexpected config scope for ${testCase.property}`
        );
      }
    });

    suite("toolPermissions", () => {
      test("should write defaults.toolPermissions atomically as one config set call", async () => {
        const setCalls = await captureSetAsDefaultWrite(
          PROMPT_PROPERTIES.TOOL_PERMISSIONS,
          {
            mode: PERMISSION_MODES.CUSTOM,
            allowedTools: ["read", "write"],
            deniedTools: ["bash"],
          }
        );

        assert.strictEqual(
          setCalls.length,
          1,
          "exactly one config write should be made"
        );
        assert.strictEqual(
          setCalls[0].key,
          CONFIG_KEYS.DEFAULTS_TOOL_PERMISSIONS
        );
        assert.deepStrictEqual(setCalls[0].value, {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["read", "write"],
          deniedTools: ["bash"],
        });
      });

      test("should fall back to allowAll mode when mode is NONE or absent", async () => {
        const setCalls = await captureSetAsDefaultWrite(
          PROMPT_PROPERTIES.TOOL_PERMISSIONS,
          {
            mode: "none",
            allowedTools: [],
            deniedTools: [],
          }
        );

        assert.strictEqual(setCalls.length, 1);
        assert.strictEqual(
          (setCalls[0].value as { mode: string }).mode,
          PERMISSION_MODES.ALLOW_ALL
        );
      });

      test("should write allowAll mode and empty arrays when value is null", async () => {
        const setCalls = await captureSetAsDefaultWrite(
          PROMPT_PROPERTIES.TOOL_PERMISSIONS,
          null
        );

        assert.strictEqual(setCalls.length, 1);
        assert.deepStrictEqual(setCalls[0].value, {
          mode: PERMISSION_MODES.ALLOW_ALL,
          allowedTools: [],
          deniedTools: [],
        });
      });
    });
  });
});

suite("WebviewMessageRouter stable run actions", () => {
  const runAddress = {
    workflowKey: "workflow-a" as never,
    kind: "run" as const,
    runRef: "run-2026-07-20T10-30-00-000Z" as never,
  };

  function makeRouter(calls: string[], initialized: boolean = true) {
    const orchestrator = {
      isInitialized: () => initialized,
      publishViewIdentityToViewers: async () => undefined,
      executeDraftAtAddress: async () => calls.push("draft"),
      seedAndExecuteAtRun: async () => {
        calls.push("seed");
        return { runRef: "run-2026-07-20T11-00-00-000Z" as never };
      },
      startNewRunInsteadAtRun: async () => {
        calls.push("start-instead");
        return { runRef: "run-2026-07-20T11-00-00-000Z" as never };
      },
      continueAtRun: async () => calls.push("continue"),
      appendAndContinueAtRun: async () => calls.push("append"),
      pauseAtRun: async () => calls.push("pause"),
      cancelPauseAtRun: async () => calls.push("cancel-pause"),
      resumeAtRun: async () => calls.push("resume"),
      stopAtRun: async () => calls.push("stop"),
    } as any;
    return new WebviewMessageRouter(
      () => {},
      {} as any,
      {} as any,
      () => orchestrator,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );
  }

  test("routes every stable-address run action without an instance-id alias", async () => {
    const calls: string[] = [];
    const router = makeRouter(calls);
    const revision = {
      address: runAddress,
      expectedDefinitionRevision: 2,
      expectedDescriptorRevision: 5,
    };

    await router.route({
      type: MESSAGE_TYPES.EXECUTE_DRAFT,
      ...revision,
      address: { workflowKey: runAddress.workflowKey, kind: "draft" },
    });
    await router.route({ type: MESSAGE_TYPES.SEED_NEW_RUN, ...revision });
    await router.route({
      type: MESSAGE_TYPES.START_NEW_RUN_INSTEAD,
      ...revision,
    });
    await router.route({ type: MESSAGE_TYPES.CONTINUE_RUN, ...revision });
    await router.route({
      type: MESSAGE_TYPES.APPEND_AND_CONTINUE_RUN,
      ...revision,
      tail: [{ prompt: "tail" }],
    });
    await router.route({ type: MESSAGE_TYPES.PAUSE_RUN, address: runAddress });
    await router.route({
      type: MESSAGE_TYPES.CANCEL_PAUSE_RUN,
      address: runAddress,
    });
    await router.route({ type: MESSAGE_TYPES.RESUME_RUN, address: runAddress });
    await router.route({ type: MESSAGE_TYPES.STOP_RUN, address: runAddress });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(calls, [
      "draft",
      "seed",
      "start-instead",
      "continue",
      "append",
      "pause",
      "cancel-pause",
      "resume",
      "stop",
    ]);
  });

  test("refuses run-starting actions until the orchestrator finished initializing", async () => {
    const calls: string[] = [];
    const router = makeRouter(calls, false);
    const revision = {
      address: runAddress,
      expectedDefinitionRevision: 2,
      expectedDescriptorRevision: 5,
    };

    await router.route({
      type: MESSAGE_TYPES.EXECUTE_DRAFT,
      ...revision,
      address: { workflowKey: runAddress.workflowKey, kind: "draft" },
    });
    await router.route({ type: MESSAGE_TYPES.SEED_NEW_RUN, ...revision });
    await router.route({
      type: MESSAGE_TYPES.START_NEW_RUN_INSTEAD,
      ...revision,
    });
    await router.route({ type: MESSAGE_TYPES.CONTINUE_RUN, ...revision });
    await router.route({
      type: MESSAGE_TYPES.APPEND_AND_CONTINUE_RUN,
      ...revision,
      tail: [{ prompt: "tail" }],
    });
    await router.route({ type: MESSAGE_TYPES.RESUME_RUN, address: runAddress });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(
      calls,
      [],
      "no run may start while the extension is still starting up"
    );
  });

  test("still honors pause, cancel-pause and stop during startup", async () => {
    const calls: string[] = [];
    const router = makeRouter(calls, false);

    await router.route({ type: MESSAGE_TYPES.PAUSE_RUN, address: runAddress });
    await router.route({
      type: MESSAGE_TYPES.CANCEL_PAUSE_RUN,
      address: runAddress,
    });
    await router.route({ type: MESSAGE_TYPES.STOP_RUN, address: runAddress });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(calls, ["pause", "cancel-pause", "stop"]);
  });

  test("a rejected discard or set-start-position republishes the authoritative revisions", async () => {
    const emitted: any[] = [];
    const identityClients: string[] = [];
    const orchestrator = {
      discardContinuationAtRun: async () => {
        throw new Error("Descriptor revision conflict: expected 5, found 6");
      },
      setStartPositionAtRun: async () => {
        throw new Error("Descriptor revision conflict: expected 5, found 6");
      },
      publishViewIdentityToViewers: async (clientId: string) => {
        identityClients.push(clientId);
        return {
          type: MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY,
          address: runAddress,
          definitionRevision: 3,
          descriptorRevision: 6,
        };
      },
    } as any;
    const router = new WebviewMessageRouter(
      (message: unknown) => emitted.push(message),
      {} as any,
      {} as any,
      () => orchestrator,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );

    await router.route({
      type: MESSAGE_TYPES.DISCARD_CONTINUATION,
      address: runAddress,
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 5,
      confirmEditedSuffix: false,
    });
    await router.route({
      type: MESSAGE_TYPES.SET_START_POSITION,
      address: runAddress,
      toIndex: 1,
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 5,
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Without the republish, the stale client revision made every following
    // click fail identically — the header read as a dead button.
    assert.strictEqual(identityClients.length, 2);
    const failures = emitted.filter(
      (message) => message.type === MESSAGE_TYPES.WORKFLOW_ACTION_FAILED
    );
    assert.deepStrictEqual(
      failures.map((message) => message.action),
      ["discard continuation", "set start position"]
    );
    const identities = emitted.filter(
      (message) => message.type === MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY
    );
    assert.strictEqual(identities.length, 2);
    assert.strictEqual(identities[0].descriptorRevision, 6);
  });

  test("discard continuation with unsaved suffix edits asks the webview to confirm instead of a native dialog", async () => {
    const emitted: any[] = [];
    const orchestrator = {
      discardContinuationAtRun: async () => ({
        discarded: false,
        hasSuffixEdits: true,
      }),
    } as any;
    const router = new WebviewMessageRouter(
      (message: unknown) => emitted.push(message),
      {} as any,
      {} as any,
      () => orchestrator,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );

    await router.route({
      type: MESSAGE_TYPES.DISCARD_CONTINUATION,
      address: runAddress,
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 5,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(
      emitted.filter(
        (message) =>
          message.type === MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED
      ),
      [
        {
          type: MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED,
          action: "discardContinuation",
          address: runAddress,
          expectedDefinitionRevision: 3,
          expectedDescriptorRevision: 5,
        },
      ]
    );
  });

  test("start new run instead with unsaved suffix edits asks the webview to confirm instead of a native dialog", async () => {
    const emitted: any[] = [];
    const orchestrator = {
      isInitialized: () => true,
      startNewRunInsteadAtRun: async () => ({ hasSuffixEdits: true }),
    } as any;
    const router = new WebviewMessageRouter(
      (message: unknown) => emitted.push(message),
      {} as any,
      {} as any,
      () => orchestrator,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );

    await router.route({
      type: MESSAGE_TYPES.START_NEW_RUN_INSTEAD,
      address: runAddress,
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 5,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(
      emitted.filter(
        (message) =>
          message.type === MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED
      ),
      [
        {
          type: MESSAGE_TYPES.SUFFIX_EDIT_CONFIRMATION_REQUIRED,
          action: "startNewRunInstead",
          address: runAddress,
          expectedDefinitionRevision: 3,
          expectedDescriptorRevision: 5,
        },
      ]
    );
  });
});

suite("WebviewMessageRouter APPEND_FILE routing", () => {
  const runAddress = {
    workflowKey: "workflow-a" as never,
    kind: "run" as const,
    runRef: "run-2026-07-20T10-30-00-000Z" as never,
  };

  // Fully-qualified so the router's workspace-relative resolution is the
  // identity here — these tests are about mutation routing, and path resolution
  // has its own coverage in WebviewMessageRouter.test.ts.
  const absoluteDir = path.sep === "\\" ? "C:\\fake" : "/fake";

  function makeRouter(calls: Array<{ mutation: unknown; filePath: unknown }>) {
    const orchestrator = {
      appendFromFileForClient: async (mutation: unknown, filePath: unknown) => {
        calls.push({ mutation, filePath });
      },
    } as any;
    return new WebviewMessageRouter(
      () => {},
      {} as any,
      {} as any,
      () => orchestrator,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );
  }

  test("passes a run-kind mutation through to appendFromFileForClient", async () => {
    const calls: Array<{ mutation: unknown; filePath: unknown }> = [];
    const router = makeRouter(calls);
    const mutation = {
      address: runAddress,
      expectedDefinitionRevision: 2,
      expectedDescriptorRevision: 5,
    };

    const filePath = path.join(absoluteDir, "prompts.ctrlyoke.yaml");
    await router.route({
      type: MESSAGE_TYPES.APPEND_FILE,
      filePath,
      mutation,
    });

    assert.deepStrictEqual(calls, [{ mutation, filePath }]);
  });

  test("passes no mutation through when the client has no addressed context", async () => {
    const calls: Array<{ mutation: unknown; filePath: unknown }> = [];
    const router = makeRouter(calls);

    const filePath = path.join(absoluteDir, "legacy.ctrlyoke.yaml");
    await router.route({
      type: MESSAGE_TYPES.APPEND_FILE,
      filePath,
    });

    assert.deepStrictEqual(calls, [{ mutation: undefined, filePath }]);
  });
});

/**
 * A dispatch entry that is deliberately fire-and-forget (so long-running
 * execution cannot deadlock the shared route queue) keeps running after
 * `route()` has already returned. While the router held the sending client's
 * scope in mutable fields and restored them in a `finally`, every scope read
 * that happened after an `await` inside such a handler saw the *next* (usually
 * panel) client. The failure reply and the republished revisions were then
 * posted to the panel, leaving the client that actually failed wedged on a
 * superseded `definitionRevision` — the exact wedge `reportActionFailure`
 * exists to prevent.
 */
suite("WebviewMessageRouter client scoping", () => {
  const draftAddress = {
    workflowKey: "workflow-a" as never,
    kind: "draft" as const,
  };

  test("a detached handler's failure reply reaches the originating client, not the panel", async () => {
    const panelMessages: any[] = [];
    const browserMessages: any[] = [];
    const identityClientIds: string[] = [];

    let signalDone: () => void = () => {};
    const identityPublished = new Promise<void>((resolve) => {
      signalDone = resolve;
    });

    const orchestrator = {
      isInitialized: () => true,
      executeDraftAtAddress: async () => {
        // Suspend once so `route()` has already resolved before this handler
        // resumes — precisely the window the restore used to fire in.
        await Promise.resolve();
        throw new Error("superseded definitionRevision");
      },
      publishViewIdentityToViewers: async (clientId: string) => {
        identityClientIds.push(clientId);
        signalDone();
        return { type: MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY, clientId };
      },
    } as any;

    const router = new WebviewMessageRouter(
      (message: unknown) => panelMessages.push(message),
      {} as any,
      {} as any,
      () => orchestrator,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );

    const originalShowError = vscode.window.showErrorMessage;
    (vscode.window as any).showErrorMessage = () => Promise.resolve(undefined);
    try {
      await router.route(
        {
          type: MESSAGE_TYPES.EXECUTE_DRAFT,
          address: draftAddress,
          expectedDefinitionRevision: 2,
          expectedDescriptorRevision: 5,
        },
        {
          postMessage: (message: unknown) => browserMessages.push(message),
          clientTag: "browser:1",
        }
      );
      await identityPublished;
    } finally {
      (vscode.window as any).showErrorMessage = originalShowError;
    }

    assert.deepStrictEqual(
      identityClientIds,
      ["browser:1"],
      "revisions must be republished for the client that failed"
    );
    assert.ok(
      browserMessages.some(
        (m) => m.type === MESSAGE_TYPES.WORKFLOW_ACTION_FAILED
      ),
      "the failing client must be told its action failed"
    );
    assert.deepStrictEqual(
      panelMessages,
      [],
      "nothing may leak to the panel transport"
    );
  });
});
