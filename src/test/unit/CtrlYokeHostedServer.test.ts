import * as assert from "assert";
import { suite, test } from "mocha";
import { createHostedHarnessStatusUpdate } from "../../server/HostedServerMessageFactory";
import {
  CtrlYokeHostedServer,
  sanitizeBrowserClientId,
} from "../../server/CtrlYokeHostedServer";
import {
  HARNESS_IDS,
  HOSTED_CONNECTION_LIVENESS,
  HARNESS_STATUS_STRINGS,
  MESSAGE_TYPES,
  BROWSER_NOTIFICATION_MODES,
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
import { buildTestNotificationEvent } from "../../ui/notifications/CompletionNotificationFactory";
import {
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";

suite("sanitizeBrowserClientId", () => {
  test("passes through a well-formed tabId", () => {
    assert.strictEqual(sanitizeBrowserClientId("k3j4h5abc9"), "k3j4h5abc9");
    assert.strictEqual(sanitizeBrowserClientId("a-b_c-1"), "a-b_c-1");
  });

  test("strips characters outside the allowed charset", () => {
    // Path/scheme/quote characters that could poison a map key or broadcast are removed.
    assert.strictEqual(sanitizeBrowserClientId("a.b/c;d<e>"), "abcde");
    assert.strictEqual(sanitizeBrowserClientId("../../etc"), "etc");
  });

  test("caps length at 64 characters", () => {
    const long = "a".repeat(200);
    assert.strictEqual(sanitizeBrowserClientId(long)?.length, 64);
  });

  test("returns null for absent or fully-stripped ids", () => {
    assert.strictEqual(sanitizeBrowserClientId(null), null);
    assert.strictEqual(sanitizeBrowserClientId(""), null);
    assert.strictEqual(sanitizeBrowserClientId("!@#$%^&*()"), null);
  });
});

suite("HostedServerMessageFactory", () => {
  test("creates harness updates in the webview message shape", () => {
    assert.deepStrictEqual(
      createHostedHarnessStatusUpdate(
        HARNESS_IDS.CODEX_CLI,
        true,
        "Install via: npm install -g @openai/codex-cli"
      ),
      {
        type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
        data: {
          harnessStatus: {
            [HARNESS_IDS.CODEX_CLI]: {
              available: true,
              status: HARNESS_STATUS_STRINGS.AVAILABLE,
              installHint: "Install via: npm install -g @openai/codex-cli",
            },
          },
        },
      }
    );
  });
});

interface FakeHostedSocket {
  readyState: number;
  pingCalls: number;
  sent: string[];
  terminated: boolean;
  ping(): void;
  send(message: string): void;
  terminate(): void;
}

interface HostedServerHeartbeatInternals {
  connections: Set<FakeHostedSocket>;
  socketLiveness: WeakMap<FakeHostedSocket, boolean>;
  socketLastProtocolPongAt: WeakMap<FakeHostedSocket, number>;
  socketLastApplicationAckAt: WeakMap<FakeHostedSocket, number>;
  socketTerminationCauses: WeakMap<FakeHostedSocket, string>;
  socketClientTags: WeakMap<FakeHostedSocket, string>;
  nextApplicationHeartbeatId: number;
  runHeartbeatCycle(): void;
}

interface HostedServerFeedbackInternals {
  connections: Set<FakeHostedSocket>;
  notifiedEventIds: Set<string>;
  broadcast(message: unknown): void;
  broadcastUserFeedback(message: unknown): void;
  dispatchCompletionNotification(
    event: ReturnType<typeof buildTestNotificationEvent>
  ): Promise<void>;
}

function createHeartbeatHarness(): {
  server: HostedServerHeartbeatInternals;
  socket: FakeHostedSocket;
} {
  const socket: FakeHostedSocket = {
    readyState: 1,
    pingCalls: 0,
    sent: [],
    terminated: false,
    ping() {
      this.pingCalls++;
    },
    send(message) {
      this.sent.push(message);
    },
    terminate() {
      this.terminated = true;
    },
  };
  const server = Object.create(
    CtrlYokeHostedServer.prototype
  ) as HostedServerHeartbeatInternals;
  server.connections = new Set([socket]);
  server.socketLiveness = new WeakMap([[socket, true]]);
  server.socketLastProtocolPongAt = new WeakMap([[socket, Date.now()]]);
  server.socketLastApplicationAckAt = new WeakMap([[socket, Date.now()]]);
  server.socketTerminationCauses = new WeakMap();
  server.socketClientTags = new WeakMap([[socket, "browser:test"]]);
  server.nextApplicationHeartbeatId = 1;
  return { server, socket };
}

suite("CtrlYokeHostedServer connection heartbeat", () => {
  test("sends protocol and application heartbeats on a healthy socket", () => {
    const { server, socket } = createHeartbeatHarness();

    server.runHeartbeatCycle();

    assert.strictEqual(socket.pingCalls, 1);
    const heartbeat = JSON.parse(socket.sent[0]);
    assert.strictEqual(
      heartbeat.type,
      MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT
    );
    assert.strictEqual(heartbeat.id, "server-1");
    assert.strictEqual(typeof heartbeat.sentAt, "number");
    assert.strictEqual(socket.terminated, false);
  });

  test("records an explicit cause before terminating a missed protocol pong", () => {
    const { server, socket } = createHeartbeatHarness();
    server.socketLiveness.set(socket, false);

    server.runHeartbeatCycle();

    assert.strictEqual(socket.terminated, true);
    assert.strictEqual(
      server.socketTerminationCauses.get(socket),
      "protocol-pong-timeout"
    );
  });

  test("terminates a socket whose application heartbeat was never acknowledged", () => {
    const { server, socket } = createHeartbeatHarness();
    server.socketLastApplicationAckAt.set(
      socket,
      Date.now() -
        HOSTED_CONNECTION_LIVENESS.SERVER_APPLICATION_ACK_TIMEOUT_MS -
        1
    );

    server.runHeartbeatCycle();

    assert.strictEqual(socket.terminated, true);
    assert.strictEqual(
      server.socketTerminationCauses.get(socket),
      "application-heartbeat-ack-timeout"
    );
  });
});

suite("CtrlYokeHostedServer feedback transport", () => {
  test("delivers USER_FEEDBACK even when browser notifications are never", () => {
    try {
      configService.setCliOverlay({
        notifications: {
          browser: { mode: BROWSER_NOTIFICATION_MODES.NEVER },
        },
      });
      const socket: FakeHostedSocket = {
        readyState: 1,
        pingCalls: 0,
        sent: [],
        terminated: false,
        ping() {},
        send(message) {
          this.sent.push(message);
        },
        terminate() {},
      };
      const server = Object.create(
        CtrlYokeHostedServer.prototype
      ) as HostedServerFeedbackInternals;
      server.connections = new Set([socket]);

      server.broadcastUserFeedback({
        type: MESSAGE_TYPES.USER_FEEDBACK,
        id: "feedback-1",
        severity: "error",
        message: "Operational failure",
      });

      assert.strictEqual(socket.sent.length, 1);
      assert.strictEqual(
        JSON.parse(socket.sent[0]).type,
        MESSAGE_TYPES.USER_FEEDBACK
      );
    } finally {
      configService.setCliOverlay({});
    }
  });

  test("redacts exact values before the WebSocket transport", () => {
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: "remote-dashboard-secret" });
    const release = secretRedactionService.register(redactor);
    const socket: FakeHostedSocket = {
      readyState: 1,
      pingCalls: 0,
      sent: [],
      terminated: false,
      ping() {},
      send(message) {
        this.sent.push(message);
      },
      terminate() {},
    };
    const server = Object.create(
      CtrlYokeHostedServer.prototype
    ) as HostedServerFeedbackInternals;
    server.connections = new Set([socket]);

    server.broadcastUserFeedback({
      type: MESSAGE_TYPES.USER_FEEDBACK,
      id: "feedback-secret",
      severity: "error",
      message: "remote-dashboard-secret",
    });
    release();

    assert.ok(!socket.sent[0]?.includes("remote-dashboard-secret"));
    assert.ok(socket.sent[0]?.includes("[REDACTED]"));
  });

  test("suppresses NOTIFICATION_EVENT in never mode but delivers it when connected", async () => {
    try {
      const socket: FakeHostedSocket = {
        readyState: 1,
        pingCalls: 0,
        sent: [],
        terminated: false,
        ping() {},
        send(message) {
          this.sent.push(message);
        },
        terminate() {},
      };
      const server = Object.create(
        CtrlYokeHostedServer.prototype
      ) as HostedServerFeedbackInternals;
      server.connections = new Set([socket]);
      server.notifiedEventIds = new Set();
      const event = buildTestNotificationEvent("http://localhost");

      configService.setCliOverlay({
        notifications: {
          browser: { mode: BROWSER_NOTIFICATION_MODES.NEVER },
        },
      });
      await server.dispatchCompletionNotification(event);
      assert.strictEqual(socket.sent.length, 0);

      configService.setCliOverlay({
        notifications: {
          browser: { mode: BROWSER_NOTIFICATION_MODES.CONNECTED_ONLY },
        },
      });
      await server.dispatchCompletionNotification(event);
      assert.strictEqual(socket.sent.length, 1);
      assert.strictEqual(
        JSON.parse(socket.sent[0]).type,
        MESSAGE_TYPES.NOTIFICATION_EVENT
      );
    } finally {
      configService.setCliOverlay({});
    }
  });
});
