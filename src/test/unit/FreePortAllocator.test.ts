import * as assert from "assert";
import { suite, test } from "mocha";
import { allocateLoopbackPort } from "../../utils/FreePortAllocator";

suite("FreePortAllocator", () => {
  test("resolves an available port in the normal TCP range", async () => {
    const port = await allocateLoopbackPort();

    assert.ok(port >= 1 && port <= 65535);
  });

  test("allocates distinct ports for concurrent calls", async () => {
    const ports = await Promise.all(
      Array.from({ length: 8 }, () => allocateLoopbackPort())
    );

    assert.strictEqual(new Set(ports).size, ports.length);
  });
});
