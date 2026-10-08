import type { CompletionResult } from "@codemirror/autocomplete";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type {
  PermissionCompletionsResponseMessage,
  ScriptCompletionsResponseMessage,
} from "@root/types/WebviewMessageTypes";
import type { WorkflowTextRange } from "@root/completions/WorkflowLocationTypes";

/** Host-backed completions for a field whose text is one slice of the document. */
export const HOST_RANGE_COMPLETION_KINDS = {
  SCRIPT: "script",
  PERMISSION: "permission",
} as const;
export type HostRangeCompletionKind =
  (typeof HOST_RANGE_COMPLETION_KINDS)[keyof typeof HOST_RANGE_COMPLETION_KINDS];

const REQUEST_TYPES = {
  [HOST_RANGE_COMPLETION_KINDS.SCRIPT]: {
    request: MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST,
    response: MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE,
  },
  [HOST_RANGE_COMPLETION_KINDS.PERMISSION]: {
    request: MESSAGE_TYPES.PERMISSION_COMPLETIONS_REQUEST,
    response: MESSAGE_TYPES.PERMISSION_COMPLETIONS_RESPONSE,
  },
} as const;

type HostRangeResponse =
  ScriptCompletionsResponseMessage | PermissionCompletionsResponseMessage;

// The script and permission editors number their own requests from 1 and
// match responses on `seq` alone, so a request from this module must live in a
// range they never reach or one of them would consume its answer.
let nextSeq = 1_000_000_000;
const REQUEST_TIMEOUT_MS = 5000;

export interface HostRangeCompletionTransport {
  postMessage(message: unknown): void;
}

/**
 * Asks the host for script or permission completions on the slice of the file
 * `range` covers, and maps the answer (positions relative to that slice) back
 * to document offsets. Resolves null on timeout or when `signal` aborts.
 */
export function requestHostRangeCompletions(
  transport: HostRangeCompletionTransport,
  kind: HostRangeCompletionKind,
  docText: string,
  range: WorkflowTextRange,
  position: number,
  signal?: AbortSignal
): Promise<CompletionResult | null> {
  const seq = ++nextSeq;
  const types = REQUEST_TYPES[kind];
  return new Promise((resolve) => {
    const finish = (result: CompletionResult | null) => {
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      const message = event.data as Partial<HostRangeResponse> | null;
      if (message?.type !== types.response || message.seq !== seq) return;
      if (!Array.isArray(message.items) || typeof message.from !== "number") {
        finish(null);
        return;
      }
      finish({
        from: range.start + message.from,
        filter: false,
        options: message.items.map((item, index) => ({
          label: item.label,
          detail: item.detail,
          info: item.documentation,
          apply: item.insertText,
          boost: -index,
        })),
      });
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort);
    transport.postMessage({
      type: types.request,
      text: docText.slice(range.start, range.end),
      position: position - range.start,
      seq,
    });
  });
}
