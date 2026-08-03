import { strict as assert } from "assert";
import { suite, test } from "mocha";
import { StreamChunkCoalescer } from "../../utils/StreamChunkCoalescer";

/** Lets the pending flush timer fire. */
function afterInterval(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("StreamChunkCoalescer", () => {
  test("joins chunks appended within the flush interval into one release", async () => {
    const flushed: string[] = [];
    const coalescer = new StreamChunkCoalescer((chunk) => flushed.push(chunk), {
      flushIntervalMs: 20,
    });

    coalescer.append("a");
    coalescer.append("b");
    coalescer.append("c");
    assert.deepStrictEqual(flushed, [], "nothing releases synchronously");

    await afterInterval(60);
    assert.deepStrictEqual(flushed, ["abc"]);
  });

  test("starts a new interval for chunks arriving after a flush", async () => {
    const flushed: string[] = [];
    const coalescer = new StreamChunkCoalescer((chunk) => flushed.push(chunk), {
      flushIntervalMs: 20,
    });

    coalescer.append("first");
    await afterInterval(60);
    coalescer.append("second");
    await afterInterval(60);

    assert.deepStrictEqual(flushed, ["first", "second"]);
  });

  test("releases immediately once the buffered size cap is reached", () => {
    const flushed: string[] = [];
    const coalescer = new StreamChunkCoalescer((chunk) => flushed.push(chunk), {
      flushIntervalMs: 10_000,
      maxBufferedChars: 8,
    });

    coalescer.append("1234");
    assert.deepStrictEqual(flushed, []);
    coalescer.append("5678");
    assert.deepStrictEqual(
      flushed,
      ["12345678"],
      "cap must not wait out the interval"
    );
  });

  test("flush releases the buffered tail and cancels the pending timer", async () => {
    const flushed: string[] = [];
    const coalescer = new StreamChunkCoalescer((chunk) => flushed.push(chunk), {
      flushIntervalMs: 20,
    });

    coalescer.append("tail");
    assert.strictEqual(coalescer.hasPending(), true);
    coalescer.flush();

    assert.deepStrictEqual(flushed, ["tail"]);
    assert.strictEqual(coalescer.hasPending(), false);

    await afterInterval(60);
    assert.deepStrictEqual(flushed, ["tail"], "the timer must not re-release");
  });

  test("flush and empty appends are no-ops when nothing is buffered", async () => {
    const flushed: string[] = [];
    const coalescer = new StreamChunkCoalescer((chunk) => flushed.push(chunk), {
      flushIntervalMs: 20,
    });

    coalescer.flush();
    coalescer.append("");
    await afterInterval(60);

    assert.deepStrictEqual(flushed, []);
  });
});
