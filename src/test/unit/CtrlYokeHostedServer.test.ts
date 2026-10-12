import * as assert from "assert";
import * as fs from "fs";
import { request as httpRequest } from "http";
import * as path from "path";
import { suite, test } from "mocha";
import { WebSocket } from "ws";
import { DashboardBroadcastHub } from "../../ui/DashboardBroadcastHub";
import { createHostedHarnessStatusUpdate } from "../../server/HostedServerMessageFactory";
import {
  CtrlYokeHostedServer,
  type HostedServerOptions,
  maskHostedServerUrlToken,
  sanitizeBrowserClientId,
} from "../../server/CtrlYokeHostedServer";
import {
  HARNESS_IDS,
  HOST_KINDS,
  HOSTED_CONNECTION_LIVENESS,
  HARNESS_STATUS_STRINGS,
  HARNESS_VERSION_STATUSES,
  MESSAGE_TYPES,
  BROWSER_NOTIFICATION_MODES,
  THEME_KINDS,
  THEME_KIND_CSS_VAR,
  VSCODE_THEME_BODY_CLASSES,
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
import {
  buildHookNotificationEvent,
  buildTestNotificationEvent,
  type CtrlYokeNotificationEvent,
  type HookArtifact,
} from "../../ui/notifications/CompletionNotificationFactory";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import {
  REDACTION_MARKER,
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { CodexCliProvider } from "../../core/harness/codex/CodexCliProvider";
import { NoopFileWatcherFactory } from "../helpers/NoopFileWatcherFactory";

function createHostedServer(options: Partial<HostedServerOptions> = {}) {
  return new CtrlYokeHostedServer({
    hub: new DashboardBroadcastHub(),
    endpoint: {} as never,
    getOrchestrator: (() => ({})) as never,
    port: 0,
    fallbackPorts: [],
    bindAddress: "127.0.0.1",
    workspaceRoot: process.cwd(),
    namedWorkspaceRoots: [],
    token: "test-token",
    remoteAccess: {
      canUse: async () => false,
      begin: async () => false,
      onBlocked: () => undefined,
    },
    hostKind: HOST_KINDS.VSCODE,
    themeDefaults: {
      dark: ":root { --theme-default: dark; }",
      light: ":root { --theme-default: light; }",
    },
    fileWatcherFactory: new NoopFileWatcherFactory(),
    ...options,
  });
}

class TestableHostedServer extends CtrlYokeHostedServer {
  allowClient(remoteAddress: string | undefined): Promise<boolean> {
    return this.isClientAllowed(remoteAddress);
  }
}

suite("CtrlYokeHostedServer authentication", () => {
  test("rejects an empty access token", () => {
    assert.throws(
      () => createHostedServer({ token: "" }),
      /Hosted server access token must not be empty/
    );
  });
});

suite("CtrlYokeHostedServer remote access trial", () => {
  test("local dashboard access leaves the trial unused; the first remote client starts it", async () => {
    let trialStarted = false;
    let beginCalls = 0;
    const canUse = async () => true;
    const server = new TestableHostedServer({
      hub: new DashboardBroadcastHub(),
      endpoint: {} as never,
      getOrchestrator: (() => ({})) as never,
      port: 0,
      fallbackPorts: [],
      bindAddress: "0.0.0.0",
      workspaceRoot: process.cwd(),
      namedWorkspaceRoots: [],
      token: "test-token",
      remoteAccess: {
        canUse,
        begin: async () => {
          beginCalls++;
          trialStarted = true;
          return true;
        },
        onBlocked: () => undefined,
      },
      hostKind: HOST_KINDS.VSCODE,
      themeDefaults: {
        dark: ":root { --theme-default: dark; }",
        light: ":root { --theme-default: light; }",
      },
      fileWatcherFactory: new NoopFileWatcherFactory(),
    });

    assert.strictEqual(await canUse(), true);
    assert.strictEqual(trialStarted, false);
    assert.strictEqual(await server.allowClient("127.0.0.1"), true);
    assert.strictEqual(trialStarted, false);
    assert.strictEqual(await server.allowClient("192.0.2.1"), true);
    assert.strictEqual(trialStarted, true);
    assert.strictEqual(beginCalls, 1);
  });
});

function sendJsonRequest(
  port: number,
  requestPath: string,
  method: "POST" | "PUT",
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: { "content-type": "application/json", ...headers },
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
    testBody: (
      root: string,
      port: number,
      token: string,
      watcherFactory: NoopFileWatcherFactory
    ) => Promise<void>
  ): Promise<void> {
    const token =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const workspaceRoot = makeTempDir("ctrlyoke-hosted-file-redaction-");
    const watcherFactory = new NoopFileWatcherFactory();
    const server = createHostedServer({
      workspaceRoot,
      token,
      fileWatcherFactory: watcherFactory,
    });
    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      await testBody(
        workspaceRoot,
        Number(new URL(serverUrl).port),
        token,
        watcherFactory
      );
    } finally {
      server.dispose();
      removeTempDir(workspaceRoot);
    }
  }

  function openBrowserTab(
    port: number,
    token: string,
    clientId: string
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws?token=${token}&clientId=${clientId}`
      );
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  function nextWorkspaceFileChanged(
    ws: WebSocket
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.off("message", handleMessage);
        reject(new Error("Timed out waiting for workspace file change"));
      }, 3000);
      const handleMessage = (raw: Buffer) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type !== MESSAGE_TYPES.WORKSPACE_FILE_CHANGED) return;
        clearTimeout(timeout);
        ws.off("message", handleMessage);
        resolve(message);
      };
      ws.on("message", handleMessage);
    });
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

  test("rejects unsafe hosted icon colors in HTML, manifest, and SVG", async () => {
    const unsafeColor =
      '#000"><script>alert(document.location)</script><link x="';
    configService.setCliOverlay({
      server: { iconBgColor: unsafeColor } as never,
    } as never);
    try {
      await withServer(async (_root, port, token) => {
        const page = await sendGetRequest(port, `/?token=${token}`);
        assert.strictEqual(page.statusCode, 200);
        assert.ok(!page.body.includes(unsafeColor));
        assert.ok(
          !page.body.includes("<script>alert(document.location)</script>")
        );

        const manifest = await sendGetRequest(
          port,
          `/manifest.webmanifest?token=${token}`
        );
        assert.strictEqual(manifest.statusCode, 200);
        assert.ok(!manifest.body.includes(unsafeColor));
        assert.ok(!manifest.body.includes("<script>"));

        const favicon = await sendGetRequest(port, "/favicon.svg");
        assert.strictEqual(favicon.statusCode, 200);
        assert.ok(!favicon.body.includes(unsafeColor));
        assert.ok(!favicon.body.includes("<script>"));
      });
    } finally {
      configService.setCliOverlay({});
    }
  });

  test("falls back for non-string hosted icon colors", async () => {
    configService.setCliOverlay({
      server: { iconBgColor: 1 } as never,
    } as never);
    try {
      await withServer(async (_root, port, token) => {
        const page = await sendGetRequest(port, `/?token=${token}`);
        assert.strictEqual(page.statusCode, 200);

        const manifest = await sendGetRequest(
          port,
          `/manifest.webmanifest?token=${token}`
        );
        assert.strictEqual(manifest.statusCode, 200);
        assert.ok(JSON.parse(manifest.body));
      });
    } finally {
      configService.setCliOverlay({});
    }
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
        "/%5Cindex.html",
        "/.%5Cindex.html",
        "/a%5C..%5Cindex.html",
        "/%5Cfavicon.svg",
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

  test("static fallback blocks NTFS aliases for protected files without a token", async function () {
    if (process.platform !== "win32") this.skip();
    await withServer(async (_root, port) => {
      for (const requestPath of [
        "/index.html::$DATA",
        "/INDEX~1.HTM",
        "/./INDEX~1.HTM",
        "/a/../INDEX~1.HTM",
        "/.%5CINDEX~1.HTM",
        "/./index.html::$DATA",
        "/%5Cindex.html::$DATA",
        "/favicon.svg::$DATA",
        "/./favicon.svg::$DATA",
        "/FAVICO~1.SVG",
        "/./FAVICO~1.SVG",
      ]) {
        const response = await sendGetRequest(port, requestPath);
        assert.strictEqual(response.statusCode, 404, requestPath);
        assert.ok(!response.body.includes("{{cspSource}}"), requestPath);
        assert.ok(!response.body.includes("<html"), requestPath);
      }

      const legitimateAsset = await sendGetRequest(port, "/standalone-shim.js");
      assert.strictEqual(legitimateAsset.statusCode, 200);
      assert.ok(legitimateAsset.body.length > 0);
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
          baseModifiedAt: fs.statSync(path.join(root, "app.env")).mtimeMs,
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
      const diskPath = path.join(root, "notes.txt");
      fs.writeFileSync(diskPath, "hello\n");
      fs.utimesSync(diskPath, new Date("2020-01-01"), new Date("2020-01-01"));
      const fileUrl = `/api/workspace-viewer/file?path=notes.txt&token=${encodeURIComponent(token)}`;
      const read = await sendGetRequest(port, fileUrl);
      assert.strictEqual(read.statusCode, 200);
      const original = JSON.parse(read.body) as {
        content: string;
        modifiedAt: number;
      };
      assert.strictEqual(original.content, "hello\n");
      assert.strictEqual(original.modifiedAt, fs.statSync(diskPath).mtimeMs);

      const save = await sendJsonRequest(
        port,
        `/api/workspace-viewer/file?token=${encodeURIComponent(token)}`,
        "PUT",
        {
          path: "notes.txt",
          content: "updated\n",
          baseModifiedAt: original.modifiedAt,
        }
      );
      assert.strictEqual(save.statusCode, 200);
      const saved = JSON.parse(save.body) as { modifiedAt: number };
      assert.strictEqual(saved.modifiedAt, fs.statSync(diskPath).mtimeMs);
      assert.strictEqual(fs.readFileSync(diskPath, "utf8"), "updated\n");

      const staleSave = await sendJsonRequest(
        port,
        `/api/workspace-viewer/file?token=${encodeURIComponent(token)}`,
        "PUT",
        {
          path: "notes.txt",
          content: "stale overwrite\n",
          baseModifiedAt: original.modifiedAt,
        }
      );
      assert.strictEqual(staleSave.statusCode, 409);
      assert.strictEqual(fs.readFileSync(diskPath, "utf8"), "updated\n");
    });
  });

  test("two tabs receive file changes and the second stale save returns 409", async () => {
    await withServer(async (root, port, token, watcherFactory) => {
      const diskPath = path.join(root, "notes.txt");
      fs.writeFileSync(diskPath, "hello\n");
      fs.utimesSync(diskPath, new Date("2020-01-01"), new Date("2020-01-01"));
      const tabA = await openBrowserTab(port, token, "tab-a");
      const tabB = await openBrowserTab(port, token, "tab-b");
      try {
        for (const clientId of ["tab-a", "tab-b"]) {
          const watch = await sendJsonRequest(
            port,
            `/api/workspace-viewer/file/watch?token=${token}`,
            "POST",
            { path: "notes.txt" },
            { "x-ctrlyoke-client-id": clientId }
          );
          assert.strictEqual(watch.statusCode, 200);
        }
        assert.strictEqual(watcherFactory.watchers.length, 1);

        const read = await sendGetRequest(
          port,
          `/api/workspace-viewer/file?path=notes.txt&token=${token}`
        );
        const loaded = JSON.parse(read.body) as { modifiedAt: number };
        const tabAChange = nextWorkspaceFileChanged(tabA);
        const tabBChange = nextWorkspaceFileChanged(tabB);
        const saved = await sendJsonRequest(
          port,
          `/api/workspace-viewer/file?token=${token}`,
          "PUT",
          {
            path: "notes.txt",
            content: "tab A\n",
            baseModifiedAt: loaded.modifiedAt,
          },
          { "x-ctrlyoke-client-id": "tab-a" }
        );
        assert.strictEqual(saved.statusCode, 200);
        assert.strictEqual((await tabAChange).clientId, "browser:tab-a");
        assert.strictEqual((await tabBChange).clientId, "browser:tab-a");

        const stale = await sendJsonRequest(
          port,
          `/api/workspace-viewer/file?token=${token}`,
          "PUT",
          {
            path: "notes.txt",
            content: "tab B\n",
            baseModifiedAt: loaded.modifiedAt,
          },
          { "x-ctrlyoke-client-id": "tab-b" }
        );
        assert.strictEqual(stale.statusCode, 409);
        assert.strictEqual(fs.readFileSync(diskPath, "utf8"), "tab A\n");

        const externalTabAChange = nextWorkspaceFileChanged(tabA);
        const externalTabBChange = nextWorkspaceFileChanged(tabB);
        fs.writeFileSync(diskPath, "external\n");
        watcherFactory.fireChange(diskPath);
        assert.strictEqual((await externalTabAChange).path, "notes.txt");
        assert.strictEqual((await externalTabBChange).path, "notes.txt");
      } finally {
        tabA.close();
        tabB.close();
      }
    });
  });
});

suite("CtrlYokeHostedServer theme defaults", () => {
  async function withThemePage(
    theme: "auto" | "light" | "dark",
    query: string,
    inspect: (html: string, token: string) => void,
    capturedVars?: Record<string, string>
  ): Promise<void> {
    configService.setCliOverlay({ server: { theme } } as never);
    const token = "0123456789abcdef0123456789abcdef";
    const server = createHostedServer({ token });
    if (capturedVars) server.updateThemeVars(capturedVars);
    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      const port = Number(new URL(serverUrl).port);
      const page = await sendGetRequest(
        port,
        `/?token=${token}${query ? `&${query}` : ""}`
      );
      assert.strictEqual(page.statusCode, 200);
      inspect(page.body, token);
    } finally {
      server.dispose();
      configService.setCliOverlay({});
    }
  }

  test("auto serves both defaults for the browser color preference", async () => {
    await withThemePage("auto", "", (html) => {
      assert.ok(html.includes("@media (prefers-color-scheme: dark)"));
      assert.ok(html.includes("@media (prefers-color-scheme: light)"));
      assert.ok(html.includes("--theme-default: dark"));
      assert.ok(html.includes("--theme-default: light"));
      assert.ok(html.includes('<body class="vscode-dark"'));
    });
  });

  test("light and dark force one default theme", async () => {
    await withThemePage("light", "", (html) => {
      assert.ok(html.includes("--theme-default: light"));
      assert.ok(!html.includes("--theme-default: dark"));
      assert.ok(!html.includes("prefers-color-scheme"));
      assert.ok(html.includes('<body class="vscode-light"'));
    });
    await withThemePage("dark", "", (html) => {
      assert.ok(html.includes("--theme-default: dark"));
      assert.ok(!html.includes("--theme-default: light"));
      assert.ok(!html.includes("prefers-color-scheme"));
      assert.ok(html.includes('<body class="vscode-dark"'));
    });
  });

  test("valid query theme overrides the configured mode", async () => {
    await withThemePage("dark", "theme=light", (html) => {
      assert.ok(html.includes("--theme-default: light"));
      assert.ok(!html.includes("--theme-default: dark"));
      assert.ok(html.includes('<body class="vscode-light"'));
    });
  });

  test("captured vars override defaults and determine the body class", async () => {
    await withThemePage(
      "dark",
      "theme=light",
      (html) => {
        assert.ok(html.includes("--theme-default: light"));
        assert.ok(html.includes("--vscode-editor-background: #123456;"));
        assert.ok(html.includes('<body class="vscode-dark"'));
      },
      {
        "--vscode-editor-background": "#123456",
        "--cy-color-theme-kind": "dark",
      }
    );
  });

  test("high-contrast light emits both high-contrast body classes", async () => {
    await withThemePage(
      "dark",
      "",
      (html) => {
        assert.ok(
          html.includes(
            `<body class="${VSCODE_THEME_BODY_CLASSES.HIGH_CONTRAST} ${VSCODE_THEME_BODY_CLASSES.HIGH_CONTRAST_LIGHT}"`
          )
        );
      },
      { [THEME_KIND_CSS_VAR]: THEME_KINDS.HIGH_CONTRAST_LIGHT }
    );
    await withThemePage(
      "light",
      "",
      (html) => {
        assert.ok(
          html.includes(
            `<body class="${VSCODE_THEME_BODY_CLASSES.HIGH_CONTRAST}"`
          )
        );
      },
      { [THEME_KIND_CSS_VAR]: THEME_KINDS.HIGH_CONTRAST }
    );
  });
});

suite("CtrlYokeHostedServer WebSocket security", () => {
  async function withServer(
    testBody: (
      port: number,
      token: string,
      wasConnectionObserved: () => boolean
    ) => Promise<void>,
    routeClientMessage: (
      message: unknown,
      send: (reply: unknown) => void
    ) => Promise<void> = async () => undefined
  ): Promise<void> {
    const token = "0123456789abcdef0123456789abcdef";
    const workspaceRoot = makeTempDir("ctrlyoke-hosted-websocket-");
    let connectionObserved = false;
    const webviewProvider = {
      requestThemeCapture: () => {
        connectionObserved = true;
      },
      disconnectClient: () => undefined,
      routeClientMessage,
    };
    const server = createHostedServer({
      endpoint: webviewProvider as never,
      workspaceRoot,
      token,
    });
    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      await testBody(
        Number(new URL(serverUrl).port),
        token,
        () => connectionObserved
      );
    } finally {
      server.dispose();
      removeTempDir(workspaceRoot);
    }
  }

  function rejectedUpgradeStatus(url: string): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error("WebSocket upgrade was not refused"));
      }, 3000);
      ws.on("error", () => undefined);
      ws.on("unexpected-response", (_request, response) => {
        clearTimeout(timeout);
        response.resume();
        resolve(response.statusCode);
      });
      ws.on("open", () => {
        clearTimeout(timeout);
        ws.terminate();
        reject(new Error("WebSocket upgrade unexpectedly succeeded"));
      });
    });
  }

  test("refuses WebSocket upgrades without the correct token before connection", async () => {
    await withServer(async (port, token, wasConnectionObserved) => {
      const baseUrl = `ws://127.0.0.1:${port}/ws`;
      assert.strictEqual(await rejectedUpgradeStatus(baseUrl), 401);
      assert.strictEqual(
        await rejectedUpgradeStatus(`${baseUrl}?token=wrong-token`),
        401
      );
      assert.strictEqual(wasConnectionObserved(), false);

      const valid = new WebSocket(`${baseUrl}?token=${token}`);
      await new Promise<void>((resolve, reject) => {
        valid.once("open", resolve);
        valid.once("error", reject);
      });
      assert.strictEqual(wasConnectionObserved(), true);
      valid.close();
    });
  });

  test("routes LSP sockets separately and applies the same token check", async () => {
    await withServer(async (port, token, wasConnectionObserved) => {
      const baseUrl = `ws://127.0.0.1:${port}/ws/lsp?server=missing`;
      assert.strictEqual(await rejectedUpgradeStatus(baseUrl), 401);
      assert.strictEqual(
        await rejectedUpgradeStatus(`${baseUrl}&token=wrong-token`),
        401
      );
      assert.strictEqual(wasConnectionObserved(), false);

      const lsp = new WebSocket(`${baseUrl}&token=${token}`);
      await new Promise<void>((resolve, reject) => {
        lsp.once("open", resolve);
        lsp.once("error", reject);
      });
      const closeCode = await new Promise<number>((resolve) => {
        lsp.once("close", (code) => resolve(code));
      });
      assert.strictEqual(closeCode, 4404);
      assert.strictEqual(wasConnectionObserved(), false);
    });
  });

  test("token-gates language-server session lookup", async () => {
    await withServer(async (port, token) => {
      assert.strictEqual(
        (await sendGetRequest(port, "/api/lsp/session?path=src/main.ts"))
          .statusCode,
        401
      );
      const response = await sendGetRequest(
        port,
        `/api/lsp/session?path=src/main.ts&token=${token}`
      );
      assert.strictEqual(response.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(response.body), {
        session: null,
        reason: "no server",
      });
    });
  });

  test("closes a WebSocket that sends a frame over maxPayload", async () => {
    await withServer(async (port, token) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const closed = new Promise<number>((resolve) => {
        ws.once("close", (code) => resolve(code));
      });
      ws.send(Buffer.alloc(24 * 1024 * 1024 + 1));
      assert.strictEqual(await closed, 1009);
    });
  });

  test("compresses large dashboard messages with permessage-deflate", async () => {
    // Repetitive like run-view JSON, so a compressed frame is a small
    // fraction of the serialized size; an uncompressed one is the whole of it.
    const payload = JSON.stringify(
      Array.from({ length: 4000 }, (_, index) => ({
        type: "cliOutput",
        index,
        text: "tool call completed",
      }))
    );
    await withServer(
      async (port, token) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
        let upgradeSocket: import("net").Socket | undefined;
        ws.once("upgrade", (response) => {
          upgradeSocket = response.socket;
        });
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        assert.match(ws.extensions, /permessage-deflate/);

        const reply = new Promise<string>((resolve) => {
          ws.on("message", (data) => {
            const text = String(data);
            if (text.includes("largeReply")) resolve(text);
          });
        });
        ws.send(JSON.stringify({ type: "probe" }));
        const received = await reply;
        ws.close();

        assert.ok(received.length > payload.length);
        assert.ok(upgradeSocket, "upgrade socket was not captured");
        assert.ok(
          upgradeSocket.bytesRead < received.length / 4,
          `expected a compressed frame: read ${upgradeSocket.bytesRead} bytes for a ${received.length}-byte message`
        );
      },
      async (message, send) => {
        if ((message as { type?: unknown }).type === "probe") {
          send({ type: "largeReply", payload });
        }
      }
    );
  });
});

suite("hosted server URL logging", () => {
  test("masks the token in a hosted server URL", () => {
    const token = "hosted-server-log-secret";
    const masked = maskHostedServerUrlToken(
      `http://localhost:4747/?token=${token}`
    );

    assert.strictEqual(masked, "http://localhost:4747/?token=…");
    assert.ok(!masked.includes(token));
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
    const server = createHostedServer({ workspaceRoot: process.cwd(), token });
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
    const server = createHostedServer({ workspaceRoot: process.cwd(), token });
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
    const server = createHostedServer({ workspaceRoot: process.cwd(), token });
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
  test("rejects unauthenticated workspace file PUT before the JSON body finishes", async () => {
    const token = "unauthenticated-large-file-token";
    const workspaceRoot = makeTempDir("ctrlyoke-hosted-unauth-save-");
    const server = createHostedServer({ workspaceRoot, token });

    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      const url = new URL(serverUrl);
      const response = await new Promise<number | undefined>(
        (resolve, reject) => {
          const request = httpRequest(
            {
              hostname: "127.0.0.1",
              port: Number(url.port),
              path: "/api/workspace-viewer/file",
              method: "PUT",
              headers: {
                "content-type": "application/json",
                "content-length": 11 * 1024 * 1024,
              },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode));
            }
          );
          const timeout = setTimeout(
            () =>
              reject(new Error("Server waited for the unauthenticated body")),
            5000
          );
          request.on("error", () => {});
          request.on("close", () => clearTimeout(timeout));
          request.write('{"path":"large.txt","content":"');
        }
      );

      assert.strictEqual(response, 401);
      assert.strictEqual(
        fs.existsSync(path.join(workspaceRoot, "large.txt")),
        false
      );
    } finally {
      server.dispose();
      removeTempDir(workspaceRoot);
    }
  });

  test("saves a 1 MB workspace viewer file", async () => {
    const token = "large-file-save-token";
    const workspaceRoot = makeTempDir("ctrlyoke-hosted-large-save-");
    const server = createHostedServer({ workspaceRoot, token });

    try {
      const serverUrl = await server.listen();
      if (!serverUrl) throw new Error("Hosted server did not start");
      const url = new URL(serverUrl);
      const content = "a".repeat(1024 * 1024);
      const response = await sendJsonRequest(
        Number(url.port),
        `/api/workspace-viewer/file?token=${encodeURIComponent(token)}`,
        "PUT",
        { path: "large.txt", content, baseModifiedAt: null }
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
    const server = createHostedServer({ workspaceRoot: process.cwd(), token });

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
      createHostedHarnessStatusUpdate(HARNESS_IDS.CODEX_CLI, {
        available: true,
        installHint: codexInstallHint,
      }),
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

  test("carries the version assessment so the dashboard can show update guidance", () => {
    const version = {
      status: HARNESS_VERSION_STATUSES.UNSUPPORTED,
      installedVersion: "0.100.0",
      minimumVersion: "0.119.0",
      recommendedVersion: "0.157.0",
      updateCommand: "codex update",
    };
    const update = createHostedHarnessStatusUpdate(HARNESS_IDS.CODEX_CLI, {
      available: false,
      installHint: codexInstallHint,
      version,
    });
    assert.deepStrictEqual(update.data.harnessStatus[HARNESS_IDS.CODEX_CLI], {
      available: false,
      status: HARNESS_STATUS_STRINGS.UNAVAILABLE,
      installHint: codexInstallHint,
      version,
    });
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
  publicUrl?: string;
  webPushService: {
    sendNotification(event: unknown): Promise<{
      sent: number;
      removed: number;
      failed: number;
    }>;
  };
  broadcast(message: unknown): void;
  broadcastUserFeedback(message: unknown): void;
  dispatchCompletionNotification(
    event: CtrlYokeNotificationEvent | undefined
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

  test("adds the authenticated public URL to hook event broadcast and push", async () => {
    let broadcastPayload: unknown;
    let pushedEvent: unknown;
    const server = Object.create(
      CtrlYokeHostedServer.prototype
    ) as HostedServerFeedbackInternals;
    server.connections = new Set();
    server.notifiedEventIds = new Set();
    server.publicUrl = "http://localhost:4312/?token=secret-token";
    server.broadcast = (message) => {
      broadcastPayload = message;
    };
    server.webPushService = {
      async sendNotification(event) {
        pushedEvent = event;
        return { sent: 1, removed: 0, failed: 0 };
      },
    };

    const artifact: HookArtifact = {
      runId: "run-1",
      timestamp: 123,
      workflowId: "wf-hook",
      workflowName: "Workflow",
      promptIndex: 1,
      promptName: "Prompt",
      hookEvent: "notification",
      nativeHookEvent: "Notification",
      harnessId: "claude-cli",
      rawHookData: {},
    };
    const notificationSettings = {
      ...CTRLYOKE_SETTINGS_DEFAULTS.notifications,
      events: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events,
        hookEvents: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.notifications.events.hookEvents,
          notification: true,
        },
      },
    };
    const event = buildHookNotificationEvent(artifact, notificationSettings);
    assert.ok(event);
    assert.strictEqual(event.url, undefined);

    try {
      configService.setCliOverlay({
        notifications: { browser: { mode: BROWSER_NOTIFICATION_MODES.PUSH } },
      });
      await server.dispatchCompletionNotification(event);

      const broadcastEvent = (broadcastPayload as { event: { url?: string } })
        .event;
      assert.strictEqual(broadcastEvent.url, server.publicUrl);
      assert.deepStrictEqual(pushedEvent, broadcastEvent);
    } finally {
      configService.setCliOverlay({});
    }
  });
});
