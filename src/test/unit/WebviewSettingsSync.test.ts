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
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
import { CONFIG_KEYS } from "../../utils/ConfigurationUtils";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOrchestrator(workingFilePath: string | undefined) {
  return {
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
  // FILE_SELECTED (emitted by loadWorkflowForClient) triggers applyWorkflowChange()
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
        loadWorkflowForClient: async () => {
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
        filePath: "/workspace/.ctrlyoke/.working/my-workflow.ctrlyoke.json",
      });

      assert.ok(
        sendPropsCalled,
        "sendWorkflowPropertiesToSettings must be called after LOAD_WORKFLOW so WorkflowPropertiesPanel is populated with the loaded workflow's saved properties"
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
        filePath: "/workspace/.ctrlyoke/.working/my-workflow.ctrlyoke.json",
      });

      assert.strictEqual(
        sendPropsCalled,
        false,
        "sendWorkflowPropertiesToSettings should not be called when falling back to the serializer (no orchestrator)"
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

  // ─── handleSetAsDefault ─────────────────────────────────────────────────────

  suite("handleSetAsDefault", () => {
    const defaultsPropertyCoverage = new Set([
      "harness",
      "models.*",
      "additionalArgs.*",
      "agent",
      "skills",
      "resumeSession",
      "priorContext",
      "mcpServers",
      "hooks",
      "errorBehavior",
      "toolPermissions",
      "endCondition",
      "preCondition",
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
