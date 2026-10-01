import { suite, test } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  RunViewPublisher,
  type RunViewPublisherExternalRunWatchPort,
  type RunViewPublisherInstance,
  type RunViewPublisherLineageRepository,
  type RunViewPublisherRegistryPort,
} from "../../core/orchestration/RunViewPublisher";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";
import type {
  WorkflowKey,
  WorkflowSummary,
  WorkflowViewAddress,
  RunRef,
} from "../../types/CtrlYokeTypes";
import type { IDashboardSink } from "../../types/IDashboardSink";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { FINAL_STEP_PHASES } from "../../types/DashboardConstants";

class FakeInstance implements RunViewPublisherInstance {
  constructor(
    public readonly id: string,
    private readonly workingFilePath: string,
    private readonly activeStepIndices: number[] = [],
    private readonly events: string[] = []
  ) {}

  getSummary(): WorkflowSummary {
    return {
      id: this.id,
      workflowName: "Test workflow",
      filePath: this.workingFilePath,
      workingFilePath: this.workingFilePath,
      executionState: EXECUTION_STATES.IDLE,
      currentStep: 0,
      totalSteps: 1,
    };
  }

  replayBufferedOutputTo(_sink: IDashboardSink): void {
    this.events.push("buffer");
  }

  getActiveStepIndices(): number[] {
    return this.activeStepIndices;
  }

  getRunViewLiveState(): RunViewPublisherInstance["getRunViewLiveState"] extends () => infer T
    ? T
    : never {
    return {
      executionState: EXECUTION_STATES.RUNNING,
      currentIndex: 0,
      steps: [{ prompt: "one" }],
      results: [],
      parallelGroups: [],
      finalStep: null,
      finalStepRuntime: undefined,
      workflowProperties: {},
      schemaWarnings: [],
    };
  }
}

class FakeRegistry implements RunViewPublisherRegistryPort {
  private readonly addresses = new Map<string, WorkflowViewAddress | null>();
  private readonly sinks = new Map<string, (message: unknown) => void>();
  private readonly bindings = new Set<string>();
  private readonly viewed = new Map<string, string | null>();
  private readonly lineageInstances = new Map<WorkflowKey, FakeInstance>();
  private readonly instances = new Map<string, FakeInstance>();

  constructor(private readonly events: string[]) {}

  addInstance(workflowKey: WorkflowKey, instance: FakeInstance): void {
    this.lineageInstances.set(workflowKey, instance);
    this.instances.set(instance.id, instance);
  }

  addViewer(
    clientId: string,
    address: WorkflowViewAddress,
    send: (message: unknown) => void
  ): void {
    this.addresses.set(clientId, address);
    this.sinks.set(clientId, send);
  }

  getViewAddressRegistry(): Map<string, WorkflowViewAddress | null> {
    return this.addresses;
  }

  getViewMessageSinks(): Map<string, (message: unknown) => void> {
    return this.sinks;
  }

  getLineageBindingClients(): Set<string> {
    return this.bindings;
  }

  getViewedWorkflowId(clientId: string): string | null {
    return this.viewed.get(clientId) ?? null;
  }

  setViewedWorkflowId(clientId: string, workflowId: string | null): void {
    this.events.push("bind");
    this.viewed.set(clientId, workflowId);
  }

  findInstanceForLineage(workflowKey: WorkflowKey): FakeInstance | undefined {
    return this.lineageInstances.get(workflowKey);
  }

  findInstance(workflowId: string): FakeInstance | undefined {
    return this.instances.get(workflowId);
  }
}

class FakeLineageRepository implements RunViewPublisherLineageRepository {
  constructor(private readonly events: string[]) {}

  async readDescriptor(): Promise<{
    revision: number;
    lastModifiedAt: number;
    workflowName: string;
    isSystemGenerated: boolean;
  }> {
    this.events.push("read");
    return {
      revision: 3,
      lastModifiedAt: 12,
      workflowName: "fixture",
      isSystemGenerated: false,
    };
  }
}

class FakeExternalRunWatch implements RunViewPublisherExternalRunWatchPort {
  hasSession(): boolean {
    return false;
  }

  getEntry(): undefined {
    return undefined;
  }
}

async function createPublisher(): Promise<{
  root: string;
  publisher: RunViewPublisher;
  registry: FakeRegistry;
  events: string[];
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-run-view-"));
  const events: string[] = [];
  const registry = new FakeRegistry(events);
  const publisher = new RunViewPublisher({
    workspaceRoot: root,
    lineageRepository: new FakeLineageRepository(events),
    registry,
    externalRunWatch: new FakeExternalRunWatch(),
    loadFreshInstanceAndReplay: async () => {},
    findExecutionRunRef: () => undefined,
    getActiveTerminalWorkflowRefs: () => [],
    replayTerminalSessionsTo: () => events.push("terminals"),
  });
  return { root, publisher, registry, events };
}

async function writeAddressedFile(
  root: string,
  address: WorkflowViewAddress,
  definitionRevision: number
): Promise<void> {
  const filePath =
    address.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT
      ? WorkflowPaths.draftFilePath(root, address.workflowKey)
      : WorkflowPaths.runFilePath(root, address.workflowKey, address.runRef);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      workflowName: "Test workflow",
      definitionRevision,
      steps: [{ prompt: "one" }],
    }),
    "utf8"
  );
}

suite("RunViewPublisher", () => {
  test("binds the addressed lineage before reading its view", async () => {
    const { root, publisher, registry, events } = await createPublisher();
    try {
      const workflowKey = "lineage-a" as WorkflowKey;
      const address: WorkflowViewAddress = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      };
      await writeAddressedFile(root, address, 2);
      registry.addInstance(
        workflowKey,
        new FakeInstance("instance-a", "draft", [], events)
      );

      const sent: unknown[] = [];
      await publisher.loadRunViewForClient(
        address,
        (message) => sent.push(message),
        "client-a"
      );

      assert.ok(events.indexOf("bind") >= 0);
      assert.ok(events.indexOf("read") > events.indexOf("bind"));
      assert.strictEqual(
        (sent[0] as { type: string }).type,
        MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS
      );
      assert.strictEqual(
        (sent.at(-1) as { type: string }).type,
        MESSAGE_TYPES.RUN_VIEW_LOADED
      );
      assert.strictEqual(events.filter((event) => event === "buffer").length, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("strips captured snapshot bodies from run-view history and marks on-demand entries", async () => {
    const { root, publisher } = await createPublisher();
    try {
      const workflowKey = "snapshot-payload" as WorkflowKey;
      const runRef = "run-2026-09-30T13-41-01-546Z" as RunRef;
      const address: WorkflowViewAddress = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      };
      await writeAddressedFile(root, address, 1);
      const historyManager = new OutputHistoryManager(root);
      await historyManager.initializeRunAt(
        workflowKey,
        runRef,
        WorkflowPaths.runDir(root, workflowKey, runRef),
        1,
        1
      );
      await historyManager.saveSnapshotForTarget(
        historyManager.getHistoryFilePath(workflowKey, runRef),
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        {
          capturedAt: 1,
          strategy: "filesystem",
          changedFiles: [
            {
              path: "deleted.txt",
              changeType: "deleted",
              contentToRestore: "large deleted content",
              contentCaptureSkipped: false,
            },
            {
              path: "large.ts",
              changeType: "modified",
              beforeContent: "large before content",
              baseSource: "capturedBefore",
              structuredPatch: [],
              afterHash: "hash",
              lineEnding: "crlf",
              repo: "repo",
            },
            {
              path: "skipped.bin",
              changeType: "modified",
              contentCaptureSkipped: true,
            },
          ],
        }
      );
      const sent: unknown[] = [];
      await publisher.loadRunViewForClient(address, (message) => sent.push(message), "client-snapshot");
      const loaded = sent.find(
        (message) =>
          (message as { type?: string }).type === MESSAGE_TYPES.RUN_VIEW_LOADED
      ) as { history?: { promptOutputs: Record<number, { workspaceSnapshot?: { changedFiles: Array<Record<string, unknown>> } }> } } | undefined;
      const changes = loaded?.history?.promptOutputs[0]?.workspaceSnapshot?.changedFiles;
      assert.ok(changes);
      assert.deepStrictEqual(changes[0], {
        path: "deleted.txt",
        changeType: "deleted",
        contentCaptureSkipped: false,
        contentAvailableOnDemand: true,
      });
      assert.deepStrictEqual(changes[1], {
        path: "large.ts",
        changeType: "modified",
        baseSource: "capturedBefore",
        structuredPatch: [],
        afterHash: "hash",
        lineEnding: "crlf",
        repo: "repo",
        contentAvailableOnDemand: true,
      });
      assert.deepStrictEqual(changes[2], {
        path: "skipped.bin",
        changeType: "modified",
        contentCaptureSkipped: true,
      });
      assert.ok(!JSON.stringify(loaded).includes("large before content"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // activeStepIndices has no persisted `_runtime` counterpart (see
  // WorkflowInstance.getActiveStepIndices) — this is the only place a switch
  // to a running workflow's addressed view learns which step(s) are actually
  // executing, so terminal-deletion gating on the just-switched-to workflow
  // doesn't fall back to `[]` and wrongly treat a live step's terminal as
  // idle.
  test("addressed switch snapshot carries the bound instance's live activeStepIndices", async () => {
    const { root, publisher, registry, events } = await createPublisher();
    try {
      const workflowKey = "lineage-running" as WorkflowKey;
      const address: WorkflowViewAddress = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      };
      await writeAddressedFile(root, address, 1);
      registry.addInstance(
        workflowKey,
        new FakeInstance("instance-running", "draft", [1], events)
      );

      const sent: unknown[] = [];
      await publisher.loadRunViewForClient(
        address,
        (message) => sent.push(message),
        "client-a"
      );

      const snapshot = sent.find(
        (message) =>
          (message as { type?: string }).type === MESSAGE_TYPES.RUN_VIEW_LOADED
      ) as
        | {
            activeStepIndices?: number[];
            liveState?: { executionState: string };
          }
        | undefined;
      assert.deepStrictEqual(snapshot?.activeStepIndices, [1]);
      assert.strictEqual(
        snapshot?.liveState?.executionState,
        EXECUTION_STATES.RUNNING
      );
      assert.strictEqual(events.filter((event) => event === "buffer").length, 1);
      assert.strictEqual(
        events.filter((event) => event === "terminals").length,
        1
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("skipTerminalReplay leaves terminal replay to the caller", async () => {
    const { root, publisher, registry, events } = await createPublisher();
    try {
      const workflowKey = "lineage-skip-terminals" as WorkflowKey;
      const address: WorkflowViewAddress = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      };
      await writeAddressedFile(root, address, 1);
      registry.addInstance(
        workflowKey,
        new FakeInstance("instance-skip", "draft")
      );

      await publisher.loadRunViewForClient(
        address,
        () => {},
        "client-skip",
        undefined,
        undefined,
        false,
        true
      );

      assert.ok(!events.includes("terminals"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("publishes a write's identity to every viewer of the same address", async () => {
    const { root, publisher, registry } = await createPublisher();
    try {
      const workflowKey = "lineage-a" as WorkflowKey;
      const address: WorkflowViewAddress = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      };
      await writeAddressedFile(root, address, 7);
      const received = new Map<string, unknown[]>();
      for (const clientId of ["writer", "same-address", "other-address"]) {
        received.set(clientId, []);
      }
      registry.addViewer("writer", address, (message) =>
        received.get("writer")?.push(message)
      );
      registry.addViewer("same-address", address, (message) =>
        received.get("same-address")?.push(message)
      );
      registry.addViewer(
        "other-address",
        {
          workflowKey: "other" as WorkflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
        (message) => received.get("other-address")?.push(message)
      );

      const identity = await publisher.publishViewIdentityToViewers("writer");

      assert.strictEqual(
        (identity as { definitionRevision: number }).definitionRevision,
        7
      );
      assert.strictEqual(received.get("writer")?.length, 0);
      assert.strictEqual(received.get("same-address")?.length, 1);
      assert.strictEqual(received.get("other-address")?.length, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("publishes fresh revisions to every viewer before a full refresh", async () => {
    const { root, publisher, registry } = await createPublisher();
    try {
      const workflowKey = "lineage-a" as WorkflowKey;
      const runRef = "run-2026-09-17T00-00-00-000Z" as RunRef;
      const address: WorkflowViewAddress = {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      };
      await writeAddressedFile(root, address, 9);
      const received = [[], []] as unknown[][];
      registry.addViewer("writer", address, (message) =>
        received[0].push(message)
      );
      registry.addViewer("same-address", address, (message) =>
        received[1].push(message)
      );

      await publisher.publishRunRevisionsToViewers(workflowKey, runRef);

      assert.strictEqual(received[0].length, 1);
      assert.strictEqual(received[1].length, 1);
      assert.strictEqual(
        (received[0][0] as { definitionRevision: number }).definitionRevision,
        9
      );
      assert.strictEqual(
        (received[1][0] as { definitionRevision: number }).definitionRevision,
        9
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("loads request-correlated summaries without changing a client's view", async () => {
    const { root, publisher, registry } = await createPublisher();
    try {
      const workflowKey = "lineage-a" as WorkflowKey;
      registry.addViewer(
        "client-a",
        {
          workflowKey: "existing" as WorkflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
        () => {}
      );
      const sent: unknown[] = [];
      await publisher.loadRunSummariesForClient(
        workflowKey,
        (message) => sent.push(message),
        "request-1"
      );

      assert.deepStrictEqual(registry.getViewedWorkflowId("client-a"), null);
      assert.deepStrictEqual(sent, [
        {
          type: MESSAGE_TYPES.RUN_SUMMARIES_LOADED,
          requestId: "request-1",
          workflowKey,
          descriptorRevision: 3,
          lastModifiedAt: 12,
          runSummaries: [],
          executionRunRef: undefined,
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("returns null for an unaddressed client identity", async () => {
    const { root, publisher } = await createPublisher();
    try {
      assert.strictEqual(await publisher.getViewIdentity("client-a"), null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
