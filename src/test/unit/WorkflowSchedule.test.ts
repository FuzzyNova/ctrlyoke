import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";
import { currentScheduleHostId, validateWorkflowSchedule } from "../../utils/WorkflowSchedule";

suite("WorkflowSchedule", () => {
  test("validates trigger shape and required host identity", () => {
    assert.strictEqual(typeof validateWorkflowSchedule({ enabled: true, hostId: "h", trigger: { at: "2026-02-30T12:00" } }), "string");
    assert.strictEqual(typeof validateWorkflowSchedule({ enabled: true, hostId: "h", trigger: { at: "2026-01-01T12:00", cron: "* * * * *" } }), "string");
    assert.strictEqual(typeof validateWorkflowSchedule({ enabled: true, hostId: "h", trigger: { cron: "* * * * *" } }), "object");
    assert.ok(currentScheduleHostId().length > 0);
  });

  test("round-trips a valid schedule and drops an invalid one without losing its lineage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-schedule-"));
    try {
      const repository = new WorkflowLineageRepository();
      const created = await repository.createLineage(root, "schedule-test", "Schedule Test");
      const schedule = { enabled: true, hostId: currentScheduleHostId(), trigger: { cron: "0 9 * * 1-5" } } as const;
      await repository.updateDescriptor(root, created.workflowKey, (descriptor) => ({ ...descriptor, schedule }));
      assert.deepStrictEqual((await repository.readDescriptor(root, created.workflowKey)).schedule, schedule);
      const descriptorPath = WorkflowPaths.descriptorPath(root, created.workflowKey);
      const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
      descriptor.schedule = { enabled: true, hostId: "h", trigger: { cron: "@daily" } };
      await fs.writeFile(descriptorPath, JSON.stringify(descriptor));
      const read = await repository.readDescriptor(root, created.workflowKey);
      assert.strictEqual(read.schedule, undefined);
      assert.strictEqual(read.workflowKey, created.workflowKey as WorkflowKey);
      assert.strictEqual(read.workflowName, "Schedule Test");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
