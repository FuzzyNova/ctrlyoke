import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import {
  GlobalWorkflowStatusService,
  MCP_GLOBAL_STATUS_WORDING,
} from "../../core/orchestration/GlobalWorkflowStatusService";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

suite("GlobalWorkflowStatusService", () => {
  let root: string | undefined;

  teardown(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("keeps the MCP global_status error strings by default", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-global-status-"));
    for (const service of [
      new GlobalWorkflowStatusService(root),
      new GlobalWorkflowStatusService(
        root,
        undefined,
        MCP_GLOBAL_STATUS_WORDING
      ),
    ]) {
      await assert.rejects(
        service.getStatus({ runRef: "run-2026-01-01T00-00-00-000Z" as RunRef }),
        { message: "global_status: runRef requires workflowKey" }
      );
      await assert.rejects(
        service.getStatus({ workflowKey: "missing-workflow" as WorkflowKey }),
        (error: Error) =>
          error.message.startsWith(
            "global_status: no workflow 'missing-workflow' was found under "
          ) &&
          error.message.endsWith(
            "). Call global_status with no arguments to see the workflow keys that exist."
          )
      );
    }
  });

  test("uses the caller's wording for another surface", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-global-status-"));
    const service = new GlobalWorkflowStatusService(root, undefined, {
      surface: "status",
      runRequiresWorkflow: "--run requires --workflow",
      listWorkflowsHint: "List them first.",
    });
    await assert.rejects(
      service.getStatus({ runRef: "run-2026-01-01T00-00-00-000Z" as RunRef }),
      { message: "status: --run requires --workflow" }
    );
    await assert.rejects(
      service.getStatus({ workflowKey: "missing-workflow" as WorkflowKey }),
      (error: Error) =>
        error.message.startsWith("status: no workflow 'missing-workflow'") &&
        error.message.endsWith("). List them first.")
    );
  });
});
