import { suite, test } from "mocha";
import * as assert from "assert";
import { WorkflowInstance } from "../../core/WorkflowInstance";
import { WorkflowInstanceRegistry } from "../../core/orchestration/WorkflowInstanceRegistry";
import {
  EXECUTION_STATES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";
import type { QueueState } from "../../types/CtrlYokeTypes";

function fakeInstance(
  id: string,
  workflowKey: string,
  status: QueueState["status"]
): WorkflowInstance {
  const instance = Object.create(
    WorkflowInstance.prototype
  ) as WorkflowInstance;
  Object.defineProperty(instance, "id", { value: id, writable: true });
  instance.getQueueState = () =>
    ({
      workflowKey: workflowKey as never,
      status,
      stopped: false,
      currentIndex: 0,
      steps: [],
      parallelGroups: [],
      results: [],
      completedIndices: new Set<string>(),
      totalPausedDuration: 0,
      totalExecutionTime: 0,
      queueExtensions: 0,
      definitionRevision: 1,
    }) as QueueState;
  return instance;
}

suite("WorkflowInstanceRegistry", () => {
  test("keeps a client's viewer and address registries synchronized", () => {
    const registry = new WorkflowInstanceRegistry();
    const instance = fakeInstance(
      "instance-a",
      "lineage-a",
      EXECUTION_STATES.IDLE
    );
    registry.getInstances().set(instance.id, instance);
    registry.registerClient("client-a");

    registry.setViewedWorkflowId("client-a", instance.id);
    assert.deepStrictEqual(registry.getViewedWorkflowId("client-a"), instance.id);
    assert.deepStrictEqual(registry.getViewAddressRegistry().get("client-a"), {
      workflowKey: "lineage-a",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });

    registry.setViewedWorkflowId("client-a", null);
    assert.strictEqual(registry.getViewedWorkflowId("client-a"), null);
    assert.strictEqual(registry.getViewAddressRegistry().get("client-a"), null);
  });

  test("adopts the instance's new lineage identity for its bound clients", () => {
    const registry = new WorkflowInstanceRegistry();
    const instance = fakeInstance(
      "instance-a",
      "lineage-a",
      EXECUTION_STATES.IDLE
    );
    registry.getInstances().set(instance.id, instance);
    registry.registerClient("client-a");
    registry.setViewedWorkflowId("client-a", instance.id);

    registry.adoptInstanceLineageAddress(instance, {
      workflowKey: "lineage-b" as never,
      runRef: "run-a" as never,
      status: EXECUTION_STATES.IDLE,
      stopped: false,
      currentIndex: 0,
      steps: [],
      parallelGroups: [],
      results: [],
      completedIndices: new Set<string>(),
      totalPausedDuration: 0,
      totalExecutionTime: 0,
      queueExtensions: 0,
      definitionRevision: 1,
    } as QueueState);

    assert.deepStrictEqual(registry.getViewAddressRegistry().get("client-a"), {
      workflowKey: "lineage-b",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "run-a",
    });
  });

  test("chooses an executing resident over an idle or retired duplicate", () => {
    const registry = new WorkflowInstanceRegistry();
    const live = fakeInstance(
      "live-instance",
      "lineage-a",
      EXECUTION_STATES.IDLE
    );
    const retired = fakeInstance(
      "retired-instance",
      "lineage-a",
      EXECUTION_STATES.RUNNING
    );
    registry.getInstances().set(live.id, live);
    registry.getRetiredInstances().set(retired.id, retired);

    assert.strictEqual(
      registry.findInstanceForLineage("lineage-a" as never),
      retired
    );
  });

  test("retiring and promoting an instance keep the registries disjoint", () => {
    const registry = new WorkflowInstanceRegistry();
    const instance = fakeInstance(
      "instance-a",
      "lineage-a",
      EXECUTION_STATES.IDLE
    );
    registry.getRetiredInstances().set(instance.id, instance);

    assert.strictEqual(registry.promoteInstanceToLive(instance), true);
    assert.strictEqual(registry.getInstances().get(instance.id), instance);
    assert.strictEqual(registry.getRetiredInstances().has(instance.id), false);
  });
});
