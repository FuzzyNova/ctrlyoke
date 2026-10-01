import { useCallback } from "react";
import { generateId } from "@utils/string";
import { FINAL_STEP_PHASES, MESSAGE_TYPES } from "@/types/messages";
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

export interface FetchToolOutputEvent {
  (identity: ToolOutputEventIdentity): Promise<CliEvent | undefined>;
  requestMany?(
    identities: readonly ToolOutputEventIdentity[]
  ): Promise<(CliEvent | undefined)[]>;
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
    return this.requestMany([identity]).then(([event]) => event);
  }

  requestMany(
    identities: readonly ToolOutputEventIdentity[]
  ): Promise<(CliEvent | undefined)[]> {
    if (identities.length === 0) return Promise.resolve([]);
    const address = identities[0].address;
    const addressed = identities.map((identity) => ({
      identity,
      key: toolOutputContentKey(identity),
    }));
    const missing = addressed.filter(
      ({ identity, key }) =>
        identity.address.workflowKey !== address.workflowKey ||
        identity.address.runRef !== address.runRef ||
        (!this.cache.has(key) && !this.pending.has(key))
    );
    const seenRequestKeys = new Set<string>();
    const requestIdentities = missing.filter(({ identity, key }) => {
      if (
        identity.address.workflowKey !== address.workflowKey ||
        identity.address.runRef !== address.runRef ||
        seenRequestKeys.has(key)
      ) {
        return false;
      }
      seenRequestKeys.add(key);
      return true;
    });
    if (requestIdentities.length > 0) {
      const requestId = this.makeRequestId();
      const response = new Promise<void>((resolve) => {
        const listener = (event: MessageEvent) => {
          const message = event.data as Partial<ToolOutputContentMessage>;
          if (
            message?.type !== MESSAGE_TYPES.TOOL_OUTPUT_CONTENT ||
            message.requestId !== requestId ||
            !Array.isArray(message.events)
          )
            return;
          window.removeEventListener("message", listener);
          for (const result of message.events) {
            const key = toolOutputContentKey({ address, ...result });
            this.cache.set(key, result.event);
            this.pending.delete(key);
          }
          resolve();
        };
        window.addEventListener("message", listener);
      });
      for (const { key } of requestIdentities) {
        this.pending.set(
          key,
          response.then(() => this.cache.get(key))
        );
      }
      this.send({
        type: MESSAGE_TYPES.REQUEST_TOOL_OUTPUT_CONTENT,
        requestId,
        address,
        events: requestIdentities.map(({ identity }) => ({
          target: identity.target,
          attemptIndex: identity.attemptIndex,
          runIndex: identity.runIndex,
          phase: identity.phase,
          eventIndex: identity.eventIndex,
        })),
      });
    }
    return Promise.all(
      addressed.map(({ key }) => {
        if (this.cache.has(key)) return this.cache.get(key);
        return this.pending.get(key) ?? Promise.resolve(undefined);
      })
    );
  }
}

function toolOutputContentKey(identity: {
  address: WorkflowRunAddress;
  target: OutputExecutionTarget;
  attemptIndex: number;
  runIndex?: number;
  phase?: ExecutionPhase;
  eventIndex: number;
}): string {
  const targetIndex =
    identity.target.kind === FINAL_STEP_PHASES.QUEUE
      ? identity.target.stepIndex
      : identity.target.loopIndex;
  return JSON.stringify([
    identity.address.workflowKey,
    identity.address.runRef,
    identity.target.kind,
    targetIndex,
    identity.attemptIndex,
    identity.runIndex ?? 0,
    identity.phase ?? "prompt",
    identity.eventIndex,
  ]);
}

const toolOutputContentClient = new ToolOutputContentClient((message) =>
  getVsCodeApi().postMessage(message)
);

export function useToolOutputContent(): FetchToolOutputEvent {
  return useCallback(
    Object.assign(
      (identity: ToolOutputEventIdentity) =>
        toolOutputContentClient.request(identity),
      {
        requestMany: (identities: readonly ToolOutputEventIdentity[]) =>
          toolOutputContentClient.requestMany(identities),
      }
    ),
    []
  );
}
