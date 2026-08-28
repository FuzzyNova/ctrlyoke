import * as assert from "assert";
import { EventEmitter } from "events";
import { createServer as createHttpServer, Server as HttpServer } from "http";
import * as fs from "fs";
import { suite, test } from "mocha";
import * as os from "os";
import * as path from "path";
import { DashboardBroadcastHub } from "../../ui/DashboardBroadcastHub";
import { CtrlYokeHostedServer } from "../../server/CtrlYokeHostedServer";
import * as BuildConfig from "../../utils/BuildConfig";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

/**
 * Minimal stand-in for Node's http.Server, driving the same
 * error/listening event sequence CtrlYokeHostedServer.listen() reacts to.
 * `failOnPort` simulates EADDRINUSE for exactly one requested port (the
 * "configured port is already taken" case); any other port — including the
 * `0` retry — succeeds and reports `boundPort` from address().
 */
class FakeHttpServer extends EventEmitter {
  listenCalls: number[] = [];

  constructor(
    private readonly failOnPort: number | null,
    private readonly boundPort: number
  ) {
    super();
  }

  listen(port: number, _bindAddress: string): void {
    this.listenCalls.push(port);
    if (this.failOnPort !== null && port === this.failOnPort) {
      queueMicrotask(() => {
        const err = new Error("address in use") as NodeJS.ErrnoException;
        err.code = "EADDRINUSE";
        this.emit("error", err);
      });
    } else {
      queueMicrotask(() => this.emit("listening"));
    }
  }

  address(): { port: number } {
    return { port: this.boundPort };
  }
}

interface HostedServerListenInternals {
  httpServer: FakeHttpServer;
  port: number;
  bindAddress: string;
  isTls: boolean;
  token: string;
  workspaceRoot: string;
  availableIps: string[];
  getRemoteAccess?: () => Promise<boolean>;
  onRemoteAccessBlocked?: () => void;
  remoteAccessUpsellShown: boolean;
  listen(): Promise<string>;
  getPortFallbackInfo(): { requestedPort: number; actualPort: number } | null;
}

function createListenHarness(
  requestedPort: number,
  fakeHttpServer: FakeHttpServer
): HostedServerListenInternals {
  const server = Object.create(
    CtrlYokeHostedServer.prototype
  ) as HostedServerListenInternals;
  server.httpServer = fakeHttpServer;
  server.port = requestedPort;
  server.bindAddress = "127.0.0.1";
  server.isTls = false;
  server.token = "test-token";
  server.workspaceRoot = process.cwd();
  server.availableIps = [];
  server.remoteAccessUpsellShown = false;
  return server;
}

function listenHttpServer(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("HTTP test server did not receive a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function createHostedServer(
  port: number,
  token: string,
  onSiblingServerDetected?: (url: string) => void,
  workspaceRoot = process.cwd()
): CtrlYokeHostedServer {
  return new CtrlYokeHostedServer(
    new DashboardBroadcastHub(),
    {} as never,
    (() => ({})) as never,
    port,
    workspaceRoot,
    [],
    token,
    "127.0.0.1",
    undefined,
    onSiblingServerDetected
  );
}

function devServerUrlFilePath(workspaceRoot: string): string {
  return path.join(
    workspaceRoot,
    PATH_CONSTANTS.CTRLYOKE_DIR,
    PATH_CONSTANTS.DEV_DIR,
    PATH_CONSTANTS.SERVER_URL_FILE
  );
}

function setDevMode(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(BuildConfig, "IS_DEV_MODE");
  Object.defineProperty(BuildConfig, "IS_DEV_MODE", {
    configurable: true,
    value,
  });
  return () => {
    if (original) Object.defineProperty(BuildConfig, "IS_DEV_MODE", original);
  };
}

suite("CtrlYokeHostedServer.listen port fallback", () => {
  test("retries on port 0 and records fallback info when the configured port is taken", async () => {
    const fakeHttpServer = new FakeHttpServer(4747, 51234);
    const server = createListenHarness(4747, fakeHttpServer);

    const url = await server.listen();

    assert.deepStrictEqual(fakeHttpServer.listenCalls, [4747, 0]);
    assert.strictEqual(server.port, 51234);
    assert.ok(url.includes(":51234/"));
    assert.deepStrictEqual(server.getPortFallbackInfo(), {
      requestedPort: 4747,
      actualPort: 51234,
    });
  });

  test("reports no fallback when the configured port binds on the first try", async () => {
    const fakeHttpServer = new FakeHttpServer(null, 4747);
    const server = createListenHarness(4747, fakeHttpServer);

    const url = await server.listen();

    assert.deepStrictEqual(fakeHttpServer.listenCalls, [4747]);
    assert.strictEqual(server.port, 4747);
    assert.ok(url.includes(":4747/"));
    assert.strictEqual(server.getPortFallbackInfo(), null);
  });

  test("coerces a non-loopback bind to localhost when remote access is gated", async () => {
    const fakeHttpServer = new FakeHttpServer(null, 4747);
    const server = createListenHarness(4747, fakeHttpServer);
    server.bindAddress = "0.0.0.0";
    let blocked = 0;
    server.getRemoteAccess = async () => false;
    server.onRemoteAccessBlocked = () => {
      blocked += 1;
    };

    await server.listen();

    assert.strictEqual(server.bindAddress, "127.0.0.1");
    assert.deepStrictEqual(fakeHttpServer.listenCalls, [4747]);
    assert.strictEqual(blocked, 1);
  });

  test("falls back to an OS-assigned port when occupied by a sibling ctrlyoke server, and reports it", async () => {
    const token = "sibling-server-token";
    const sibling = createHostedServer(0, token);
    let second: CtrlYokeHostedServer | undefined;
    let detectedUrl: string | undefined;
    try {
      const siblingUrl = await sibling.listen();
      if (!siblingUrl) throw new Error("Sibling server did not start");

      const siblingPort = Number(new URL(siblingUrl).port);
      second = createHostedServer(siblingPort, token, (url) => {
        detectedUrl = url;
      });

      const secondUrl = await second.listen();

      if (!secondUrl)
        throw new Error("Second instance did not start its own server");
      assert.strictEqual(detectedUrl, siblingUrl);
      assert.notStrictEqual(Number(new URL(secondUrl).port), siblingPort);
      assert.deepStrictEqual(second.getPortFallbackInfo(), {
        requestedPort: siblingPort,
        actualPort: Number(new URL(secondUrl).port),
      });
    } finally {
      second?.dispose();
      sibling.dispose();
    }
  });

  test("writes its own URL to the dev file when a sibling is detected in dev mode", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-hosted-server-")
    );
    const token = "sibling-server-token";
    const sibling = createHostedServer(0, token, undefined, workspaceRoot);
    let second: CtrlYokeHostedServer | undefined;
    const restoreDevMode = setDevMode(true);
    try {
      const siblingUrl = await sibling.listen();
      if (!siblingUrl) throw new Error("Sibling server did not start");

      const urlFile = devServerUrlFilePath(workspaceRoot);
      fs.rmSync(urlFile, { force: true });
      second = createHostedServer(
        Number(new URL(siblingUrl).port),
        token,
        undefined,
        workspaceRoot
      );

      const secondUrl = await second.listen();
      if (!secondUrl)
        throw new Error("Second instance did not start its own server");
      assert.notStrictEqual(secondUrl, siblingUrl);
      assert.strictEqual(fs.readFileSync(urlFile, "utf8"), `${secondUrl}\n`);

      second.dispose();
      assert.strictEqual(fs.existsSync(urlFile), false);
    } finally {
      second?.dispose();
      restoreDevMode();
      sibling.dispose();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("does not write a dev URL file outside dev mode, even after a sibling detection", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-hosted-server-")
    );
    const token = "sibling-server-token";
    const sibling = createHostedServer(0, token, undefined, workspaceRoot);
    let second: CtrlYokeHostedServer | undefined;
    const restoreDevMode = setDevMode(false);
    try {
      const siblingUrl = await sibling.listen();
      if (!siblingUrl) throw new Error("Sibling server did not start");

      second = createHostedServer(
        Number(new URL(siblingUrl).port),
        token,
        undefined,
        workspaceRoot
      );

      const secondUrl = await second.listen();
      if (!secondUrl)
        throw new Error("Second instance did not start its own server");
      assert.strictEqual(
        fs.existsSync(devServerUrlFilePath(workspaceRoot)),
        false
      );
    } finally {
      second?.dispose();
      restoreDevMode();
      sibling.dispose();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("falls back when the occupied port responds as an unrelated process", async () => {
    const unrelated = createHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          workspaceRoot: process.cwd(),
          isGitRepo: true,
          files: "not-an-array",
        })
      );
    });
    let server: CtrlYokeHostedServer | undefined;
    let detectedSibling = false;
    try {
      const occupiedPort = await listenHttpServer(unrelated);
      server = createHostedServer(
        occupiedPort,
        "unrelated-process-token",
        () => {
          detectedSibling = true;
        }
      );

      const url = await server.listen();

      if (!url)
        throw new Error("Unrelated process incorrectly claimed as ctrlyoke");
      assert.strictEqual(detectedSibling, false);
      assert.notStrictEqual(Number(new URL(url).port), occupiedPort);
      assert.deepStrictEqual(server.getPortFallbackInfo(), {
        requestedPort: occupiedPort,
        actualPort: Number(new URL(url).port),
      });
    } finally {
      server?.dispose();
      await closeHttpServer(unrelated);
    }
  });
});
