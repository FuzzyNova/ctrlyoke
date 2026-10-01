import { useCallback } from "react";
import { generateId } from "@utils/string";
import { MESSAGE_TYPES } from "@/types/messages";
import type { WorkflowRunAddress } from "@root/types/CtrlYokeTypes";
import type { OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import type { ExecutionPhase } from "@root/types/DashboardConstants";
import type { CliEvent } from "@root/types/CliOutputTypes";
import type {
  RequestToolOutputContentMessage,
  ToolOutputContentMessage,
} from "@root/types/WebviewMessageTypes";
import { getVsCodeApi } from "./useVsCodeApi";

export interface ToolOutputEventIdentity {
  address: WorkflowRunAddress;
  target: OutputExecutionTarget;
  attemptIndex: number;
  runIndex?: number;
  phase?: ExecutionPhase;
  eventIndex: number;
}

/** Request/reply cache shared by full-output consumers in this webview. */
export class ToolOutputContentClient {
  private readonly cache = new Map<string, CliEvent | undefined>();
  private readonly pending = new Map<string, Promise<CliEvent | undefined>>();
  private nextRequestId = 0;

  constructor(
    private readonly send: (message: RequestToolOutputContentMessage) => void,
    private readonly makeRequestId: () => string = () =>
      `tool-output-${++this.nextRequestId}-${generateId()}`
  ) {}

  request(identity: ToolOutputEventIdentity): Promise<CliEvent | undefined> {
    const key = JSON.stringify([
      identity.address.workflowKey,
      identity.address.runRef,
      identity.target,
      identity.attemptIndex,
      identity.runIndex ?? 0,
      identity.phase ?? "prompt",
      identity.eventIndex,
    ]);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    const existing = this.pending.get(key);
    if (existing) return existing;

    const requestId = this.makeRequestId();
    const response = new Promise<CliEvent | undefined>((resolve) => {
      const listener = (event: MessageEvent) => {
        const message = event.data as Partial<ToolOutputContentMessage>;
        if (
          message?.type !== MESSAGE_TYPES.TOOL_OUTPUT_CONTENT ||
          message.requestId !== requestId
        ) return;
        window.removeEventListener("message", listener);
        this.cache.set(key, message.event);
        this.pending.delete(key);
        resolve(message.event);
      };
      window.addEventListener("message", listener);
      this.send({
        type: MESSAGE_TYPES.REQUEST_TOOL_OUTPUT_CONTENT,
        requestId,
        ...identity,
      });
    });
    this.pending.set(key, response);
    return response;
  }
}

const toolOutputContentClient = new ToolOutputContentClient((message) =>
  getVsCodeApi().postMessage(message)
);

export function useToolOutputContent(): (
  identity: ToolOutputEventIdentity
) => Promise<CliEvent | undefined> {
  return useCallback(
    (identity) => toolOutputContentClient.request(identity),
    []
  );
}
