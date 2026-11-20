import * as assert from "assert";
import { suite, test } from "mocha";
import { AcpJsonRpcClient } from "../../core/harness/shared/AcpJsonRpcClient";
import type { ControlWriter } from "../../core/harness/shared/IHeadlessControlChannel";

suite("AcpJsonRpcClient", () => {
  test("frames chunked JSONL and correlates requests", async () => {
    const writes: string[] = [];
    const client = new AcpJsonRpcClient();
    const writer: ControlWriter = {
      async write(text) {
        writes.push(text);
      },
      async end() {},
    };
    client.start(writer);

    const request = client.request("initialize", { protocolVersion: 1 });
    await request.sent;
    assert.deepStrictEqual(JSON.parse(writes[0]), {
      jsonrpc: "2.0",
      id: request.id,
      method: "initialize",
      params: { protocolVersion: 1 },
    });

    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { protocolVersion: 1 },
    });
    assert.deepStrictEqual(client.receiveChunk(response.slice(0, 12)), []);
    assert.deepStrictEqual(client.receiveChunk(`${response.slice(12)}\n`), [
      {
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: 1 },
      },
    ]);
    assert.deepStrictEqual(await request.result, { protocolVersion: 1 });
    client.close();
  });

  test("replies to server-initiated requests and flushes an unterminated record", async () => {
    const writes: string[] = [];
    const client = new AcpJsonRpcClient();
    client.start({
      async write(text) {
        writes.push(text);
      },
      async end() {},
    });

    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: { options: [] },
    });
    assert.deepStrictEqual(client.receiveChunk(request), []);
    const messages = client.receiveChunk("", true);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].method, "session/request_permission");

    await client.respond("permission-1", {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    assert.deepStrictEqual(JSON.parse(writes[0]), {
      jsonrpc: "2.0",
      id: "permission-1",
      result: {
        outcome: { outcome: "selected", optionId: "allow-once" },
      },
    });
    client.close();
  });
});
