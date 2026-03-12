/**
 * useAttachmentTokenCount - Token counting hook with attachment caching
 *
 * Counts tokens for the full expanded prompt (raw text + attachments).
 * Attachment token counts are fetched from the extension on first encounter
 * and then cached by reference string to avoid recomputation while typing.
 *
 * Cache is module-level so it persists across hook re-mounts.
 */
import { useState, useEffect, useRef } from "react";
import { MESSAGE_TYPES } from "../types/messages";
import { countTokens } from "../utils/tokenizer";
import { sendMessage } from "./useMessageHandler";
import {
  parseAtReferences,
  parseSelectionReferences,
  parseSymbolReferences,
} from "@root/utils/FileReferenceParser";

// ============================================================================
// Module-level cache (persists across renders and re-mounts)
// ============================================================================

/** Token count cache: raw reference string → token count */
const attachmentTokenCache = new Map<string, number>();

/** References currently being fetched (avoid duplicate requests) */
const pendingRequests = new Set<string>();

/** Registered callbacks to invoke when new counts arrive */
const countUpdateCallbacks = new Set<() => void>();

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
      attachmentTokenCache.set(ref, count);
      pendingRequests.delete(ref);
      changed = true;
    }

    if (changed) {
      // Notify all registered hooks to re-compute their totals
      countUpdateCallbacks.forEach((cb) => cb());
    }
  });
}

// ============================================================================
// Reference extraction
// ============================================================================

/**
 * Extract all raw reference strings from prompt text.
 * Delegates to FileReferenceParser (single source of truth) and reconstructs
 * the original reference string from the parsed fields.
 */
function extractRawReferences(promptText: string): string[] {
  const refs: string[] = [];

  for (const ref of parseAtReferences(promptText)) {
    refs.push(`@${ref.path}`);
  }

  for (const ref of parseSelectionReferences(promptText)) {
    refs.push(`#selection:${ref.path}:${ref.startLine}-${ref.endLine}`);
  }

  for (const ref of parseSymbolReferences(promptText)) {
    refs.push(`#sym:${ref.path}:${ref.symbolName}:${ref.startLine}`);
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
 * - Raw prompt tokens are computed synchronously on every change.
 * - Attachment tokens are fetched from the extension asynchronously and cached.
 * - While attachment counts are loading, only raw prompt tokens are returned.
 */
export function useAttachmentTokenCount(promptText: string): number {
  ensureGlobalListener();

  const [, forceUpdate] = useState(0);
  const callbackRef = useRef<() => void>(() => {});

  // Keep callback ref up-to-date
  useEffect(() => {
    callbackRef.current = () => forceUpdate((n) => n + 1);
  });

  // Register/unregister a stable callback wrapper
  useEffect(() => {
    const cb = (): void => callbackRef.current();
    countUpdateCallbacks.add(cb);
    return () => {
      countUpdateCallbacks.delete(cb);
    };
  }, []);

  // Parse references and request uncached ones
  useEffect(() => {
    const refs = extractRawReferences(promptText);
    const uncached = refs.filter(
      (ref) => !attachmentTokenCache.has(ref) && !pendingRequests.has(ref)
    );

    if (uncached.length === 0) return;

    for (const ref of uncached) {
      pendingRequests.add(ref);
    }

    sendMessage(MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS, {
      references: uncached,
    });
  }, [promptText]);

  // Compute total: raw prompt tokens + cached attachment tokens
  const rawTokens = countTokens(promptText);
  const refs = extractRawReferences(promptText);
  const attachmentTokens = refs.reduce((sum, ref) => {
    return sum + (attachmentTokenCache.get(ref) ?? 0);
  }, 0);

  return rawTokens + attachmentTokens;
}
