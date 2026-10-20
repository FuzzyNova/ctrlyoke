/**
 * useAttachmentTokenCount - Token counting hook with attachment caching
 *
 * Counts tokens for the full expanded prompt (raw text + attachments).
 * Attachment token counts are fetched from the extension on first encounter
 * and then cached by reference string to avoid recomputation while typing.
 * A `./`/`../` reference counted against an explicit source file is cached
 * per source file, since the same text names a different file per base.
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
import { isWorkflowRelativeReferencePath } from "@root/utils/promptPathUtils";
import {
  parseAtReferences,
  parseSelectionReferences,
  parseSymbolReferences,
  parseGitChangeReferences,
  parseInlinePriorContextRefs,
  encodePriorContextTokenRef,
} from "@root/utils/FileReferenceParser";
import {
  formatMergedPriorContextBody,
  inlinePriorContextRefToSelection,
  mergePriorContextReferences,
  type PriorContextSelection,
} from "@root/utils/PriorContextMerge";

// ============================================================================
// Module-level cache (persists across renders and re-mounts)
// ============================================================================

/** The path a file, line-range or symbol reference names, if it is one. */
function referencedPath(rawRef: string): string | undefined {
  const [ref] = rawRef.startsWith("@")
    ? parseAtReferences(rawRef)
    : rawRef.startsWith("#selection:")
      ? parseSelectionReferences(rawRef)
      : parseSymbolReferences(rawRef);
  return ref?.path;
}

/**
 * Cache key for a raw reference. Only a `./`/`../` reference counted against
 * an explicit `sourceDefinitionPath` depends on that base; every other key is
 * the raw reference itself, shared by every caller.
 */
function attachmentCacheKey(
  rawRef: string,
  sourceDefinitionPath: string | undefined
): string {
  if (sourceDefinitionPath === undefined) return rawRef;
  const refPath = referencedPath(rawRef);
  return refPath !== undefined && isWorkflowRelativeReferencePath(refPath)
    ? `${sourceDefinitionPath}\u0000${rawRef}`
    : rawRef;
}

/** Token count cache: cache key (see attachmentCacheKey) → token count */
const attachmentTokenCache = new Map<string, number>();

/** References currently being fetched (avoid duplicate requests) */
const pendingRequests = new Map<string, { sentAt: number; attempts: number }>();
const retiredRequests = new Set<string>();
const completedRequests = new Set<string>();

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
const REQUEST_RETRY_INTERVAL_MS = 5_000;
const MAX_REQUEST_ATTEMPTS = 3;

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

    const sourceDefinitionPath: string | undefined =
      typeof message.sourceDefinitionPath === "string"
        ? message.sourceDefinitionPath
        : undefined;
    const keyedCounts: Record<string, number> = {};

    for (const [ref, count] of Object.entries(
      (message.counts ?? {}) as Record<string, number>
    )) {
      const key = attachmentCacheKey(ref, sourceDefinitionPath);
      // Prior-context counts depend on the displayed run's output. They are
      // delivered to the current hook instances but never persisted globally.
      const isPriorContext = !!decodePriorContextTokenRef(ref);
      if (!isPriorContext) attachmentTokenCache.set(key, count);
      pendingRequests.delete(key);
      retiredRequests.delete(key);
      if (isPriorContext) completedRequests.add(key);
      keyedCounts[key] = count;
    }

    if (Object.keys(keyedCounts).length > 0) {
      // Notify all registered hooks to re-compute their totals
      countUpdateCallbacks.forEach((cb) => cb(keyedCounts));
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
  const priorContexts: PriorContextSelection[] = [];

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
    priorContexts.push(inlinePriorContextRefToSelection(match.ref));
  }
  if (
    priorContexts.length > 0 &&
    mergePriorContextReferences(priorContexts, stepCount).contexts.length > 0
  ) {
    refs.push(
      encodePriorContextTokenRef(
        formatMergedPriorContextBody(priorContexts),
        stepCount
      )
    );
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
 *
 * `sourceDefinitionPath` (a viewer path) makes that file the `./`/`../` base,
 * as when it runs on its own. Omitted, the displayed workflow's source file is
 * the base, as at execution.
 */
export function useAttachmentTokenCount(
  promptText: string,
  stepCount = 0,
  sourceDefinitionPath?: string
): number {
  ensureGlobalListener();

  const displayedViewAddress = useUiStore(
    (state) => state.displayedViewAddress
  );
  const viewKey = displayedViewAddress
    ? workflowViewAddressKey(displayedViewAddress)
    : "draft";

  const [priorContextCounts, setPriorContextCounts] = useState<{
    viewKey: string;
    counts: Record<string, number>;
  }>({ viewKey, counts: {} });
  // Ordinary counts live in the module cache, so their arrival re-renders
  // through this revision rather than through component state.
  const [, setCacheRevision] = useState(0);
  const callbackRef = useRef<(counts: Record<string, number>) => void>(
    () => {}
  );

  // Parse once per prompt/position change; reused by the request effect and the
  // cached-total sum below so the regex passes don't run twice per render.
  const references = useMemo(
    () =>
      extractRawReferences(promptText, stepCount).map((ref) => ({
        ref,
        key: attachmentCacheKey(ref, sourceDefinitionPath),
      })),
    [promptText, stepCount, sourceDefinitionPath]
  );

  // Keep callback ref up-to-date
  useEffect(() => {
    callbackRef.current = (counts) => {
      const priorCounts = Object.fromEntries(
        Object.entries(counts).filter(([key]) =>
          decodePriorContextTokenRef(key)
        )
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
      if (references.some(({ key }) => key in counts)) {
        setCacheRevision((revision) => revision + 1);
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

  // Ordinary references are cached. Prior-context references are always
  // requested for the current view because their output changes across runs.
  useEffect(() => {
    if (references.length === 0) return;
    for (const { key } of references) {
      if (decodePriorContextTokenRef(key)) {
        completedRequests.delete(key);
        retiredRequests.delete(key);
      }
    }

    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      const requestEligible = (): void => {
        const now = Date.now();
        const requestRefs: string[] = [];
        let hasActiveRequest = false;
        for (const { ref, key } of references) {
          const isPriorContext = !!decodePriorContextTokenRef(ref);
          if (retiredRequests.has(key)) continue;
          if (completedRequests.has(key)) continue;
          if (!isPriorContext && attachmentTokenCache.has(key)) continue;
          const pending = pendingRequests.get(key);
          if (pending && now - pending.sentAt < REQUEST_RETRY_INTERVAL_MS) {
            hasActiveRequest = true;
            continue;
          }
          if (pending && pending.attempts >= MAX_REQUEST_ATTEMPTS) {
            if (!isPriorContext) attachmentTokenCache.set(key, 0);
            pendingRequests.delete(key);
            retiredRequests.add(key);
            countUpdateCallbacks.forEach((cb) => cb({ [key]: 0 }));
            continue;
          }
          pendingRequests.set(key, {
            sentAt: now,
            attempts: (pending?.attempts ?? 0) + 1,
          });
          requestRefs.push(ref);
          hasActiveRequest = true;
        }
        if (requestRefs.length > 0) {
          sendMessage(MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS, {
            references: requestRefs,
            ...(sourceDefinitionPath !== undefined && { sourceDefinitionPath }),
          });
        }
        if (hasActiveRequest) {
          retryTimer = setTimeout(requestEligible, REQUEST_RETRY_INTERVAL_MS);
        }
      };
      requestEligible();
    }, REFERENCE_REQUEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [references, sourceDefinitionPath, viewKey]);

  // Raw prompt tokens are re-encoded only when the text actually changes, not on
  // every unrelated re-render (e.g. an incoming cached-count notification).
  const rawTokens = useMemo(() => countTokens(promptText), [promptText]);

  // Total: raw prompt tokens + cached attachments + view-scoped prior context.
  const attachmentTokens = references.reduce((sum, { key }) => {
    const priorCount = decodePriorContextTokenRef(key)
      ? priorContextCounts.viewKey === viewKey
        ? priorContextCounts.counts[key]
        : undefined
      : undefined;
    return sum + (priorCount ?? attachmentTokenCache.get(key) ?? 0);
  }, 0);

  return rawTokens + attachmentTokens;
}
