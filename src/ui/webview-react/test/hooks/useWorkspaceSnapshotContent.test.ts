import { describe, expect, it } from "vitest";
import { MESSAGE_TYPES, FINAL_STEP_PHASES } from "@/types/messages";
import type { WorkflowKey, RunRef } from "@root/types/CtrlYokeTypes";
import { WorkspaceSnapshotContentClient } from "@hooks/useWorkspaceSnapshotContent";

describe("WorkspaceSnapshotContentClient", () => {
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

  it("retries empty replies and caches the later content reply", async () => {
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

    const failedLookup = client.request(address, target, "src/file.ts");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
          requestId: sent[0].requestId,
        },
      })
    );
    await expect(failedLookup).resolves.toEqual({});

    const retriedLookup = client.request(address, target, "src/file.ts");
    expect(sent).toHaveLength(2);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
          requestId: sent[1].requestId,
          beforeContent: "original",
        },
      })
    );
    await expect(retriedLookup).resolves.toEqual({
      beforeContent: "original",
    });
    await expect(
      client.request(address, target, "src/file.ts")
    ).resolves.toEqual({ beforeContent: "original" });
    expect(sent).toHaveLength(2);
  });
});
