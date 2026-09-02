import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import {
  savePendingOutputSnapshot,
  writeOutputSnapshotAttachment,
} from "../../ui/OutputSnapshotService";
import { outputCaptureCache } from "../../completions/OutputCaptureCache";

suite("OutputSnapshotService", () => {
  const workspaceRoots: string[] = [];

  afterEach(async () => {
    for (const workspaceRoot of workspaceRoots.splice(0)) {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  function createWorkspaceRoot(): string {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-output-snapshot-")
    );
    workspaceRoots.push(workspaceRoot);
    return workspaceRoot;
  }

  test("writes a direct output attachment and returns its relative value", async () => {
    const workspaceRoot = createWorkspaceRoot();

    const relativePath = await writeOutputSnapshotAttachment(
      () => workspaceRoot,
      {
        text: "selected output",
        channel: "agenthost",
        range: { startLine: 17, endLine: 28 },
      }
    );

    assert.match(
      relativePath,
      /^\.ctrlyoke\/attachments\/output-agenthost-17-28-[0-9a-f]{12}\.log$/
    );
    assert.strictEqual(
      await fs.promises.readFile(
        path.join(workspaceRoot, relativePath),
        "utf8"
      ),
      "selected output"
    );
  });

  test("takes a cached capture and delegates attachment writing", async () => {
    const workspaceRoot = createWorkspaceRoot();
    const captureId = "output-snapshot-service-test";
    outputCaptureCache.set(captureId, {
      text: "cached output",
      channel: "agenthost",
    });

    const relativePath = await savePendingOutputSnapshot(
      () => workspaceRoot,
      captureId
    );

    assert.match(
      relativePath,
      /^\.ctrlyoke\/attachments\/output-agenthost-full-[0-9a-f]{12}\.log$/
    );
    assert.strictEqual(
      await fs.promises.readFile(
        path.join(workspaceRoot, relativePath),
        "utf8"
      ),
      "cached output"
    );
    await assert.rejects(
      () => savePendingOutputSnapshot(() => workspaceRoot, captureId),
      /Output capture expired — try again/
    );
  });
});
