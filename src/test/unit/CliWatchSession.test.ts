import * as assert from "assert";
import * as path from "path";
import { suite, test } from "mocha";
import {
  getHistoryRunTimestamp,
  isNewerHistoryRunPath,
} from "../../core/orchestration/CliWatchSession";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";

suite("CliWatchSession run selection helpers", () => {
  test("extracts run timestamps from legacy files, timeline manifests, and run directories", () => {
    const legacyRunPath = path.join(
      "history",
      "wf-cli-watch",
      "run-9-2026-03-31T10-00-00-000Z.json"
    );
    const timelineManifestPath = path.join(
      "history",
      "wf-cli-watch",
      "run-10-2026-03-31T11-00-00-000Z",
      TimelineRecorder.MANIFEST_FILE_NAME
    );
    const timelineRunDirectory = path.dirname(timelineManifestPath);

    assert.strictEqual(
      getHistoryRunTimestamp(legacyRunPath),
      Date.parse("2026-03-31T10:00:00.000Z")
    );
    assert.strictEqual(
      getHistoryRunTimestamp(timelineManifestPath),
      Date.parse("2026-03-31T11:00:00.000Z")
    );
    assert.strictEqual(
      getHistoryRunTimestamp(timelineRunDirectory),
      Date.parse("2026-03-31T11:00:00.000Z")
    );
  });

  test("prefers the newer run across mixed legacy and timeline names", () => {
    const olderLegacyRunPath = path.join(
      "history",
      "wf-cli-watch",
      "run-9-2026-03-31T10-00-00-000Z.json"
    );
    const newerTimelineManifestPath = path.join(
      "history",
      "wf-cli-watch",
      "run-10-2026-03-31T11-00-00-000Z",
      TimelineRecorder.MANIFEST_FILE_NAME
    );

    assert.strictEqual(
      isNewerHistoryRunPath(newerTimelineManifestPath, olderLegacyRunPath),
      true
    );
    assert.strictEqual(
      isNewerHistoryRunPath(olderLegacyRunPath, newerTimelineManifestPath),
      false
    );
  });
});
