import { useEffect, useRef } from "react";
import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { SingleLineCompletionEditor } from "./SingleLineCompletionEditor";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { ScriptCompletionItem } from "@root/completions/ScriptCommandCompletionHelpers";
import type { ScriptCompletionsResponseMessage } from "@root/types/WebviewMessageTypes";
import type { SingleLineCompletionEditorProps } from "./SingleLineCompletionEditor";

type ScriptCommandEditorProps = Omit<
  SingleLineCompletionEditorProps,
  "completionSource"
>;

interface PendingScriptCompletion {
  resolve: (result: CompletionResult | null) => void;
}

function buildScriptCompletionResult(
  items: ScriptCompletionItem[],
  from: number
): CompletionResult {
  return {
    from,
    filter: false,
    options: items.map((item, index) => ({
      label: item.label,
      detail: item.detail,
      info: item.documentation,
      apply: item.insertText,
      boost: -index,
    })),
  };
}

export function ScriptCommandEditor(props: ScriptCommandEditorProps) {
  const vscode = getVsCodeApi();
  const completionSeqRef = useRef(0);
  const inFlightSeqRef = useRef<number | null>(null);
  const pendingRequestsRef = useRef<Map<number, PendingScriptCompletion>>(
    new Map()
  );

  useEffect(() => {
    const pendingRequests = pendingRequestsRef.current;
    const handleMessage = (event: MessageEvent) => {
      const message = event.data as Partial<ScriptCompletionsResponseMessage>;
      if (
        message.type !== MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE ||
        typeof message.seq !== "number" ||
        typeof message.from !== "number" ||
        !Array.isArray(message.items)
      ) {
        return;
      }

      const pending = pendingRequests.get(message.seq);
      if (!pending) return;

      pendingRequests.delete(message.seq);
      if (inFlightSeqRef.current === message.seq) {
        inFlightSeqRef.current = null;
      }
      pending.resolve(buildScriptCompletionResult(message.items, message.from));
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      for (const pending of pendingRequests.values()) {
        pending.resolve(null);
      }
      pendingRequests.clear();
      inFlightSeqRef.current = null;
    };
  }, []);

  const completionSource = (
    context: CompletionContext
  ): Promise<CompletionResult | null> => {
    const previousSeq = inFlightSeqRef.current;
    if (previousSeq !== null) {
      const previous = pendingRequestsRef.current.get(previousSeq);
      previous?.resolve(null);
      pendingRequestsRef.current.delete(previousSeq);
    }

    const seq = ++completionSeqRef.current;
    inFlightSeqRef.current = seq;

    return new Promise<CompletionResult | null>((resolve) => {
      pendingRequestsRef.current.set(seq, { resolve });
      vscode.postMessage({
        type: MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST,
        text: context.state.doc.toString(),
        position: context.pos,
        seq,
      });
    });
  };

  return (
    <SingleLineCompletionEditor
      {...props}
      completionSource={completionSource}
    />
  );
}
