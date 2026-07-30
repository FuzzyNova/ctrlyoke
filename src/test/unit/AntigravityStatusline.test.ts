import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";

// Scripts are copied verbatim to out/scripts by esbuild; tests run from
// out/test, so this path deliberately resolves against the compiled layout.
const statusline = require(
  path.resolve(__dirname, "../../scripts/ctrlyoke-antigravity-statusline.js")
) as {
  parsePayload(input: string): Record<string, unknown>;
  buildSnapshotPayload(
    payload: Record<string, unknown>,
    writtenAt: number
  ): Record<string, unknown>;
  writeSnapshot(
    directory: string,
    token: string,
    payload: Record<string, unknown>,
    writtenAt?: number
  ): string | undefined;
  formatCompactTokenCount(value: number): string;
  calculateContextPercentage(used: number, size: number): number;
  getContextBand(percentage: number): string;
  formatBrandedStatusLine(payload: Record<string, unknown>): string;
};

suite("Antigravity statusline script", () => {
  let tempDirectory: string;

  teardown(async () => {
    if (tempDirectory) {
      await fs.rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = "";
    }
  });

  test("shapes a payload with watcher metadata and writes it atomically", async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-statusline-test-")
    );
    const payload = { model: { id: "test-model" }, agent_state: "idle" };
    const snapshot = statusline.buildSnapshotPayload(payload, 1234);

    assert.deepStrictEqual(snapshot.model, payload.model);
    assert.strictEqual(
      (snapshot._ctrlyoke as { writtenAt: number }).writtenAt,
      1234
    );
    assert.strictEqual(
      typeof (snapshot._ctrlyoke as { sequence: unknown }).sequence,
      "number"
    );

    const snapshotPath = statusline.writeSnapshot(
      tempDirectory,
      "token-1",
      payload,
      5678
    );
    assert.ok(snapshotPath);
    const writtenSnapshot = JSON.parse(
      await fs.readFile(snapshotPath!, "utf8")
    ) as Record<string, unknown>;
    assert.deepStrictEqual(writtenSnapshot.model, { id: "test-model" });
    assert.strictEqual(writtenSnapshot.agent_state, "idle");
    assert.strictEqual(
      (writtenSnapshot._ctrlyoke as { writtenAt: number }).writtenAt,
      5678
    );
    assert.strictEqual(
      typeof (writtenSnapshot._ctrlyoke as { sequence: unknown }).sequence,
      "number"
    );
    assert.deepStrictEqual(await fs.readdir(tempDirectory), [
      "agy-statusline-token-1.json",
    ]);
  });

  test("compacts token counts and calculates the context percentage", () => {
    assert.strictEqual(statusline.formatCompactTokenCount(999), "999");
    assert.strictEqual(statusline.formatCompactTokenCount(12_400), "12.4k");
    assert.strictEqual(statusline.formatCompactTokenCount(1_000_000), "1.0M");
    assert.strictEqual(
      statusline.calculateContextPercentage(12_400, 1_000_000),
      1.24
    );
    assert.strictEqual(statusline.getContextBand(69.9), "neutral");
    assert.strictEqual(statusline.getContextBand(70), "warning");
    assert.strictEqual(statusline.getContextBand(85), "danger");
  });

  test("formats the branded line with ANSI context bands and quota", () => {
    const line = statusline.formatBrandedStatusLine({
      model: { id: "gemini-test" },
      context_window: {
        total_input_tokens: 12_000,
        total_output_tokens: 400,
        context_window_size: 1_000_000,
      },
      quota: { weekly: { remaining_fraction: 0.98 } },
      agent_state: "idle",
    });

    assert.match(line, /ctrlyoke ⚡ gemini-test/);
    assert.match(line, /12\.4k\/1\.0M ctx \(1\.2%\)/);
    assert.match(line, /quota 98% · idle/);
    assert.match(line, /\u001b\[36m/);
  });

  test("handles malformed and empty payloads without throwing", () => {
    assert.deepStrictEqual(statusline.parsePayload(""), {});
    assert.deepStrictEqual(statusline.parsePayload("not json"), {});
    assert.deepStrictEqual(statusline.parsePayload("[]"), {});
    assert.match(
      statusline.formatBrandedStatusLine(statusline.parsePayload("")),
      /^ctrlyoke ⚡ unknown-model · .* · quota — · unknown$/
    );
  });
});
