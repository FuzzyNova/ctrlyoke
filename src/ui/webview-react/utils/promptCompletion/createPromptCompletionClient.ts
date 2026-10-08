import { startCompletion } from "@codemirror/autocomplete";
import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import {
  COMPLETION_TRIGGERS,
  type CompletionTrigger,
} from "@root/types/DashboardConstants";
import { MESSAGE_TYPES } from "../../types/messages";
import { WebviewLog } from "../logger";
import {
  buildCodeMirrorCompletionResult,
  completionCacheKey,
  findCustomCompletionContext,
  type ExtensionCompletionItem,
  type OutputCapturePickHandler,
  type PendingCompletionRequest,
} from "./promptCompletionResult";

/** The slice of the VS Code API the completion client posts through. */
export interface PromptCompletionTransport {
  postMessage(message: unknown): void;
}

export interface PromptCompletionClientOptions {
  transport: PromptCompletionTransport;
  /** The view a finished progressive response re-triggers completion on. */
  getView: () => EditorView | null;
  /** Shared `#sym:` chip-icon cache seeded when a symbol completion is picked. */
  getSymbolIconCache: () => Map<string, string> | undefined;
  /** Multi-root workspaces also accept a leading `folder/` as a path start. */
  getIsMultiRootWorkspace: () => boolean;
  onOutputCapturePicked?: OutputCapturePickHandler;
  /** Escapes inserted text for the host string, e.g. a JSON string fragment. */
  escapeInsertText?: (text: string) => string;
}

interface PendingCompletionEntry {
  /** Nulled (not deleted) once a progressive partial response has resolved it. */
  resolve: ((value: CompletionResult | null) => void) | null;
  request: PendingCompletionRequest;
}

interface CompletionsResponseMessage {
  type: string;
  items?: ExtensionCompletionItem[];
  from: number;
  seq?: number;
  partial?: boolean;
}

// Sequence numbers are unique across every editor on screen, and one window
// listener routes each response to the client that asked for it. Per-editor
// listeners keyed only by their own counters would let two editors resolve
// each other's requests.
let nextCompletionSeq = 0;
const clientsBySeq = new Map<number, PromptCompletionClient>();
let listenerInstalled = false;

function handleWindowMessage(event: MessageEvent): void {
  const message = event.data as CompletionsResponseMessage | null | undefined;
  if (message?.type !== MESSAGE_TYPES.COMPLETIONS_RESPONSE) return;
  if (message.seq === undefined) return;
  clientsBySeq
    .get(message.seq)
    ?.handleResponse(
      message.items || [],
      message.from,
      message.seq,
      message.partial
    );
}

function trackSeq(seq: number, client: PromptCompletionClient): void {
  clientsBySeq.set(seq, client);
  if (!listenerInstalled) {
    window.addEventListener("message", handleWindowMessage);
    listenerInstalled = true;
  }
}

function untrackSeq(seq: number): void {
  clientsBySeq.delete(seq);
  if (clientsBySeq.size === 0 && listenerInstalled) {
    window.removeEventListener("message", handleWindowMessage);
    listenerInstalled = false;
  }
}

/**
 * Requests prompt-token completions (`@ # ~ $ ! /` and whole-document paths) from
 * the host and adapts the answers into CodeMirror completion results.
 *
 * `customSource` and `pathSource` are independent and can be in flight together
 * (a lone `/` matches both), so each tracks its own latest request and cancels
 * only that, never the other source's.
 */
export class PromptCompletionClient {
  private readonly pending = new Map<number, PendingCompletionEntry>();
  private readonly inFlight: { custom: number | null; path: number | null } = {
    custom: null,
    path: null,
  };
  // A full result that arrived after its (already-resolved) partial response.
  // Keyed by trigger+query so the re-triggered source serves it synchronously.
  private cache: { key: string; result: CompletionResult } | null = null;

  constructor(private readonly options: PromptCompletionClientOptions) {}

  readonly customSource = (
    context: CompletionContext
  ): CompletionResult | Promise<CompletionResult | null> | null => {
    // Use the rightmost trigger character, mirroring PromptCompletionProvider.
    // A greedy `@"[^"]*` match once swallowed a real `@path` typed after a
    // literal `"@"` on the same line.
    const lineObj = context.state.doc.lineAt(context.pos);
    const textBefore = lineObj.text.slice(0, context.pos - lineObj.from);

    const completionContext = findCustomCompletionContext(
      textBefore,
      lineObj.from
    );
    if (!completionContext) return null;
    const { trigger, query, from } = completionContext;

    // Serve a full result cached by a progressive (partial→full) response for
    // this exact trigger+query synchronously, with no second round trip.
    // Checked before the empty-query guard so it also applies when only the
    // trigger char has been typed (e.g. `#` with an active selection).
    if (this.cache?.key === completionCacheKey(trigger, query)) {
      const cached = this.cache.result;
      this.cache = null;
      return cached;
    }

    if (from === context.pos && !context.explicit) return null;

    // A fresh request invalidates any lingering progressive cache (e.g. a
    // stale selection snapshot from a prior dropdown that was dismissed).
    this.cache = null;

    return this.request("custom", { trigger, query }, trigger + query, from);
  };

  readonly pathSource = (
    context: CompletionContext
  ): Promise<CompletionResult | null> | null => {
    // Paths starting with ./ ../ / or a Windows drive letter. The dot-prefixed
    // alternative's trailing slash is optional so a lone "." (before any "/"
    // has been typed) already activates this dropdown.
    const pathPattern = this.options.getIsMultiRootWorkspace()
      ? /(?:\.\.?\/?|\/|[a-zA-Z]:[/\\]|[^\s/\\]+[/\\])[^\s\n]*/
      : /(?:\.\.?\/?|\/|[a-zA-Z]:[/\\])[^\s\n]*/;
    const before = context.matchBefore(pathPattern);
    if (!before) return null;

    // Only activate when this match starts at the very beginning of the
    // actual content (no mixed text before the path)
    const doc = context.state.doc.toString();
    const leadingWs = doc.length - doc.trimStart().length;
    if (before.from !== leadingWs) return null;

    // Bail out if there is any non-whitespace content after the path
    if (doc.slice(before.to).trim().length > 0) return null;

    if (before.from === before.to && !context.explicit) return null;

    WebviewLog.trace(
      `[CodeMirror] pathCompletions triggered: "${before.text}" from=${before.from}`
    );

    return this.request(
      "path",
      { trigger: COMPLETION_TRIGGERS.PATH, query: before.text },
      before.text,
      before.from
    );
  };

  /** Cancel every outstanding request. Late responses are then ignored. */
  dispose(): void {
    for (const [seq, entry] of this.pending) {
      entry.resolve?.(null);
      untrackSeq(seq);
    }
    this.pending.clear();
    this.inFlight.custom = null;
    this.inFlight.path = null;
    this.cache = null;
  }

  /**
   * Handle a host response. Some triggers (currently `#`) answer progressively:
   * a `partial` response carries the instant items (e.g. the current editor
   * selection) and resolves the pending CodeMirror promise so the dropdown
   * appears immediately; the final response, arriving after that promise
   * settled, is cached and applied by re-triggering the source.
   */
  handleResponse(
    items: ExtensionCompletionItem[],
    from: number,
    seq: number,
    partial?: boolean
  ): void {
    // No entry means the request was cancelled (superseded by a newer
    // keystroke from the same source) or already fully resolved.
    const entry = this.pending.get(seq);
    if (!entry) return;

    const result = buildCodeMirrorCompletionResult(
      items,
      from,
      entry.request,
      this.options.getSymbolIconCache(),
      this.options.onOutputCapturePicked,
      this.options.escapeInsertText
    );

    if (partial) {
      // Deliver the instant items now, but keep the entry (request context)
      // so the forthcoming full response can be keyed and re-applied.
      if (entry.resolve) {
        entry.resolve(result);
        entry.resolve = null;
      }
      return;
    }

    // Final response. If the promise is still pending (no partial was sent,
    // e.g. there was no selection), resolve it directly.
    if (entry.resolve) {
      entry.resolve(result);
      this.forget(seq);
      return;
    }

    // A partial already resolved the promise and the dropdown is open. Cache
    // the full result and re-trigger completion so the source can serve it
    // from cache without another round trip.
    this.forget(seq);
    this.cache = {
      key: completionCacheKey(entry.request.trigger, entry.request.query),
      result,
    };
    const view = this.options.getView();
    if (view) {
      startCompletion(view);
    }
  }

  private request(
    source: "custom" | "path",
    request: PendingCompletionRequest,
    prefix: string,
    position: number
  ): Promise<CompletionResult | null> {
    const seq = ++nextCompletionSeq;

    const prevSeq = this.inFlight[source];
    if (prevSeq !== null) {
      this.pending.get(prevSeq)?.resolve?.(null);
      this.forget(prevSeq);
    }
    this.inFlight[source] = seq;

    return new Promise<CompletionResult | null>((resolve) => {
      this.pending.set(seq, { resolve, request });
      trackSeq(seq, this);
      this.options.transport.postMessage({
        type: MESSAGE_TYPES.REQUEST_COMPLETIONS,
        trigger: request.trigger as CompletionTrigger,
        prefix,
        position,
        seq,
      });
    });
  }

  private forget(seq: number): void {
    this.pending.delete(seq);
    untrackSeq(seq);
  }
}

export function createPromptCompletionClient(
  options: PromptCompletionClientOptions
): PromptCompletionClient {
  return new PromptCompletionClient(options);
}
