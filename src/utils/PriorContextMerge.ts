import {
  type PriorContext,
  isPreviousStepsPriorContext,
} from "../types/CtrlYokeTypes";
import {
  PRIOR_CONTEXT_KEYWORDS,
  PRIOR_CONTEXT_REFERENCE_KINDS,
} from "../types/DashboardConstants";
import type { InlinePriorContextRef } from "./FileReferenceParser";

/** Canonical union of prior-context selectors in one prompt. */
export interface PriorContextMerge {
  /** Candidate queue indices needed to resolve `previous` outputs. */
  queueIndices: number[];
  explicitQueueIndices: number[];
  previousCount: number;
  includeAllQueue: boolean;
  includeAllFinalSteps: boolean;
  includePreviousFinalStep: boolean;
  /** Canonical contexts that preserve the merged request semantics. */
  contexts: PriorContext[];
}

/** Remove repeated queue/final-step items while preserving the first item. */
export function deduplicatePriorContextItems<
  T extends { index: number; type?: string },
>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type ?? "queue"}:${item.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Convert a parsed inline reference to the runtime's shared context shape. */
export function inlinePriorContextRefToPriorContext(
  ref: InlinePriorContextRef
): PriorContext {
  switch (ref.kind) {
    case PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS:
      return ref.count === undefined
        ? PRIOR_CONTEXT_KEYWORDS.PREVIOUS
        : { previous: ref.count };
    case PRIOR_CONTEXT_REFERENCE_KINDS.ALL:
      return PRIOR_CONTEXT_KEYWORDS.ALL;
    case PRIOR_CONTEXT_REFERENCE_KINDS.FINAL_STEP:
      return PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS;
    case PRIOR_CONTEXT_REFERENCE_KINDS.ALL_FINAL_STEP:
      return PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL;
    case PRIOR_CONTEXT_REFERENCE_KINDS.STEP:
      return ref.indices;
  }
}

/**
 * Merge all prior-context selectors used by one prompt. Previous selectors
 * take the largest requested count, explicit step selectors form a union, and
 * repeated indices are removed. The result is shared by runtime resolution
 * and editor preview counting.
 */
export function mergePriorContextReferences(
  contexts: readonly PriorContext[],
  groupStartBoundary: number
): PriorContextMerge {
  const explicitQueueIndices = new Set<number>();
  let previousCount = 0;
  let includeAllQueue = false;
  let includeAllFinalSteps = false;
  let includePreviousFinalStep = false;

  for (const context of contexts) {
    const requestedPrevious =
      context === PRIOR_CONTEXT_KEYWORDS.PREVIOUS
        ? 1
        : isPreviousStepsPriorContext(context)
          ? context.previous
          : 0;

    if (context === PRIOR_CONTEXT_KEYWORDS.ALL) {
      includeAllQueue = true;
    } else if (requestedPrevious > 0) {
      previousCount = Math.max(previousCount, requestedPrevious);
    } else if (context === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL) {
      includeAllFinalSteps = true;
    } else if (context === PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS) {
      includePreviousFinalStep = true;
    } else if (Array.isArray(context)) {
      for (const oneBasedIndex of context) {
        const index = oneBasedIndex - 1;
        if (index >= 0 && index < groupStartBoundary) {
          explicitQueueIndices.add(index);
        }
      }
    }
  }

  const queueIndices = new Set<number>(explicitQueueIndices);
  if (includeAllQueue || previousCount > 0) {
    for (let index = 0; index < groupStartBoundary; index++) {
      queueIndices.add(index);
    }
  }

  const mergedContexts: PriorContext[] = [];
  if (includeAllQueue) {
    mergedContexts.push(PRIOR_CONTEXT_KEYWORDS.ALL);
  } else if (previousCount > 0) {
    mergedContexts.push({ previous: previousCount });
  }
  const explicitIndices = [...explicitQueueIndices].sort((a, b) => a - b);
  if (explicitIndices.length > 0) {
    mergedContexts.push(explicitIndices.map((index) => index + 1));
  }
  if (includeAllFinalSteps) {
    mergedContexts.push(PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL);
  }
  if (includePreviousFinalStep) {
    mergedContexts.push(PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS);
  }

  return {
    queueIndices: [...queueIndices].sort((a, b) => a - b),
    explicitQueueIndices: [...explicitQueueIndices].sort((a, b) => a - b),
    previousCount,
    includeAllQueue,
    includeAllFinalSteps,
    includePreviousFinalStep,
    contexts: mergedContexts,
  };
}

const MERGED_PRIOR_CONTEXT_PREFIX = "merged:";

/** Encode merged contexts inside the existing opaque token-count reference. */
export function formatMergedPriorContextBody(
  contexts: readonly PriorContext[]
): string {
  return `${MERGED_PRIOR_CONTEXT_PREFIX}${encodeURIComponent(JSON.stringify(contexts))}`;
}

/** Decode only bodies produced by {@link formatMergedPriorContextBody}. */
export function parseMergedPriorContextBody(
  body: string
): PriorContext[] | null {
  if (!body.startsWith(MERGED_PRIOR_CONTEXT_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(
      decodeURIComponent(body.slice(MERGED_PRIOR_CONTEXT_PREFIX.length))
    );
    if (!Array.isArray(value)) return null;
    return value.every(isPriorContextShape) ? (value as PriorContext[]) : null;
  } catch {
    return null;
  }
}

function isPriorContextShape(value: unknown): boolean {
  if (typeof value === "string") {
    return Object.values(PRIOR_CONTEXT_KEYWORDS).includes(
      value as (typeof PRIOR_CONTEXT_KEYWORDS)[keyof typeof PRIOR_CONTEXT_KEYWORDS]
    );
  }
  if (Array.isArray(value)) {
    return value.every(
      (index) => Number.isSafeInteger(index) && (index as number) > 0
    );
  }
  if (typeof value === "object" && value !== null && "previous" in value) {
    const previous = (value as { previous?: unknown }).previous;
    return Number.isSafeInteger(previous) && (previous as number) > 0;
  }
  return false;
}
