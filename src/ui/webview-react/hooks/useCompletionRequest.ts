import { useEffect, useRef } from "react";
import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";

export interface SequencedCompletionResponse {
  seq: number;
}

interface CompletionRequestOptions<
  TResponse extends SequencedCompletionResponse,
> {
  sendRequest: (context: CompletionContext, seq: number) => void;
  parseResponse: (data: unknown) => TResponse | null;
  buildResult: (response: TResponse) => CompletionResult | null;
}

type CompletionSource = (
  context: CompletionContext
) => Promise<CompletionResult | null>;

/** Owns the sequence, stale-response, and lifecycle plumbing for field completions. */
export function useCompletionRequest<
  TResponse extends SequencedCompletionResponse,
>({
  sendRequest,
  parseResponse,
  buildResult,
}: CompletionRequestOptions<TResponse>): CompletionSource {
  const optionsRef = useRef({ sendRequest, parseResponse, buildResult });
  const completionSeqRef = useRef(0);
  const inFlightSeqRef = useRef<number | null>(null);
  const pendingRequestsRef = useRef<
    Map<number, (result: CompletionResult | null) => void>
  >(new Map());

  optionsRef.current = { sendRequest, parseResponse, buildResult };

  useEffect(() => {
    const pendingRequests = pendingRequestsRef.current;
    const handleMessage = (event: MessageEvent) => {
      const response = optionsRef.current.parseResponse(event.data);
      if (!response) return;

      const pending = pendingRequests.get(response.seq);
      if (!pending) return;

      pendingRequests.delete(response.seq);
      if (inFlightSeqRef.current === response.seq) {
        inFlightSeqRef.current = null;
      }
      pending(optionsRef.current.buildResult(response));
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      for (const resolve of pendingRequests.values()) {
        resolve(null);
      }
      pendingRequests.clear();
      inFlightSeqRef.current = null;
    };
  }, []);

  return (context) => {
    const previousSeq = inFlightSeqRef.current;
    if (previousSeq !== null) {
      const previous = pendingRequestsRef.current.get(previousSeq);
      previous?.(null);
      pendingRequestsRef.current.delete(previousSeq);
    }

    const seq = ++completionSeqRef.current;
    inFlightSeqRef.current = seq;

    return new Promise<CompletionResult | null>((resolve) => {
      pendingRequestsRef.current.set(seq, resolve);
      try {
        optionsRef.current.sendRequest(context, seq);
      } catch {
        pendingRequestsRef.current.delete(seq);
        inFlightSeqRef.current = null;
        resolve(null);
      }
    });
  };
}
