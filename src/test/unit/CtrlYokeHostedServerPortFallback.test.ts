import * as assert from "assert";
import { EventEmitter } from "events";
import { createServer as createHttpServer, Server as HttpServer } from "http";
import * as fs from "fs";
import { suite, test } from "mocha";
import * as path from "path";
import { DashboardBroadcastHub } from "../../ui/DashboardBroadcastHub";
import { CtrlYokeHostedServer } from "../../server/CtrlYokeHostedServer";
import * as BuildConfig from "../../utils/BuildConfig";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

interface FakeHttpServerPort {
  listen(port: number, bindAddress: string): void;
  address(): { port: number };
}

/**
 * Minimal stand-in for Node's http.Server, driving the same
 * error/listening event sequence CtrlYokeHostedServer.listen() reacts to.
 * `failOnPorts` simulates EADDRINUSE for each requested port in the set (the
 * "this port is already taken" case, which may include one or more
 * configured fallback ports); any other port — including the final `0`
 * retry — succeeds and reports `boundPort` from address().
 */
class FakeHttpServer
  extends EventEmitter
  implements FakeHttpServerPort
{
  listenCalls: number[] = [];
  private readonly failOnPorts: Set<number>;

  constructor(
    failOnPorts: number | number[] | null,
    private readonly boundPort: number
  ) {
    super();
    this.failOnPorts = new Set(
      failOnPorts === null
        ? []
        : Array.isArray(failOnPorts)
          ? failOnPorts
          : [failOnPorts]
    );
  }

  listen(port: number, _bindAddress: string): void {
    this.listenCalls.push(port);
    if (this.failOnPorts.has(port)) {
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
  fallbackPorts: number[];
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
  getBindAddressFallbackInfo(): {
    requestedBindAddress: string;
    actualBindAddress: string;
  } | null;
}

function createListenHarness(
  requestedPort: number,
  fakeHttpServer: FakeHttpServer,
  fallbackPorts: number[] = []
): HostedServerListenInternals {
  const server = Object.create(
    CtrlYokeHostedServer.prototype
  ) as HostedServerListenInternals;
  server.httpServer = fakeHttpServer;
  server.port = requestedPort;
  server.fallbackPorts = fallbackPorts;
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
  workspaceRoot = process.cwd(),
  fallbackPorts: number[] = []
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
    onSiblingServerDetected,
    undefined,
    undefined,
    undefined,
    fallbackPorts
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

  test("tries configured fallback ports in order before an OS-assigned port", async () => {
    // The first fallback (4749) is also taken; the second (4750) succeeds.
    const fakeHttpServer = new FakeHttpServer([4747, 4749], 4750);
    const server = createListenHarness(4747, fakeHttpServer, [4749, 4750]);

    const url = await server.listen();

    assert.deepStrictEqual(fakeHttpServer.listenCalls, [4747, 4749, 4750]);
    assert.strictEqual(server.port, 4750);
    assert.ok(url.includes(":4750/"));
    assert.deepStrictEqual(server.getPortFallbackInfo(), {
      requestedPort: 4747,
      actualPort: 4750,
    });
  });

  test("lands on the first configured fallback port when it is free", async () => {
    const fakeHttpServer = new FakeHttpServer(4747, 4749);
    const server = createListenHarness(4747, fakeHttpServer, [4749, 4750]);

    const url = await server.listen();

    assert.deepStrictEqual(fakeHttpServer.listenCalls, [4747, 4749]);
    assert.strictEqual(server.port, 4749);
    assert.ok(url.includes(":4749/"));
    assert.deepStrictEqual(server.getPortFallbackInfo(), {
      requestedPort: 4747,
      actualPort: 4749,
    });
  });

  test("falls back to an OS-assigned port when every configured fallback is taken too", async () => {
    const fakeHttpServer = new FakeHttpServer([4747, 4749, 4750], 51234);
    const server = createListenHarness(4747, fakeHttpServer, [4749, 4750]);

    const url = await server.listen();

    assert.deepStrictEqual(fakeHttpServer.listenCalls, [4747, 4749, 4750, 0]);
    assert.strictEqual(server.port, 51234);
    assert.ok(url.includes(":51234/"));
    assert.deepStrictEqual(server.getPortFallbackInfo(), {
      requestedPort: 4747,
      actualPort: 51234,
    });
  });

  test("does not retry the configured port a second time if it also appears in fallbackPorts", async () => {
    const fakeHttpServer = new FakeHttpServer([4747], 4749);
    const server = createListenHarness(4747, fakeHttpServer, [4747, 4749]);

    const url = await server.listen();

    assert.deepStrictEqual(fakeHttpServer.listenCalls, [4747, 4749]);
    assert.strictEqual(server.port, 4749);
    assert.ok(url.includes(":4749/"));
  });

  test("reports no fallback when the configured port binds on the first try", async () => {
    const fakeHttpServer = new FakeHttpServer(null, 4747);
    const server = createListenHarness(4747, fakeHttpServer);

    const url = await server.listen();

    assert.deepStrictEqual(fakeHttpServer.listenCalls, [4747]);
    assert.strictEqual(server.port, 4747);
    assert.ok(url.includes(":4747/"));
    assert.strictEqual(server.getPortFallbackInfo(), null);
    assert.strictEqual(server.getBindAddressFallbackInfo(), null);
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
    assert.deepStrictEqual(server.getBindAddressFallbackInfo(), {
      requestedBindAddress: "0.0.0.0",
      actualBindAddress: "127.0.0.1",
    });
    // The requested value is retained in the fallback info; the settings file
    // is never rewritten when the in-memory listener is coerced.
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
    const workspaceRoot = makeTempDir("ctrlyoke-hosted-server-");
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
      removeTempDir(workspaceRoot);
    }
  });

  test("does not write a dev URL file outside dev mode, even after a sibling detection", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-hosted-server-");
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
      removeTempDir(workspaceRoot);
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
