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
  SERVER_BIND_ADDRESSES,
} from "../../types/DashboardConstants";
import { setRuntimeMode } from "../../utils/RuntimeMode";
import {
  getPtyProcessManager,
  ptyPostMessage,
} from "../../core/harness/PtyProcessManager";

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
  // The server binds 127.0.0.1 but advertises "localhost", which Node resolves
  // to ::1 first. That attempt is refused, and the IPv4 one then races Node's
  // 250ms per-family connect timeout; while the host is busy probing harness
  // CLIs it loses, and the connect fails as an AggregateError. Dial the bound
  // address (this suite always binds it) directly.
  socketUrl.hostname = SERVER_BIND_ADDRESSES.LOCALHOST;
  const socket = new WebSocket(socketUrl.toString());
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", (error) =>
      reject(
        error instanceof AggregateError
          ? new Error(
              `WebSocket connect to ${socketUrl.host} failed: ${error.errors.map(String).join("; ")}`
            )
          : error
      )
    );
  });
  return socket;
}

// Setup once timed out at the suite's 60s under `npm test` with no hint of
// which phase stalled (the host was also probing every real harness CLI on the
// machine at the time). Report any slow phase so the next failure says where
// the time went.
const SLOW_SETUP_PHASE_MS = 5_000;

async function timedSetupPhase<T>(
  phase: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SLOW_SETUP_PHASE_MS) {
      console.warn(
        `[nodeHostedServer.integration] slow setup phase "${phase}": ${elapsedMs}ms`
      );
    }
  }
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
    runtime = await timedSetupPhase("createNodeHostedServer", () =>
      createNodeHostedServer({
        cwd: workspaceRoot,
        mode: "headless",
      })
    );
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
      // The compatibility preflight probes the real `copilot` binary, not the
      // faked integration; on a machine without it (CI) the run errors before
      // any integration is created.
      const registry = runtime.orchestrator.getCompatibilityRegistry();
      const detectInstalled = registry.getInstalledCapabilities.bind(registry);
      registry.getInstalledCapabilities = async (harnessId) => {
        const installed = await detectInstalled(harnessId);
        return harnessId === HARNESS_IDS.COPILOT_CLI
          ? { ...installed, available: true }
          : installed;
      };
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

  test("initializes the PTY manager and broadcasts terminal messages to browser tabs", async () => {
    assert.ok(runtime);
    // The server selects the embedded-PTY terminal mode, but only extension.ts
    // ever created the manager, so interactive steps silently never launched.
    const ptyManager = getPtyProcessManager();
    assert.ok(
      ptyManager,
      "createNodeHostedServer must initialize the PTY manager"
    );

    const socket = await openSocket(runtime.url, "terminal-client");
    sockets.push(socket);
    const terminalStarted = waitForMessage(
      socket,
      (message) =>
        message.type === MESSAGE_TYPES.TERMINAL_STARTED &&
        message.sessionId === "pty-broadcast-session"
    );
    const activeTerminals = waitForMessage(
      socket,
      (message) => message.type === MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS
    );
    ptyPostMessage({
      type: MESSAGE_TYPES.TERMINAL_STARTED,
      workflowId: "pty-broadcast-workflow",
      sessionId: "pty-broadcast-session",
    });
    await terminalStarted;
    await activeTerminals;

    await runtime.dispose();
    runtime = undefined;
    assert.strictEqual(getPtyProcessManager(), null);
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

  test("answers a prompt-token request from a workflow file with a document-relative position", async () => {
    assert.ok(runtime);
    const socket = await openSocket(runtime.url, "workflow-file-client");
    sockets.push(socket);
    // The workspace editor sends the token's offset in the whole workflow
    // file, not its offset within the prompt text.
    const responsePromise = waitForMessage(
      socket,
      (message) =>
        message.type === MESSAGE_TYPES.COMPLETIONS_RESPONSE &&
        message.seq === 101
    );
    socket.send(
      JSON.stringify({
        type: MESSAGE_TYPES.REQUEST_COMPLETIONS,
        trigger: "@",
        prefix: "@Wid",
        position: 4096,
        seq: 101,
      })
    );
    const items = (await responsePromise).items as Array<{
      insertText?: string;
    }>;
    assert.ok(
      items.some((item) => item.insertText?.includes("Widget.ts")),
      `expected Widget.ts, got ${JSON.stringify(items)}`
    );
  });
});
