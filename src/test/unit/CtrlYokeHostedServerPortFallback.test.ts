import * as assert from "assert";
import { EventEmitter } from "events";
import { suite, test } from "mocha";
import { CtrlYokeHostedServer } from "../../server/CtrlYokeHostedServer";

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
  availableIps: string[];
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
  server.availableIps = [];
  return server;
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
});
