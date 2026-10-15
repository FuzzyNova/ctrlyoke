import { suite, test } from "mocha";
import * as assert from "assert";
import { WorkflowInstance } from "../../core/WorkflowInstance";
import { WorkflowInstanceRegistry } from "../../core/orchestration/WorkflowInstanceRegistry";
import { WorkflowActivityTracker } from "../../core/orchestration/WorkflowActivityTracker";
import { TestWorkflowInstanceRegistryHost } from "../helpers/workflowInstanceRegistryHost";
import {
  EXECUTION_STATES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";
import type {
  QueueState,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";

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
    const registry = new WorkflowInstanceRegistry(
      new TestWorkflowInstanceRegistryHost()
    );
    const instance = fakeInstance(
      "instance-a",
      "lineage-a",
      EXECUTION_STATES.IDLE
    );
    registry.getInstances().set(instance.id, instance);
    registry.registerClient("client-a");

    registry.setViewedWorkflowId("client-a", instance.id);
    assert.deepStrictEqual(
      registry.getViewedWorkflowId("client-a"),
      instance.id
    );
    assert.deepStrictEqual(registry.getViewAddressRegistry().get("client-a"), {
      workflowKey: "lineage-a",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });

    registry.setViewedWorkflowId("client-a", null);
    assert.strictEqual(registry.getViewedWorkflowId("client-a"), null);
    assert.strictEqual(registry.getViewAddressRegistry().get("client-a"), null);
  });

  test("keeps a cancelling instance registered after its last client leaves", () => {
    const registry = new WorkflowInstanceRegistry(
      new TestWorkflowInstanceRegistryHost()
    );
    const instance = fakeInstance(
      "cancelling-instance",
      "lineage-a",
      EXECUTION_STATES.CANCELLING
    );
    let disposed = false;
    instance.dispose = () => {
      disposed = true;
    };
    registry.getInstances().set(instance.id, instance);
    registry.registerClient("client-a");
    registry.setViewedWorkflowId("client-a", instance.id);

    registry.unregisterClient("client-a");

    assert.strictEqual(registry.getInstances().get(instance.id), instance);
    assert.strictEqual(disposed, false);
  });

  test("reuses a cancelling instance when creating its workflow again", async () => {
    const host = new TestWorkflowInstanceRegistryHost();
    const registry = new WorkflowInstanceRegistry(host);
    const instance = fakeInstance(
      "cancelling-instance",
      "lineage-a",
      EXECUTION_STATES.CANCELLING
    );
    Object.defineProperty(instance, "filePath", { value: "workflow.md" });
    let disposed = false;
    instance.dispose = () => {
      disposed = true;
    };
    registry.getInstances().set(instance.id, instance);

    const result = await registry.createWorkflow("workflow.md");

    assert.strictEqual(result, instance);
    assert.strictEqual(registry.getInstances().get(instance.id), instance);
    assert.strictEqual(disposed, false);
  });

  test("adopts the instance's new lineage identity for its bound clients", () => {
    const registry = new WorkflowInstanceRegistry(
      new TestWorkflowInstanceRegistryHost()
    );
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
    const registry = new WorkflowInstanceRegistry(
      new TestWorkflowInstanceRegistryHost()
    );
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
    const registry = new WorkflowInstanceRegistry(
      new TestWorkflowInstanceRegistryHost()
    );
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
  test("reports a client's navigation, not a re-bind to the same view, for status bar acknowledgement", () => {
    const host = new TestWorkflowInstanceRegistryHost();
    const registry = new WorkflowInstanceRegistry(host);
    const instance = fakeInstance(
      "instance-a",
      "lineage-a",
      EXECUTION_STATES.ERROR
    );
    registry.getInstances().set(instance.id, instance);
    registry.registerClient("client-a");

    registry.setViewedWorkflowId("client-a", instance.id);
    registry.setViewedWorkflowId("client-a", instance.id);
    assert.deepStrictEqual(host.acknowledged, [
      {
        workflowId: instance.id,
        address: {
          workflowKey: "lineage-a",
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
      },
    ]);

    const runAddress = {
      workflowKey: "lineage-a" as WorkflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "run-1" as RunRef,
    } as const;
    registry.setViewAddress("client-a", runAddress);
    registry.setViewAddress("client-a", { ...runAddress });
    assert.strictEqual(host.acknowledged.length, 2);
    assert.deepStrictEqual(host.acknowledged[1], {
      workflowId: null,
      address: runAddress,
    });
    assert.deepStrictEqual(
      registry.getViewAddressRegistry().get("client-a"),
      runAddress
    );
  });

  test("acknowledges an opened history run adopted while loading a fresh instance", () => {
    const host = new TestWorkflowInstanceRegistryHost();
    const tracker = new WorkflowActivityTracker(() => {});
    host.acknowledgeWorkflowView = (workflowId, address) => {
      host.acknowledged.push({ workflowId, address });
      tracker.acknowledgeView(workflowId, address);
    };
    const registry = new WorkflowInstanceRegistry(host);
    const failedAddress = {
      workflowKey: "failed-lineage" as WorkflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "failed-run" as RunRef,
    } as const;
    tracker.observe({
      id: "failed-instance",
      workflowKey: failedAddress.workflowKey,
      runRef: failedAddress.runRef,
      workflowName: "Failed run",
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      totalSteps: 1,
    });
    tracker.observe({
      id: "failed-instance",
      workflowKey: failedAddress.workflowKey,
      runRef: failedAddress.runRef,
      workflowName: "Failed run",
      executionState: EXECUTION_STATES.ERROR,
      currentStep: 1,
      totalSteps: 1,
    });

    const historyAddress = {
      workflowKey: "history-lineage" as WorkflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "history-run" as RunRef,
    } as const;
    let loadedState: QueueState = {
      workflowKey: undefined,
      runRef: undefined,
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
    } as QueueState;
    const instance = Object.create(
      WorkflowInstance.prototype
    ) as WorkflowInstance;
    Object.defineProperty(instance, "id", { value: "fresh-instance" });
    instance.getQueueState = () => loadedState;
    registry.getInstances().set(instance.id, instance);
    registry.registerClient("client-a");

    // loadFreshInstanceAndReplay binds the new instance before loadWorkingFile;
    // the load's state event then adopts its lineage/run address. deliverRunView
    // subsequently calls setViewAddress with that same address.
    registry.setViewedWorkflowId("client-a", instance.id);
    loadedState = {
      ...loadedState,
      workflowKey: historyAddress.workflowKey,
      runRef: historyAddress.runRef,
    };
    registry.adoptInstanceLineageAddress(instance, loadedState);
    registry.setViewAddress("client-a", historyAddress);

    assert.deepStrictEqual(
      tracker.buildSummary([]).unseenFailures,
      [
        {
          workflowId: "failed-instance",
          workflowName: "Failed run",
          workflowKey: failedAddress.workflowKey,
          runRef: failedAddress.runRef,
        },
      ],
      "viewing a different lineage's run must not clear the failure"
    );

    registry.adoptInstanceLineageAddress(instance, {
      ...loadedState,
      workflowKey: failedAddress.workflowKey,
      runRef: failedAddress.runRef,
    });
    registry.setViewAddress("client-a", failedAddress);

    assert.deepStrictEqual(tracker.buildSummary([]).unseenFailures, []);
    tracker.dispose();
  });
});
