import {
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { fuzzyMatchRanges } from "@root/completions/FuzzyRanking";
import {
  ATOMIC_REFERENCE_KINDS,
  CAPTURING_OUTPUT_PLACEHOLDER,
  COMPLETION_TRIGGERS,
  type CompletionTrigger,
} from "@root/types/DashboardConstants";
import { COMPLETION_KIND_ICONS } from "@root/types/SymbolKindConstants";
import { findWordStartTriggerIndex } from "@root/utils/ReferenceBoundary";
import {
  DEFAULT_COMPLETION_ICON,
  findContextReferenceMatches,
} from "@utils/atomicReferences";

export interface ExtensionCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  captureId?: string;
  sortText?: string;
  filterText?: string;
  /** Fuzzy relevance rank from the extension (see PlainCompletionItem.rank). */
  rank?: number;
  /**
   * Explicit codicon name overriding the kind-derived icon below (see
   * PlainCompletionItem.icon in CompletionCore.ts for why this exists —
   * some atomic reference kinds share a CompletionItemKind but need distinct
   * icons matching their chip). Must name a key in SYMBOL_ICON_COLORS.
   */
  icon?: string;
}

export interface PendingCompletionRequest {
  trigger: CompletionTrigger;
  query: string;
}

export type OutputCapturePickHandler = (
  captureId: string,
  from: number,
  to: number
) => void;

function shouldBypassCodeMirrorFiltering(
  request: PendingCompletionRequest | null
): boolean {
  if (!request) {
    return false;
  }

  return (
    request.trigger === "/" ||
    request.trigger === COMPLETION_TRIGGERS.PATH ||
    (request.trigger === "@" &&
      (request.query.startsWith('"') ||
        request.query.includes("/") ||
        request.query.includes("\\")))
  );
}

// Parses a single completion's insertText into the fields needed to key the
// symbol icon cache, iff it's a well-formed #sym: reference. Reuses
// findContextReferenceMatches (the same parser the chip/lint pipeline runs on
// the saved document text) instead of re-deriving the quoted-path format, so
// this never drifts from what the reference actually looks like once inserted.
function parseSingleSymbolReference(
  text: string
):
  | { path: string; symbolName: string; lineStart?: string; lineEnd?: string }
  | undefined {
  const [match] = findContextReferenceMatches(text);
  if (
    !match ||
    match.type !== ATOMIC_REFERENCE_KINDS.SYMBOL ||
    !match.path ||
    !match.symbolName
  ) {
    return undefined;
  }
  return {
    path: match.path,
    symbolName: match.symbolName,
    lineStart: match.lineStart,
    lineEnd: match.lineEnd,
  };
}

// Terminal context-reference completions self-terminate with a trailing space
// when picked, so text typed immediately after can't merge into the reference —
// and, in atomic mode, get absorbed into the chip (the "@file.tsxfoo" bug).
// "Keep typing" completions are exempt so progressive completion still works:
// directories ("dir/", whose sub-folder completions keep firing as you drill in)
// and colon-continuation tokens ("$step:"). Path-trigger completions replace the
// whole prompt with a file to load (never a chip), so they're exempt too.
// Mirrors the pasted-image handler, which likewise appends a trailing space to
// its inserted @ref (see resolvePendingPaste).
function withReferenceBoundarySpace(
  applyText: string,
  trigger: CompletionTrigger | undefined
): string {
  if (
    trigger === "/" ||
    trigger === COMPLETION_TRIGGERS.PATH ||
    applyText.length === 0 ||
    /\s$/.test(applyText)
  ) {
    return applyText;
  }
  // A quoted path ends in `"`; look past it for the real terminator.
  const core = applyText.endsWith('"') ? applyText.slice(0, -1) : applyText;
  if (core.endsWith("/") || core.endsWith(":")) {
    return applyText; // directory or "keep typing" token — expects more input
  }
  return `${applyText} `;
}

export function buildCodeMirrorCompletionResult(
  items: ExtensionCompletionItem[],
  from: number,
  request: PendingCompletionRequest | null,
  symbolIconCache?: Map<string, string>,
  onOutputCapturePicked?: OutputCapturePickHandler,
  escapeInsertText?: (text: string) => string
): CompletionResult {
  // A response the extension already fuzzy-ranked against the query is shown
  // as-is: CodeMirror's own matcher would both re-sort it and drop legitimate
  // matches (a one-character query only matches at the label start, and a
  // gapped two-character query never matches). Every keystroke re-queries the
  // extension (no `validFor`), so the list still narrows as the user types.
  const bypassFiltering =
    shouldBypassCodeMirrorFiltering(request) ||
    items.some((item) => item.rank !== undefined);
  const useFilterTextForMatching = !bypassFiltering;
  const completions = items.map((item, index) => {
    // Calculate boost from sortText.
    // Handles both numeric prefixes ("000_", "001_") and
    // bang-prefixed variants ("!000_", "!001_") used by git change items.
    let boost: number;
    if (item.sortText) {
      const prefixMatch = item.sortText.match(/^!?(\d+)_/);
      if (prefixMatch) {
        const prefix = parseInt(prefixMatch[1]);
        boost = 1000 - prefix * 100 - index * 0.01;
      } else {
        boost = -index;
      }
    } else {
      boost = -index;
    }

    const type =
      item.icon ??
      (item.kind !== undefined
        ? COMPLETION_KIND_ICONS[item.kind] || DEFAULT_COMPLETION_ICON
        : DEFAULT_COMPLETION_ICON);
    const matchLabel =
      useFilterTextForMatching && item.filterText
        ? item.filterText
        : item.label;
    const rawApplyText = item.insertText || item.label;
    // The slash is already present in the document at `from`. Extension-side
    // slash completions use the complete token as their insertText so the
    // same plain payload works for VS Code and webview consumers; CodeMirror
    // replaces only the text after that trigger character.
    const applyText =
      request?.trigger === "/" && rawApplyText.startsWith("/")
        ? rawApplyText.slice(1)
        : rawApplyText;
    // Final inserted text — a trailing boundary space for terminal references.
    const boundedApplyText = withReferenceBoundarySpace(
      applyText,
      request?.trigger
    );
    const applyValue = escapeInsertText
      ? escapeInsertText(boundedApplyText)
      : boundedApplyText;

    // The completion item's own `kind` is known synchronously, right now —
    // seed the chip icon cache from it on pick so the chip renders with the
    // correct symbol-* icon immediately, instead of showing
    // DEFAULT_COMPLETION_ICON until createContextReferenceLintExtension's
    // debounced round trip resolves. That round trip still runs afterward and
    // will correct the cache if it ever disagrees (e.g. the symbol moved
    // between listing the completion and picking it); this only short-circuits
    // the common case. It can't help a pasted or hand-typed reference, which
    // has no completion item to draw a kind from.
    //
    // The trigger char stays in the document at `from`; `insertText` is only
    // what's inserted after it (e.g. `sym:file:Name:1-2`, no leading `#`). So
    // reconstruct the reference as it will actually read in the document —
    // trigger + insertText — before parsing, or `#sym:` never matches and the
    // seed silently no-ops (the chip flashes the misc icon until the async pass
    // resolves it). `path` is a pseudo-trigger with no document char.
    const referenceText =
      request && request.trigger !== COMPLETION_TRIGGERS.PATH
        ? `${request.trigger}${applyText}`
        : applyText;
    const symbolRef =
      symbolIconCache && item.kind !== undefined
        ? parseSingleSymbolReference(referenceText)
        : undefined;

    return {
      label: matchLabel,
      displayLabel: matchLabel === item.label ? undefined : item.label,
      type,
      detail: item.detail,
      boost,
      // Don't prepend trigger - it stays in the document at position 'from'
      // We only replace from 'from + 1' onward for trigger-based completions.
      apply: item.captureId
        ? (
            view: EditorView,
            completion: Completion,
            _applyFrom: number,
            applyTo: number
          ) => {
            // Output captures always resolve to a fresh `@<path>` reference
            // (see resolvePendingCapture), regardless of whether this item
            // was picked via the `@` or `#` trigger. Unlike every other
            // completion here, the trigger character itself must be consumed
            // too — replacing only from the usual applyFrom (after the
            // trigger) would leave a stray `#` in place, or double up `@` into
            // `@@path`. Replace from the trigger's own position (`from`, the
            // outer closure variable) instead.
            view.dispatch({
              ...insertCompletionText(
                view.state,
                CAPTURING_OUTPUT_PLACEHOLDER,
                from,
                applyTo
              ),
              annotations: pickedCompletion.of(completion),
            });
            onOutputCapturePicked?.(
              item.captureId!,
              from,
              from + CAPTURING_OUTPUT_PLACEHOLDER.length
            );
          }
        : symbolRef
          ? (
              view: EditorView,
              completion: Completion,
              applyFrom: number,
              applyTo: number
            ) => {
              symbolIconCache!.set(
                symbolIconCacheKey(
                  symbolRef.path,
                  symbolRef.symbolName,
                  symbolRef.lineStart,
                  symbolRef.lineEnd
                ),
                type
              );
              // Mirrors applyCompletion()'s own string-apply path (see
              // @codemirror/autocomplete) so picking a symbol completion still
              // behaves identically to any other — same insert/cursor/scroll
              // behavior, same pickedCompletion annotation — with the cache
              // seed as the only addition.
              view.dispatch({
                ...insertCompletionText(
                  view.state,
                  applyValue,
                  applyFrom,
                  applyTo
                ),
                annotations: pickedCompletion.of(completion),
              });
            }
          : applyValue,
    };
  });

  const result: CompletionResult = {
    from: from + (request?.trigger === COMPLETION_TRIGGERS.PATH ? 0 : 1),
    options: completions,
  };

  if (bypassFiltering) {
    result.filter = false;
    // With filtering off CodeMirror computes no matched ranges of its own, so
    // supply them — with the same matcher the extension ranked with — so the
    // dropdown still highlights what the query matched.
    const highlightQuery = getCompletionHighlightQuery(request);
    if (highlightQuery) {
      result.getMatch = (completion) =>
        fuzzyMatchRanges(
          completion.displayLabel ?? completion.label,
          highlightQuery
        );
    }
  }

  return result;
}

// The part of the typed query a completion label is matched against: labels
// are basenames, so a typed directory (`src/ui/co`, `"my dir/fi`) contributes
// only its last segment.
function getCompletionHighlightQuery(
  request: PendingCompletionRequest | null
): string {
  if (!request) {
    return "";
  }
  const query = request.query.replace(/^"/, "");
  return query.slice(
    Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\")) + 1
  );
}

// Cache key for a progressive completion's full result. The trigger is always a
// single leading character, so different triggers can never collide regardless
// of the query that follows.
export function completionCacheKey(
  trigger: CompletionTrigger,
  query: string
): string {
  return `${trigger} ${query}`;
}

/**
 * Find the slash-token completion context immediately before the cursor.
 * Native slash commands are intentionally still eligible for the merged
 * ctrlyoke insertion list; selecting an entry makes the namespace explicit.
 */
export function findSlashCompletionContext(
  textBefore: string,
  lineFrom = 0
): { from: number; query: string } | null {
  const slashIndex = findWordStartTriggerIndex(textBefore, "/");
  if (slashIndex === -1) return null;

  const query = textBefore.slice(slashIndex + 1);
  if (!/^[a-zA-Z0-9:._-]*$/.test(query)) return null;

  return { from: lineFrom + slashIndex, query };
}

/** Resolve the trigger/query immediately before a CodeMirror completion cursor. */
export function findCustomCompletionContext(
  textBefore: string,
  lineFrom = 0
): { trigger: CompletionTrigger; query: string; from: number } | null {
  const lastAtIndex = findWordStartTriggerIndex(textBefore, "@");
  const lastHashIndex = findWordStartTriggerIndex(textBefore, "#");
  const lastTildeIndex = findWordStartTriggerIndex(textBefore, "~");
  const lastDollarIndex = findWordStartTriggerIndex(textBefore, "$");
  const lastBangIndex = findWordStartTriggerIndex(textBefore, "!");
  const slashContext = findSlashCompletionContext(textBefore, lineFrom);
  const lastSlashIndex = slashContext ? slashContext.from - lineFrom : -1;

  const maxIndex = Math.max(
    lastSlashIndex,
    lastAtIndex,
    lastHashIndex,
    lastTildeIndex,
    lastDollarIndex,
    lastBangIndex
  );
  if (maxIndex === -1) return null;

  let trigger: CompletionTrigger;
  let query: string;
  if (maxIndex === lastSlashIndex) {
    trigger = "/";
    query = slashContext!.query;
  } else if (maxIndex === lastAtIndex) {
    trigger = "@";
    query = textBefore.slice(lastAtIndex + 1);
  } else if (maxIndex === lastHashIndex) {
    trigger = "#";
    query = textBefore.slice(lastHashIndex + 1);
  } else if (maxIndex === lastTildeIndex) {
    trigger = "~";
    query = textBefore.slice(lastTildeIndex + 1);
  } else if (maxIndex === lastDollarIndex) {
    trigger = "$";
    query = textBefore.slice(lastDollarIndex + 1);
  } else {
    trigger = "!";
    query = textBefore.slice(lastBangIndex + 1);
  }

  const isInsideQuotedPath =
    trigger === "@" && query.startsWith('"') && !query.slice(1).includes('"');
  if (query.includes(" ") && !isInsideQuotedPath) return null;
  if (trigger === "#" && !/^[a-zA-Z0-9_/:.-]*$/.test(query)) return null;
  if (trigger === "~" && !/^[a-zA-Z0-9:_]*$/.test(query)) return null;
  if (trigger === "$" && !/^[a-zA-Z0-9:,\-]*$/.test(query)) return null;
  // Secret names intentionally stay uppercase-only. This also rejects `![` so
  // Markdown image syntax never opens the secret dropdown.
  if (trigger === "!" && !/^[A-Z0-9_]*$/.test(query)) return null;

  return { trigger, query, from: lineFrom + maxIndex };
}

// Stable identity for a #sym: reference, independent of its position in the
// document — correlates an async symbol-kind lookup (resolved in
// createContextReferenceLintExtension) back to the matching chip icon in
// createAtomicReferenceExtension without changing the reference's stored
// text/wire format.
export function symbolIconCacheKey(
  path: string,
  symbolName: string,
  lineStart?: string,
  lineEnd?: string
): string {
  return `${path}::${symbolName}::${lineStart ?? ""}-${lineEnd ?? ""}`;
}
