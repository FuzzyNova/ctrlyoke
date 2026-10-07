import { suite, test, setup, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket, type RawData } from "ws";
import {
  createNodeHostedServer,
  type NodeHostedServerRuntime,
} from "../../platform/NodeHostServices";
import { configService } from "../../config/CtrlYokeConfigService";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { MockHarnessIntegration } from "../helpers/mockHarness";
import {
  EXECUTION_STATES,
  HARNESS_IDS,
  MESSAGE_TYPES,
  RUN_HISTORY_LOCATIONS,
  RUNNER_IDS,
} from "../../types/DashboardConstants";
import { setRuntimeMode } from "../../utils/RuntimeMode";

type ReceivedMessage = Record<string, unknown>;

function waitForMessage(
  socket: WebSocket,
  predicate: (message: ReceivedMessage) => boolean,
  timeoutMs = 15_000
): Promise<ReceivedMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for the expected dashboard message"));
    }, timeoutMs);
    const onMessage = (data: RawData): void => {
      let message: ReceivedMessage;
      try {
        message = JSON.parse(data.toString()) as ReceivedMessage;
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

async function openSocket(url: string, clientId: string): Promise<WebSocket> {
  const socketUrl = new URL(url);
  socketUrl.pathname = "/ws";
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("clientId", clientId);
  const socket = new WebSocket(socketUrl.toString());
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

suite("Node hosted server composition", function () {
  this.timeout(60_000);

  let tempRoot: string;
  let workspaceRoot: string;
  let runtime: NodeHostedServerRuntime | undefined;
  let sockets: WebSocket[] = [];
  let originalHome: string | undefined;
  let originalToken: string | undefined;
  let originalCreateCopilotCli: typeof IntegrationFactory.prototype.createCopilotCli;

  setup(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-node-server-")
    );
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "Widget.ts"),
      "export class Widget {\n  run() {\n    return true;\n  }\n}\n"
    );
    await fs.mkdir(
      path.join(workspaceRoot, ".ctrlyoke", "skills", "sample-skill"),
      { recursive: true }
    );
    await fs.writeFile(
      path.join(
        workspaceRoot,
        ".ctrlyoke",
        "skills",
        "sample-skill",
        "SKILL.md"
      ),
      "---\nname: sample-skill\ndescription: Test completion skill\n---\n"
    );
    originalHome = process.env.CTRLYOKE_HOME;
    originalToken = process.env.CTRLYOKE_SERVER_TOKEN;
    process.env.CTRLYOKE_HOME = path.join(tempRoot, "state-home");
    process.env.CTRLYOKE_SERVER_TOKEN = "node-host-test-token";
    originalCreateCopilotCli = IntegrationFactory.prototype.createCopilotCli;
    IntegrationFactory.prototype.createCopilotCli = function () {
      return new MockHarnessIntegration(
        undefined,
        false
      ) as unknown as ReturnType<
        typeof IntegrationFactory.prototype.createCopilotCli
      >;
    };
    configService.setCliOverlay({
      storage: { runHistoryLocation: RUN_HISTORY_LOCATIONS.USER },
      server: {
        ...configService.getAll().server,
        port: 0,
        fallbackPorts: [],
        bindAddress: "127.0.0.1",
        tls: { enabled: false, certPath: "", keyPath: "" },
      },
    });
    runtime = await createNodeHostedServer({
      cwd: workspaceRoot,
      mode: "headless",
    });
  });

  teardown(async () => {
    for (const socket of sockets) socket.close();
    sockets = [];
    runtime?.dispose();
    runtime = undefined;
    IntegrationFactory.prototype.createCopilotCli = originalCreateCopilotCli;
    configService.setCliOverlay({});
    setRuntimeMode(RUNNER_IDS.VSCODE);
    if (originalHome === undefined) delete process.env.CTRLYOKE_HOME;
    else process.env.CTRLYOKE_HOME = originalHome;
    if (originalToken === undefined) delete process.env.CTRLYOKE_SERVER_TOKEN;
    else process.env.CTRLYOKE_SERVER_TOKEN = originalToken;
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 30,
      retryDelay: 100,
    });
  });

  test("boots from Node services, completes a fake-harness workflow, and scopes replies", async () => {
    assert.ok(runtime);
    assert.strictEqual(
      runtime.services.platform.interactiveTerminal,
      "embedded-pty"
    );

    const first = await openSocket(runtime.url, "first-tab");
    const second = await openSocket(runtime.url, "second-tab");
    sockets = [first, second];

    const scopedReply = waitForMessage(
      first,
      (message) =>
        message.type === MESSAGE_TYPES.DASHBOARD_HOST_ACTION_RESULT &&
        message.action === "showOutput"
    );
    const secondScopedReply = waitForMessage(
      second,
      (message) =>
        message.type === MESSAGE_TYPES.DASHBOARD_HOST_ACTION_RESULT &&
        message.action === "showOutput",
      750
    ).then(
      () => "received",
      () => "not-received"
    );
    first.send(JSON.stringify({ type: MESSAGE_TYPES.SHOW_OUTPUT }));
    const reply = await scopedReply;
    assert.strictEqual(reply.status, "unsupported");
    assert.strictEqual(await secondScopedReply, "not-received");

    const broadcast = waitForMessage(
      first,
      (message) => message.type === MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED
    );
    const secondBroadcast = waitForMessage(
      second,
      (message) => message.type === MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED
    );
    const executionIntegrations: MockHarnessIntegration[] = [];
    const originalCreateForExecution =
      IntegrationFactory.prototype.createForExecution;
    IntegrationFactory.prototype.createForExecution = function () {
      const integration = new MockHarnessIntegration(undefined, false);
      executionIntegrations.push(integration);
      return integration;
    };
    try {
      const initializationDeadline = Date.now() + 10_000;
      while (!runtime.orchestrator.isInitialized()) {
        if (Date.now() > initializationDeadline) {
          throw new Error("Node host orchestrator did not initialize");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await runtime.orchestrator.runInNewWorkflowForClient(
        "complete Node host workflow",
        { harness: HARNESS_IDS.COPILOT_CLI },
        undefined,
        () => undefined,
        "browser-test-client"
      );
    } finally {
      IntegrationFactory.prototype.createForExecution =
        originalCreateForExecution;
    }
    assert.strictEqual(
      runtime.orchestrator.getQueueState("browser-test-client").status,
      EXECUTION_STATES.COMPLETED,
      JSON.stringify(
        runtime.orchestrator.getQueueState("browser-test-client"),
        (_key, value) => (value instanceof Set ? [...value] : value)
      ) +
        `; integrations=${executionIntegrations.length}; prompts=${JSON.stringify(executionIntegrations.flatMap((integration) => integration.sentPrompts))}`
    );
    assert.deepStrictEqual(
      executionIntegrations.flatMap((integration) => integration.sentPrompts),
      ["complete Node host workflow"]
    );
    assert.ok((await broadcast).summary);
    assert.ok((await secondBroadcast).summary);
  });

  test("completes browser startup without a VS Code panel", async () => {
    assert.ok(runtime);
    const socket = await openSocket(runtime.url, "startup-client");
    sockets.push(socket);
    // With no panel READY to start the startup auto-load, a browser tab never
    // received STARTUP_COMPLETE and sat behind the startup overlay.
    const startupComplete = waitForMessage(
      socket,
      (message) => message.type === MESSAGE_TYPES.STARTUP_COMPLETE
    );
    socket.send(JSON.stringify({ type: MESSAGE_TYPES.READY }));
    await startupComplete;
  });

  test("delivers discovered model lists to browser tabs without a VS Code panel", async () => {
    assert.ok(runtime);
    const socket = await openSocket(runtime.url, "model-options-client");
    sockets.push(socket);
    // The model registry was only initialized by extension.ts, and its
    // "loaded" refresh only reached a ready VS Code panel, so standalone tabs
    // showed nothing but "None" for the dynamically discovered harnesses.
    // Discovery may finish before or after this tab's INIT, so accept either
    // carrier; both fall back to non-empty static lists when a CLI is absent.
    const modelOptionsOf = (
      message: ReceivedMessage
    ): Record<string, unknown[]> | undefined => {
      if (
        message.type !== MESSAGE_TYPES.INIT &&
        message.type !== MESSAGE_TYPES.MODEL_OPTIONS_UPDATE
      ) {
        return undefined;
      }
      return (message.data as { modelOptions?: Record<string, unknown[]> })
        ?.modelOptions;
    };
    const isPopulated = (message: ReceivedMessage): boolean => {
      const options = modelOptionsOf(message);
      // Each list always starts with the "None" option.
      return (
        (options?.[HARNESS_IDS.COPILOT_CLI]?.length ?? 0) > 1 &&
        (options?.[HARNESS_IDS.OPENCODE_CLI]?.length ?? 0) > 1
      );
    };
    const populated = waitForMessage(socket, isPopulated, 50_000);
    socket.send(JSON.stringify({ type: MESSAGE_TYPES.READY }));
    await populated;
  });

  test("serves standalone @, #, ~, and / prompt completions over WebSocket", async () => {
    assert.ok(runtime);
    const socket = await openSocket(runtime.url, "completion-client");
    sockets.push(socket);
    const requests = [
      { trigger: "@", prefix: "@Wid", expected: "Widget.ts" },
      {
        trigger: "#",
        prefix: "#Wid",
        expected: "sym.class:src/Widget.ts:Widget:1-5",
      },
      { trigger: "~", prefix: "~", expected: "diff" },
      { trigger: "/", prefix: "/", expected: "/skill:sample-skill" },
    ];
    for (const [index, request] of requests.entries()) {
      const responsePromise = waitForMessage(
        socket,
        (message) =>
          message.type === MESSAGE_TYPES.COMPLETIONS_RESPONSE &&
          message.seq === index + 1
      );
      socket.send(
        JSON.stringify({
          type: MESSAGE_TYPES.REQUEST_COMPLETIONS,
          ...request,
          position: request.prefix.length,
          seq: index + 1,
        })
      );
      const response = await responsePromise;
      const items = response.items as Array<{ insertText?: string }>;
      assert.ok(
        Array.isArray(items),
        `missing completion items for ${request.trigger}`
      );
      assert.ok(
        items.some((item) => item.insertText?.includes(request.expected)),
        `expected ${request.expected} for ${request.trigger}, got ${JSON.stringify(items)}`
      );
      if (request.trigger === "#") assert.strictEqual(response.partial, false);
    }
  });
});
