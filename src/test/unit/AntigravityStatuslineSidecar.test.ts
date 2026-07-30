import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { AntigravityLogParser } from "../../core/harness/antigravity/AntigravityLogParser";
import { AntigravityStatuslineSidecar } from "../../core/harness/antigravity/AntigravityStatuslineSidecar";

suite("AntigravityStatuslineSidecar", () => {
  let tempDirectory: string;
  let sidecar: AntigravityStatuslineSidecar | undefined;

  setup(async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-agy-sidecar-")
    );
  });

  teardown(async () => {
    sidecar?.stop();
    sidecar = undefined;
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  function snapshot(sequence: number, writtenAt: number) {
    return {
      conversation_id: "conversation-1",
      model: { id: "gemini-test" },
      context_window: {
        total_input_tokens: 120,
        total_output_tokens: 30,
        context_window_size: 1_000,
        current_usage: { input_tokens: 120, output_tokens: 30 },
      },
      _ctrlyoke: { sequence, writtenAt },
    };
  }

  async function writeSnapshot(value: unknown): Promise<void> {
    await fs.writeFile(
      path.join(tempDirectory, "agy-statusline-token.json"),
      JSON.stringify(value)
    );
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("Timed out waiting for sidecar callback");
  }

  test("maps new snapshots to live context updates and exposes the raw payload", async () => {
    const updates: Array<{ used: number; size: number }> = [];
    const snapshotPath = path.join(tempDirectory, "agy-statusline-token.json");
    sidecar = new AntigravityStatuslineSidecar({
      snapshotPath,
      model: "resolved-model",
      parser: new AntigravityLogParser(),
      onContextWindowUpdate: (used, size) => updates.push({ used, size }),
    });

    const first = snapshot(1, 100);
    await writeSnapshot(first);
    await waitFor(() => updates.length === 1);
    assert.deepStrictEqual(updates[0], { used: 150, size: 1_000 });
    assert.strictEqual(
      sidecar.getLatestSnapshot()?.conversation_id,
      "conversation-1"
    );

    await writeSnapshot(first);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(updates.length, 1);

    await writeSnapshot({
      ...first,
      context_window: {
        ...first.context_window,
        total_output_tokens: 40,
      },
      _ctrlyoke: { sequence: 2, writtenAt: 200 },
    });
    await waitFor(() => updates.length === 2);
    assert.deepStrictEqual(updates[1], { used: 160, size: 1_000 });
  });

  test("ignores malformed snapshots and stops all further callbacks", async () => {
    const updates: Array<{ used: number; size: number }> = [];
    const snapshotPath = path.join(tempDirectory, "agy-statusline-token.json");
    sidecar = new AntigravityStatuslineSidecar({
      snapshotPath,
      model: "resolved-model",
      parser: new AntigravityLogParser(),
      onContextWindowUpdate: (used, size) => updates.push({ used, size }),
    });

    await fs.writeFile(snapshotPath, "{ malformed");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(updates.length, 0);

    await writeSnapshot(snapshot(1, 100));
    await waitFor(() => updates.length === 1);

    sidecar.stop();
    await writeSnapshot(snapshot(2, 200));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(updates.length, 1);
  });
});
