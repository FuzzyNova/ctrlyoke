import { useCallback } from "react";
import { generateId } from "@utils/string";
import {
  MESSAGE_TYPES,
  type RequestWorkspaceSnapshotContentMessage,
  type WorkspaceSnapshotContentMessage,
} from "@/types/messages";
import type { WorkflowRunAddress } from "@root/types/CtrlYokeTypes";
import type { OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import type { WorkspaceSnapshot } from "@root/types/OutputHistoryTypes";
import { getVsCodeApi } from "./useVsCodeApi";

type SnapshotContent = Pick<
  WorkspaceSnapshotContentMessage,
  "beforeContent" | "contentToRestore" | "contentCaptureSkipped"
>;

/** Request/reply cache shared by snapshot consumers in this webview. */
export class WorkspaceSnapshotContentClient {
  private readonly cache = new Map<string, SnapshotContent>();
  private readonly pending = new Map<string, Promise<SnapshotContent>>();
  private nextRequestId = 0;

  constructor(
    private readonly send: (
      message: RequestWorkspaceSnapshotContentMessage
    ) => void,
    private readonly makeRequestId: () => string = () =>
      `snapshot-content-${++this.nextRequestId}-${generateId()}`
  ) {}

  request(
    address: WorkflowRunAddress,
    target: OutputExecutionTarget,
    path: string
  ): Promise<SnapshotContent> {
    const key = JSON.stringify([
      address.workflowKey,
      address.runRef,
      target,
      path,
    ]);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = this.pending.get(key);
    if (existing) return existing;

    const requestId = this.makeRequestId();
    const response = new Promise<SnapshotContent>((resolve) => {
      const listener = (event: MessageEvent) => {
        const message = event.data as Partial<WorkspaceSnapshotContentMessage>;
        if (
          message?.type !== MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT ||
          message.requestId !== requestId
        ) {
          return;
        }
        window.removeEventListener("message", listener);
        const content: SnapshotContent = {
          ...(message.beforeContent !== undefined
            ? { beforeContent: message.beforeContent }
            : {}),
          ...(message.contentToRestore !== undefined
            ? { contentToRestore: message.contentToRestore }
            : {}),
          ...(message.contentCaptureSkipped !== undefined
            ? { contentCaptureSkipped: message.contentCaptureSkipped }
            : {}),
        };
        if (
          content.beforeContent !== undefined ||
          content.contentToRestore !== undefined
        ) {
          this.cache.set(key, content);
        }
        this.pending.delete(key);
        resolve(content);
      };
      window.addEventListener("message", listener);
      this.send({
        type: MESSAGE_TYPES.REQUEST_WORKSPACE_SNAPSHOT_CONTENT,
        requestId,
        address,
        target,
        path,
      });
    });
    this.pending.set(key, response);
    return response;
  }
}

const snapshotContentClient = new WorkspaceSnapshotContentClient((message) =>
  getVsCodeApi().postMessage(message)
);

export function useWorkspaceSnapshotContent(): (
  address: WorkflowRunAddress,
  target: OutputExecutionTarget,
  path: string
) => Promise<SnapshotContent> {
  return useCallback(
    (address, target, path) =>
      snapshotContentClient.request(address, target, path),
    []
  );
}

/** Fill every on-demand file body before a snapshot is used to build undo UI. */
export async function hydrateSnapshot(
  requestContent: ReturnType<typeof useWorkspaceSnapshotContent>,
  address: WorkflowRunAddress,
  target: OutputExecutionTarget,
  snapshot: WorkspaceSnapshot | undefined
): Promise<WorkspaceSnapshot | undefined> {
  if (!snapshot) return undefined;
  const changedFiles = await Promise.all(
    snapshot.changedFiles.map(async (change) => {
      if (!change.contentAvailableOnDemand) return change;
      const content = await requestContent(address, target, change.path);
      return { ...change, ...content, contentAvailableOnDemand: undefined };
    })
  );
  return { ...snapshot, changedFiles };
}
