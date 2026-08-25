import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  deleteWorkflowStopRequest,
  readWorkflowStopRequest,
  waitForWorkflowStopRequestPickup,
  writeWorkflowStopRequest,
} from "../../utils/WorkflowStopRequest";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";

suite("Workflow stop request", () => {
  test("writes, is picked up, and is deleted by owner-token lifecycle", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-stop-request-")
    );
    const workflowKey = "stop-request-test" as WorkflowKey;
    const ownerToken = "owner-token";
    try {
      const requestPath = await writeWorkflowStopRequest(
        workspace,
        workflowKey,
        ownerToken,
        "request-1"
      );
      assert.strictEqual(
        (await readWorkflowStopRequest(workspace, workflowKey, ownerToken))
          ?.requestId,
        "request-1"
      );

      const pickedUp = waitForWorkflowStopRequestPickup(requestPath, 1_000, 10);
      await deleteWorkflowStopRequest(workspace, workflowKey, ownerToken);

      assert.strictEqual(await pickedUp, true);
      assert.strictEqual(
        await readWorkflowStopRequest(workspace, workflowKey, ownerToken),
        undefined
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
