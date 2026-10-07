import { suite, test, setup, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket, type RawData } from "ws";
import { createNodeHostedServer, type NodeHostedServerRuntime } from "../../platform/NodeHostServices";
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
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-node-server-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceRoot);
    originalHome = process.env.CTRLYOKE_HOME;
    originalToken = process.env.CTRLYOKE_SERVER_TOKEN;
    process.env.CTRLYOKE_HOME = path.join(tempRoot, "state-home");
    process.env.CTRLYOKE_SERVER_TOKEN = "node-host-test-token";
    originalCreateCopilotCli = IntegrationFactory.prototype.createCopilotCli;
    IntegrationFactory.prototype.createCopilotCli = function () {
      return new MockHarnessIntegration(undefined, false) as unknown as ReturnType<
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
    runtime = await createNodeHostedServer({ cwd: workspaceRoot, mode: "headless" });
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
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });

  test("boots from Node services, completes a fake-harness workflow, and scopes replies", async () => {
    assert.ok(runtime);
    assert.strictEqual(runtime.services.platform.interactiveTerminal, "embedded-pty");

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
    ).then(() => "received", () => "not-received");
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
      IntegrationFactory.prototype.createForExecution = originalCreateForExecution;
    }
    assert.strictEqual(
      runtime.orchestrator.getQueueState("browser-test-client").status,
      EXECUTION_STATES.COMPLETED,
      JSON.stringify(runtime.orchestrator.getQueueState("browser-test-client"), (_key, value) =>
        value instanceof Set ? [...value] : value
      ) + `; integrations=${executionIntegrations.length}; prompts=${JSON.stringify(executionIntegrations.flatMap((integration) => integration.sentPrompts))}`
    );
    assert.deepStrictEqual(
      executionIntegrations.flatMap((integration) => integration.sentPrompts),
      ["complete Node host workflow"]
    );
    assert.ok((await broadcast).summary);
    assert.ok((await secondBroadcast).summary);
  });
});
