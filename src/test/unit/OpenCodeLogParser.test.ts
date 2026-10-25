import * as assert from "assert";
import { suite, test } from "mocha";
import { OpenCodeLogParser } from "../../core/harness/opencode/OpenCodeLogParser";

suite("OpenCodeLogParser polling", () => {
  test("waits for each export to settle and close stops future polls", async () => {
    let activeExports = 0;
    let maxActiveExports = 0;
    let exportCount = 0;
    const pending: Array<() => void> = [];
    const parser = new OpenCodeLogParser(undefined, async () => {
      exportCount++;
      activeExports++;
      maxActiveExports = Math.max(maxActiveExports, activeExports);
      await new Promise<void>((resolve) => pending.push(resolve));
      activeExports--;
      return JSON.stringify({ info: { id: "session" }, messages: [] });
    });
    const watcher = parser.watchLogFile("session", () => {}, new Date(0));
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(predicate(), "timed out waiting for export poll");
    };

    try {
      await waitFor(() => exportCount === 1);
      pending.shift()?.();
      await waitFor(() => exportCount === 2);
      assert.strictEqual(maxActiveExports, 1);
      watcher.close();
      pending.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.strictEqual(exportCount, 2);
      assert.strictEqual(maxActiveExports, 1);
    } finally {
      watcher.close();
      pending.forEach((resolve) => resolve());
    }
  });
});
