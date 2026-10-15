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
import { USER_FEEDBACK_SEVERITY } from "@root/types/DashboardConstants";
import { notifyUser } from "@utils/notifyUser";

const SNAPSHOT_CONTENT_RETRY_INTERVAL_MS = 5000;
const SNAPSHOT_CONTENT_MAX_RETRIES = 4;
const SNAPSHOT_CONTENT_FAILURE_MESSAGE =
  "Couldn't load the file snapshot — check the connection and try again.";

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
      `snapshot-content-${++this.nextRequestId}-${generateId()}`,
    private readonly retryIntervalMs = SNAPSHOT_CONTENT_RETRY_INTERVAL_MS,
    private readonly maxRetries = SNAPSHOT_CONTENT_MAX_RETRIES
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
    let startRequest: () => void = () => undefined;
    const response = new Promise<SnapshotContent>((resolve, reject) => {
      let retries = 0;
      let retryTimer: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        window.removeEventListener("message", listener);
        if (retryTimer !== undefined) clearInterval(retryTimer);
        if (this.pending.get(key) === response) this.pending.delete(key);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const listener = (event: MessageEvent) => {
        const message = event.data as Partial<WorkspaceSnapshotContentMessage>;
        if (
          message?.type !== MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT ||
          message.requestId !== requestId
        ) {
          return;
        }
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
          content.beforeContent === undefined &&
          content.contentToRestore === undefined &&
          content.contentCaptureSkipped !== true
        ) {
          cleanup();
          resolve(content);
          return;
        }
        cleanup();
        this.cache.set(key, content);
        resolve(content);
      };
      window.addEventListener("message", listener);
      const request = {
        type: MESSAGE_TYPES.REQUEST_WORKSPACE_SNAPSHOT_CONTENT,
        requestId,
        address,
        target,
        path,
      };
      const sendRequest = () => {
        try {
          this.send(request);
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new Error("Could not send snapshot content request.")
          );
        }
      };
      startRequest = () => {
        retryTimer = setInterval(() => {
          if (retries >= this.maxRetries) {
            fail(new Error("Snapshot content request timed out."));
            return;
          }
          retries += 1;
          sendRequest();
        }, this.retryIntervalMs);
        sendRequest();
      };
    });
    this.pending.set(key, response);
    startRequest();
    return response;
  }
}

/** Shared failure feedback for every surface that hydrates on-demand content. */
export function reportWorkspaceSnapshotContentFailure(): void {
  notifyUser(SNAPSHOT_CONTENT_FAILURE_MESSAGE, USER_FEEDBACK_SEVERITY.ERROR);
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
