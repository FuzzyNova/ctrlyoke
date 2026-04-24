import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { WebviewSettingsSync } from "../../ui/WebviewSettingsSync";
import { WebviewMessageRouter } from "../../ui/WebviewMessageRouter";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";
import { configService } from "../../config/FlightPathConfigService";
import { FLIGHTPATH_SETTINGS_DEFAULTS } from "../../types/FlightPathSettings";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOrchestrator(workingFilePath: string | undefined) {
  return {
    getQueueState: (_clientId: string) => ({ workingFilePath }),
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

suite("WebviewSettingsSync", () => {
  const tempPaths: string[] = [];

  function tempFile(name?: string): string {
    const p = path.join(
      os.tmpdir(),
      `fp-wss-${name ?? Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    tempPaths.push(p);
    return p;
  }

  afterEach(async () => {
    for (const p of tempPaths.splice(0)) {
      try {
        await fs.unlink(p);
      } catch {
        // best-effort cleanup
      }
    }
  });

  suite("handleGlobalSettingsLoadRequest", () => {
    test("should include notifications settings and leaf-level source metadata", async () => {
      const originalGetAll = configService.getAll.bind(configService);
      const originalGetLeafSources = configService.getLeafSources.bind(configService);

      try {
        configService.getAll = (() => ({
          ...FLIGHTPATH_SETTINGS_DEFAULTS,
          notifications: {
            ...FLIGHTPATH_SETTINGS_DEFAULTS.notifications,
            browser: {
              ...FLIGHTPATH_SETTINGS_DEFAULTS.notifications.browser,
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
        mcpServers: ["flightpath"],
        hooks: [{ type: "postToolUse", command: "echo done" }],
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
        ["flightpath"],
        "mcpServers should be loaded from working file"
      );
      assert.deepStrictEqual(
        props.hooks,
        [{ type: "postToolUse", command: "echo done" }],
        "hooks should be loaded from working file"
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
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({
        type: MESSAGE_TYPES.LOAD_WORKFLOW,
        filePath: "/workspace/.flightpath/.queue/my-workflow.flightpath.json",
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
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({
        type: MESSAGE_TYPES.LOAD_WORKFLOW,
        filePath: "/workspace/.flightpath/.queue/my-workflow.flightpath.json",
      });

      assert.strictEqual(
        sendPropsCalled,
        false,
        "sendWorkflowPropertiesToSettings should not be called when falling back to the serializer (no orchestrator)"
      );
    });
  });
});
