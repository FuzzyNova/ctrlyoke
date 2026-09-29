import * as assert from "assert";
import * as fs from "fs";
import { request as httpRequest } from "http";
import * as path from "path";
import { suite, test } from "mocha";
import { DashboardBroadcastHub } from "../../ui/DashboardBroadcastHub";
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
  REDACTION_MARKER,
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { CodexCliProvider } from "../../core/harness/codex/CodexCliProvider";

function sendJsonRequest(
  port: number,
  requestPath: string,
  method: "POST" | "PUT",
  body: unknown
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        res.on("end", () =>
          resolve({ statusCode: res.statusCode, body: responseBody })
        );
      }
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

function sendGetRequest(
  port: number,
  requestPath: string
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path: requestPath, method: "GET" },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        res.on("end", () =>
          resolve({ statusCode: res.statusCode, body: responseBody })
        );
      }
    );
    request.on("error", reject);
    request.end();
  });
}

suite("CtrlYokeHostedServer workspace file redaction", () => {
  async function withServer(
    testBody: (root: string, port: number, token: string) => Promise<void>
  ): Promise<void> {
    const token =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const workspaceRoot = makeTempDir("ctrlyoke-hosted-file-redaction-");
    const server = new CtrlYokeHostedServer(
      new DashboardBroadcastHub(),
      {} as never,
      (() => ({})) as never,
      0,
      workspaceRoot,
      [],
      token
    );
    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      await testBody(workspaceRoot, Number(new URL(serverUrl).port), token);
    } finally {
      server.dispose();
      removeTempDir(workspaceRoot);
    }
  }

  test("keeps the access token in the hosted page manifest link and start URL", async () => {
    await withServer(async (_root, port, token) => {
      const page = await sendGetRequest(port, `/?token=${token}`);
      assert.strictEqual(page.statusCode, 200);
      assert.ok(
        page.body.includes(
          `<link rel="manifest" href="/manifest.webmanifest?token=${token}" />`
        )
      );

      const manifest = await sendGetRequest(
        port,
        `/manifest.webmanifest?token=${token}`
      );
      assert.strictEqual(manifest.statusCode, 200);
      assert.strictEqual(
        JSON.parse(manifest.body).start_url,
        `/?token=${token}`
      );
    });
  });

  test("requires a token and patches /index.html as a hosted page", async () => {
    await withServer(async (_root, port, token) => {
      const unauthorized = await sendGetRequest(port, "/index.html");
      assert.strictEqual(unauthorized.statusCode, 401);

      const response = await sendGetRequest(port, `/index.html?token=${token}`);
      assert.strictEqual(response.statusCode, 200);
      const rootPage = await sendGetRequest(port, `/?token=${token}`);
      assert.strictEqual(response.body, rootPage.body);
      assert.ok(response.body.includes("/standalone-shim.js"));
      assert.ok(response.body.includes(`/manifest.webmanifest?token=${token}`));
      assert.ok(!response.body.includes("{{cspSource}}"));
      assert.ok(!response.body.includes("{{codiconsUri}}"));
      assert.ok(!response.body.includes("{{customIconsUri}}"));
      assert.ok(!response.body.includes("{{typoUri}}"));
    });
  });

  test("static fallback cannot serve encoded entry HTML or raw favicon", async () => {
    await withServer(async (_root, port, token) => {
      for (const requestPath of [
        "/%69ndex.html",
        "/index%2ehtml",
        "/./index.html",
      ]) {
        const response = await sendGetRequest(port, requestPath);
        assert.notStrictEqual(response.statusCode, 200, requestPath);
        assert.ok(!response.body.includes("{{cspSource}}"), requestPath);
      }

      const encodedFavicon = await sendGetRequest(port, "/%66avicon.svg");
      assert.notStrictEqual(encodedFavicon.statusCode, 200);

      const authorizedEntry = await sendGetRequest(
        port,
        `/index.html?token=${token}`
      );
      assert.strictEqual(authorizedEntry.statusCode, 200);
      assert.ok(!authorizedEntry.body.includes("{{cspSource}}"));
    });
  });

  test("static fallback blocks NTFS aliases for protected files without a token", async () => {
    await withServer(async (_root, port) => {
      for (const requestPath of [
        "/index.html::$DATA",
        "/INDEX~1.HTM",
        "/favicon.svg::$DATA",
        "/FAVICO~1.SVG",
      ]) {
        const response = await sendGetRequest(port, requestPath);
        assert.strictEqual(response.statusCode, 404, requestPath);
        assert.ok(!response.body.includes("{{cspSource}}"), requestPath);
        assert.ok(!response.body.includes("<html"), requestPath);
      }
    });
  });

  test("returns credential files read-only with redacted content", async () => {
    await withServer(async (root, port, token) => {
      fs.writeFileSync(
        path.join(root, "app.env"),
        "# config\nAPI_KEY=sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c\nPORT=3000\n"
      );
      const response = await sendGetRequest(
        port,
        `/api/workspace-viewer/file?path=app.env&token=${encodeURIComponent(token)}`
      );

      assert.strictEqual(response.statusCode, 200);
      const file = JSON.parse(response.body) as {
        content: string;
        readOnly?: boolean;
        reason?: string;
      };
      assert.strictEqual(file.readOnly, true);
      assert.match(file.reason ?? "", /secret/i);
      assert.ok(file.content.includes(REDACTION_MARKER));
      assert.ok(!file.content.includes("sk-live-"));
    });
  });

  test("rejects saving a newly introduced redaction marker without changing the file", async () => {
    await withServer(async (root, port, token) => {
      const original = "PORT=3000\n";
      fs.writeFileSync(path.join(root, "app.env"), original);
      const response = await sendJsonRequest(
        port,
        `/api/workspace-viewer/file?token=${encodeURIComponent(token)}`,
        "PUT",
        {
          path: "app.env",
          content: `API_KEY=${REDACTION_MARKER}\nPORT=4000\n`,
        }
      );

      assert.strictEqual(response.statusCode, 400);
      assert.strictEqual(
        fs.readFileSync(path.join(root, "app.env"), "utf8"),
        original
      );
    });
  });

  test("ordinary files still round-trip through GET and PUT", async () => {
    await withServer(async (root, port, token) => {
      fs.writeFileSync(path.join(root, "notes.txt"), "hello\n");
      const fileUrl = `/api/workspace-viewer/file?path=notes.txt&token=${encodeURIComponent(token)}`;
      const read = await sendGetRequest(port, fileUrl);
      assert.strictEqual(read.statusCode, 200);
      assert.strictEqual(JSON.parse(read.body).content, "hello\n");

      const save = await sendJsonRequest(
        port,
        `/api/workspace-viewer/file?token=${encodeURIComponent(token)}`,
        "PUT",
        { path: "notes.txt", content: "updated\n" }
      );
      assert.strictEqual(save.statusCode, 200);
      assert.strictEqual(
        fs.readFileSync(path.join(root, "notes.txt"), "utf8"),
        "updated\n"
      );
    });
  });
});

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

suite("CtrlYokeHostedServer file history route", () => {
  test("rejects a missing path before invoking the viewer service", async () => {
    const token = "route-test-token";
    const server = new CtrlYokeHostedServer(
      new DashboardBroadcastHub(),
      {} as never,
      (() => ({})) as never,
      0,
      process.cwd(),
      [],
      token
    );
    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      const url = new URL(serverUrl);
      const response = await new Promise<{
        statusCode: number | undefined;
        body: string;
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: Number(url.port),
            path: `/api/workspace-viewer/file-history?token=${encodeURIComponent(token)}`,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.on("end", () => resolve({ statusCode: res.statusCode, body }));
          }
        );
        request.on("error", reject);
        request.end();
      });

      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(JSON.parse(response.body), {
        error: "path is required",
      });
    } finally {
      server.dispose();
    }
  });

  test("rejects a missing commit before invoking the viewer service", async () => {
    const token = "route-test-token-commit";
    const server = new CtrlYokeHostedServer(
      new DashboardBroadcastHub(),
      {} as never,
      (() => ({})) as never,
      0,
      process.cwd(),
      [],
      token
    );
    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      const url = new URL(serverUrl);
      const response = await new Promise<{
        statusCode: number | undefined;
        body: string;
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: Number(url.port),
            path: `/api/workspace-viewer/file-history-diff?path=file.txt&token=${encodeURIComponent(token)}`,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.on("end", () => resolve({ statusCode: res.statusCode, body }));
          }
        );
        request.on("error", reject);
        request.end();
      });

      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(JSON.parse(response.body), {
        error: "commit is required",
      });
    } finally {
      server.dispose();
    }
  });

  test("rejects a missing ref on the paged git-ref diff route", async () => {
    const token = "route-test-token-diff-page";
    const server = new CtrlYokeHostedServer(
      new DashboardBroadcastHub(),
      {} as never,
      (() => ({})) as never,
      0,
      process.cwd(),
      [],
      token
    );
    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      const url = new URL(serverUrl);
      const response = await new Promise<{
        statusCode: number | undefined;
        body: string;
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: Number(url.port),
            path: `/api/workspace-viewer/git-ref-diff-page?token=${encodeURIComponent(token)}`,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.on("end", () => resolve({ statusCode: res.statusCode, body }));
          }
        );
        request.on("error", reject);
        request.end();
      });

      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(JSON.parse(response.body), {
        error: "ref is required",
      });
    } finally {
      server.dispose();
    }
  });
});

suite("CtrlYokeHostedServer JSON body limits", () => {
  test("saves a 1 MB workspace viewer file", async () => {
    const token = "large-file-save-token";
    const workspaceRoot = makeTempDir("ctrlyoke-hosted-large-save-");
    const server = new CtrlYokeHostedServer(
      new DashboardBroadcastHub(),
      {} as never,
      (() => ({})) as never,
      0,
      workspaceRoot,
      [],
      token
    );

    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      const url = new URL(serverUrl);
      const content = "a".repeat(1024 * 1024);
      const response = await sendJsonRequest(
        Number(url.port),
        `/api/workspace-viewer/file?token=${encodeURIComponent(token)}`,
        "PUT",
        { path: "large.txt", content }
      );

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(
        fs.readFileSync(path.join(workspaceRoot, "large.txt"), "utf8"),
        content
      );
    } finally {
      server.dispose();
      removeTempDir(workspaceRoot);
    }
  });

  test("keeps the default JSON body limit for ordinary routes", async () => {
    const token = "default-json-limit-token";
    const server = new CtrlYokeHostedServer(
      new DashboardBroadcastHub(),
      {} as never,
      (() => ({})) as never,
      0,
      process.cwd(),
      [],
      token
    );

    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      const url = new URL(serverUrl);
      const response = await sendJsonRequest(
        Number(url.port),
        `/api/workspace-viewer/stage?token=${encodeURIComponent(token)}`,
        "POST",
        { path: "file.txt", content: "a".repeat(70 * 1024) }
      );

      assert.strictEqual(response.statusCode, 413);
    } finally {
      server.dispose();
    }
  });
});

suite("HostedServerMessageFactory", () => {
  const codexInstallHint = new CodexCliProvider().config.installHint;

  test("creates harness updates in the webview message shape", () => {
    assert.deepStrictEqual(
      createHostedHarnessStatusUpdate(
        HARNESS_IDS.CODEX_CLI,
        true,
        codexInstallHint
      ),
      {
        type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
        data: {
          harnessStatus: {
            [HARNESS_IDS.CODEX_CLI]: {
              available: true,
              status: HARNESS_STATUS_STRINGS.AVAILABLE,
              installHint: codexInstallHint,
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
