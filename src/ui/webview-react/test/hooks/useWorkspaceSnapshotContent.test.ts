import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_TYPES, FINAL_STEP_PHASES } from "@/types/messages";
import type { WorkflowKey, RunRef } from "@root/types/CtrlYokeTypes";
import {
  hydrateSnapshot,
  WorkspaceSnapshotContentClient,
} from "@hooks/useWorkspaceSnapshotContent";

describe("WorkspaceSnapshotContentClient", () => {
  afterEach(() => vi.useRealTimers());

  it("hydrates every on-demand snapshot entry", async () => {
    const sent: any[] = [];
    const client = new WorkspaceSnapshotContentClient(
      (message) => sent.push(message),
      () => `request-${sent.length + 1}`
    );
    const address = {
      workflowKey: "workflow-a" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 } as const;
    const snapshot = {
      capturedAt: 1,
      strategy: "filesystem" as const,
      changedFiles: [
        {
          path: "src/one.ts",
          changeType: "modified" as const,
          contentAvailableOnDemand: true,
        },
        {
          path: "src/two.ts",
          changeType: "deleted" as const,
          contentAvailableOnDemand: true,
        },
        { path: "src/three.ts", changeType: "created" as const },
      ],
    };
    const hydration = hydrateSnapshot(
      (requestAddress, requestTarget, path) =>
        client.request(requestAddress, requestTarget, path),
      address,
      target,
      snapshot
    );
    expect(sent.map((message) => message.path)).toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
    sent.forEach((message) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
            requestId: message.requestId,
            beforeContent: `before ${message.path}`,
          },
        })
      );
    });
    await expect(hydration).resolves.toMatchObject({
      changedFiles: [
        { path: "src/one.ts", beforeContent: "before src/one.ts" },
        { path: "src/two.ts", beforeContent: "before src/two.ts" },
        { path: "src/three.ts" },
      ],
    });
  });

  it("matches replies and caches by address, target, and path", async () => {
    const sent: any[] = [];
    const client = new WorkspaceSnapshotContentClient(
      (message) => sent.push(message),
      () => `request-${sent.length + 1}`
    );
    const address = {
      workflowKey: "workflow-a" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 } as const;

    const first = client.request(address, target, "src/file.ts");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: MESSAGE_TYPES.REQUEST_WORKSPACE_SNAPSHOT_CONTENT,
      address,
      target,
      path: "src/file.ts",
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
          requestId: sent[0].requestId,
          address,
          target,
          path: "src/file.ts",
          beforeContent: "original",
          contentCaptureSkipped: false,
        },
      })
    );
    await expect(first).resolves.toEqual({
      beforeContent: "original",
      contentCaptureSkipped: false,
    });
    await expect(
      client.request(address, target, "src/file.ts")
    ).resolves.toEqual({
      beforeContent: "original",
      contentCaptureSkipped: false,
    });
    expect(sent).toHaveLength(1);

    const differentPath = client.request(address, target, "src/other.ts");
    expect(sent).toHaveLength(2);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
          requestId: sent[1].requestId,
          address,
          target,
          path: "src/other.ts",
        },
      })
    );
    await expect(differentPath).resolves.toEqual({});
  });

  it("does not resend a request while its response is pending", async () => {
    vi.useFakeTimers();
    const sent: any[] = [];
    const client = new WorkspaceSnapshotContentClient(
      (message) => sent.push(message),
      () => `request-${sent.length + 1}`,
      100
    );
    const address = {
      workflowKey: "workflow-a" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 } as const;

    const lookup = client.request(address, target, "src/retry.ts");
    const pendingLookup = client.request(address, target, "src/retry.ts");
    await vi.advanceTimersByTimeAsync(99);
    expect(sent).toHaveLength(1);
    expect(pendingLookup).toBe(lookup);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
          requestId: sent[0].requestId,
          beforeContent: "original",
        },
      })
    );
    await expect(lookup).resolves.toEqual({
      beforeContent: "original",
    });
    await expect(
      client.request(address, target, "src/retry.ts")
    ).resolves.toEqual({ beforeContent: "original" });
    expect(sent).toHaveLength(1);
  });

  it("caches empty replies so remounted rows do not re-request", async () => {
    const sent: any[] = [];
    const client = new WorkspaceSnapshotContentClient((message) =>
      sent.push(message)
    );
    const address = {
      workflowKey: "workflow-empty" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const lookup = client.request(address, target, "src/missing.ts");
    const expectation = expect(lookup).resolves.toEqual({});
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
          requestId: sent[0].requestId,
        },
      })
    );
    await expectation;

    await expect(
      client.request(address, target, "src/missing.ts")
    ).resolves.toEqual({});
    expect(sent).toHaveLength(1);
  });
});
