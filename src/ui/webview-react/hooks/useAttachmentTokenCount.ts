/**
 * useAttachmentTokenCount - Token counting hook with attachment caching
 *
 * Counts tokens for the full expanded prompt (raw text + attachments).
 * Attachment token counts are fetched from the extension on first encounter
 * and then cached by reference string to avoid recomputation while typing.
 *
 * Cache is module-level so it persists across hook re-mounts.
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { MESSAGE_TYPES } from "../types/messages";
import { countTokens } from "../utils/tokenizer";
import { sendMessage } from "./useMessageHandler";
import { useUiStore } from "@store/uiStore";
import { workflowViewAddressKey } from "@utils/viewAddress";
import { decodePriorContextTokenRef } from "@root/utils/FileReferenceParser";
import {
  parseAtReferences,
  parseSelectionReferences,
  parseSymbolReferences,
  parseGitChangeReferences,
  parseInlinePriorContextRefs,
  encodePriorContextTokenRef,
} from "@root/utils/FileReferenceParser";

// ============================================================================
// Module-level cache (persists across renders and re-mounts)
// ============================================================================

/** Token count cache: raw reference string → token count */
const attachmentTokenCache = new Map<string, number>();

/** References currently being fetched (avoid duplicate requests) */
const pendingRequests = new Set<string>();

/** Registered callbacks to invoke when new counts arrive */
const countUpdateCallbacks = new Set<
  (counts: Record<string, number>) => void
>();

/**
 * Delay before requesting counts for newly-seen references. Typing a long path
 * (`@c:\dev\…`) passes through many partial, non-existent refs (`@c`, `@c:\dev`);
 * debouncing collapses that burst into a single request once typing settles.
 */
const REFERENCE_REQUEST_DEBOUNCE_MS = 250;

// ============================================================================
// Global message listener (set up once)
// ============================================================================

let globalListenerAttached = false;

function ensureGlobalListener(): void {
  if (globalListenerAttached) return;
  globalListenerAttached = true;

  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data;
    if (message?.type !== MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE)
      return;

    const counts: Record<string, number> = message.counts ?? {};
    let changed = false;

    for (const [ref, count] of Object.entries(counts)) {
      // Prior-context counts depend on the displayed run's output. They are
      // delivered to the current hook instances but never persisted globally.
      if (!decodePriorContextTokenRef(ref)) attachmentTokenCache.set(ref, count);
      pendingRequests.delete(ref);
      changed = true;
    }

    if (changed) {
      // Notify all registered hooks to re-compute their totals
      countUpdateCallbacks.forEach((cb) => cb(counts));
    }
  });
}

// ============================================================================
// Reference extraction
// ============================================================================

/**
 * Extract all raw reference strings from prompt text.
 * Delegates to FileReferenceParser (single source of truth) and slices the
 * original token so quoting and optional qualifiers remain intact.
 *
 * `stepCount` (steps preceding the edited prompt) is folded into prior-context
 * refs so `$previous` at different positions counts different prior output.
 */
function extractRawReferences(promptText: string, stepCount: number): string[] {
  const refs: string[] = [];

  for (const ref of parseAtReferences(promptText)) {
    if (ref.startOffset !== undefined && ref.endOffset !== undefined) {
      refs.push(promptText.slice(ref.startOffset, ref.endOffset));
    }
  }

  for (const ref of parseSelectionReferences(promptText)) {
    if (ref.startOffset !== undefined && ref.endOffset !== undefined) {
      refs.push(promptText.slice(ref.startOffset, ref.endOffset));
    }
  }

  for (const ref of parseSymbolReferences(promptText)) {
    // The line range is required — the extension-host counter re-parses this
    // string with parseSymbolReferences, whose regex needs `start-end`.
    if (ref.startOffset !== undefined && ref.endOffset !== undefined) {
      refs.push(promptText.slice(ref.startOffset, ref.endOffset));
    }
  }

  for (const ref of parseGitChangeReferences(promptText)) {
    refs.push(ref.raw);
  }

  for (const match of parseInlinePriorContextRefs(promptText)) {
    // token is "$previous", "$step:1,3", … — drop the leading "$" for the body.
    refs.push(encodePriorContextTokenRef(match.token.slice(1), stepCount));
  }

  // Deduplicate while preserving order
  return [...new Set(refs)];
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Returns the total estimated token count for the prompt including attachments.
 *
 * - Raw prompt tokens are memoized and re-encoded only when the text changes.
 * - Attachment tokens are fetched from the extension asynchronously, cached by
 *   reference string, and requested on a debounce so mid-typing partial paths
 *   don't each trigger a round-trip.
 * - While attachment counts are loading, only raw prompt tokens are returned.
 */
export function useAttachmentTokenCount(
  promptText: string,
  stepCount = 0
): number {
  ensureGlobalListener();

  const displayedViewAddress = useUiStore((state) => state.displayedViewAddress);
  const viewKey = displayedViewAddress
    ? workflowViewAddressKey(displayedViewAddress)
    : "draft";

  const [priorContextCounts, setPriorContextCounts] = useState<{
    viewKey: string;
    counts: Record<string, number>;
  }>({ viewKey, counts: {} });
  const callbackRef = useRef<(counts: Record<string, number>) => void>(() => {});

  // Keep callback ref up-to-date
  useEffect(() => {
    callbackRef.current = (counts) => {
      const priorCounts = Object.fromEntries(
        Object.entries(counts).filter(([ref]) => decodePriorContextTokenRef(ref))
      );
      if (Object.keys(priorCounts).length > 0) {
        setPriorContextCounts((current) => ({
          viewKey,
          counts: {
            ...(current.viewKey === viewKey ? current.counts : {}),
            ...priorCounts,
          },
        }));
      }
    };
  });

  // Register/unregister a stable callback wrapper
  useEffect(() => {
    const cb = (counts: Record<string, number>): void =>
      callbackRef.current(counts);
    countUpdateCallbacks.add(cb);
    return () => {
      countUpdateCallbacks.delete(cb);
    };
  }, []);

  // Parse once per prompt/position change; reused by the request effect and the
  // cached-total sum below so the regex passes don't run twice per render.
  const refs = useMemo(
    () => extractRawReferences(promptText, stepCount),
    [promptText, stepCount]
  );

  // Ordinary references are cached. Prior-context references are always
  // requested for the current view because their output changes across runs.
  useEffect(() => {
    if (refs.length === 0) return;

    const timer = setTimeout(() => {
      const uncached = refs.filter((ref) => {
        if (decodePriorContextTokenRef(ref)) return true;
        return !attachmentTokenCache.has(ref) && !pendingRequests.has(ref);
      });
      if (uncached.length === 0) return;

      for (const ref of uncached) {
        if (!decodePriorContextTokenRef(ref)) pendingRequests.add(ref);
      }

      sendMessage(MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS, {
        references: uncached,
      });
    }, REFERENCE_REQUEST_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [refs, viewKey]);

  // Raw prompt tokens are re-encoded only when the text actually changes, not on
  // every unrelated re-render (e.g. an incoming cached-count notification).
  const rawTokens = useMemo(() => countTokens(promptText), [promptText]);

  // Total: raw prompt tokens + cached attachments + view-scoped prior context.
  const attachmentTokens = refs.reduce((sum, ref) => {
    const priorCount = decodePriorContextTokenRef(ref)
      ? priorContextCounts.viewKey === viewKey
        ? priorContextCounts.counts[ref]
        : undefined
      : undefined;
    return sum + (priorCount ?? attachmentTokenCache.get(ref) ?? 0);
  }, 0);

  return rawTokens + attachmentTokens;
}
