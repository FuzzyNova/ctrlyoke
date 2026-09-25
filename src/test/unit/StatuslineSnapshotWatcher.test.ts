import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { StatuslineSnapshotWatcher } from "../../core/harness/shared/StatuslineSnapshotWatcher";
import { STATUSLINE_SNAPSHOT_PROTOCOL_VERSION } from "../../utils/StatuslineFormat";

suite("StatuslineSnapshotWatcher", () => {
  let tempDirectory: string;
  let snapshotPath: string;
  let watcher: StatuslineSnapshotWatcher<Record<string, unknown>> | undefined;

  setup(async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-snapshot-watcher-")
    );
    snapshotPath = path.join(tempDirectory, "claude-statusline-token.json");
  });

  teardown(async () => {
    watcher?.stop();
    watcher = undefined;
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function readWith(
    metadata: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    await fs.writeFile(
      snapshotPath,
      JSON.stringify({ model: { id: "m" }, _ctrlyoke: metadata })
    );
    watcher = new StatuslineSnapshotWatcher({ snapshotPath });
    return watcher.readLatestSnapshot();
  }

  test("accepts the current protocol version", async () => {
    const snapshot = await readWith({
      protocolVersion: STATUSLINE_SNAPSHOT_PROTOCOL_VERSION,
      sequence: 1,
      writtenAt: 100,
    });
    assert.ok(snapshot);
  });

  test("accepts snapshots from scripts that predate the version field", async () => {
    assert.ok(await readWith({ sequence: 1, writtenAt: 100 }));
  });

  test("ignores a snapshot from a different protocol version", async () => {
    const snapshot = await readWith({
      protocolVersion: STATUSLINE_SNAPSHOT_PROTOCOL_VERSION + 1,
      sequence: 1,
      writtenAt: 100,
    });
    assert.strictEqual(snapshot, undefined);
  });
});
