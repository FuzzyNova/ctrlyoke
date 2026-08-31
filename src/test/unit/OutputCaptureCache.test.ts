import * as assert from "assert";
import { suite, test } from "mocha";
import {
  OutputCaptureCache,
  type OutputCaptureEntry,
} from "../../completions/OutputCaptureCache";

function entry(text: string): OutputCaptureEntry {
  return { text, channel: "agenthost", range: { startLine: 1, endLine: 2 } };
}

suite("OutputCaptureCache", () => {
  test("returns a set entry once", () => {
    const cache = new OutputCaptureCache();
    const capture = entry("captured output");

    cache.set("capture-1", capture);

    assert.deepStrictEqual(cache.take("capture-1"), capture);
    assert.strictEqual(cache.take("capture-1"), undefined);
  });

  test("evicts the oldest entry when the cap is exceeded", () => {
    const cache = new OutputCaptureCache();

    for (let i = 0; i < 201; i++) {
      cache.set(`capture-${i}`, entry(String(i)));
    }

    assert.strictEqual(cache.take("capture-0"), undefined);
    assert.deepStrictEqual(cache.take("capture-200"), entry("200"));
  });
});
