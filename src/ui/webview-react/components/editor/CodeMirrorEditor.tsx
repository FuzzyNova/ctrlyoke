import React, { useEffect, useRef, useCallback, useState } from "react";
import {
  EditorView,
  placeholder,
  keymap,
  ViewPlugin,
  ViewUpdate,
  Decoration,
  WidgetType,
  tooltips,
} from "@codemirror/view";
import { createThemeExtension } from "@utils/codemirrorTheme";
import { EditorState } from "@codemirror/state";
import { minimalSetup } from "codemirror";
import {
  autocompletion,
  completionKeymap,
  startCompletion,
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { history, historyKeymap, insertTab } from "@codemirror/commands";
import {
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
} from "@codemirror/search";
import {
  linter,
  lintKeymap,
  forceLinting,
  type Diagnostic,
} from "@codemirror/lint";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { getVsCodeApi } from "../../hooks/useVsCodeApi";
import { openContextReference } from "@utils/contextReferenceActions";
import {
  MESSAGE_TYPES,
  EDITOR_PLACEHOLDER_TEXT,
  RETRY_PROMPT_PLACEHOLDERS,
  PROMPT_EDITOR_INSERT_MODES,
  MAX_PASTED_IMAGE_BYTES,
  PASTING_IMAGE_PLACEHOLDER,
  PASTED_IMAGE_SAVE_TIMEOUT_MS,
  mimeTypeToImageExtension,
  type RetryPromptPlaceholder,
  type PromptEditorInsertRequest,
} from "../../types/messages";
import { WebviewLog } from "../../utils/logger";
import { useUiStore } from "../../store/uiStore";
import { useSettingsStore } from "../../store/settingsStore";
import { looksLikeFilePath } from "@root/utils/promptPathUtils";

// Typo.js spell checker (will be loaded from window.Typo)
declare global {
  interface Window {
    Typo: new (
      lang: string,
      aff: string,
      dic: string,
      options?: object
    ) => TypoChecker;
  }
}

interface TypoChecker {
  check: (word: string) => boolean;
  suggest: (word: string) => string[];
}

export type CodeMirrorEditorMode = "prompt" | "endCondition";
type CodeMirrorEditorSurface = "editor" | "input";

interface CodeMirrorEditorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  affUri: string;
  dicUri: string;
  /** When true, the editor is read-only (no edits allowed). */
  readOnly?: boolean;
  /** Prompt mode keeps standard completions; endCondition adds retry placeholders. */
  mode?: CodeMirrorEditorMode;
  /** Visual surface used by the editor theme. */
  surface?: CodeMirrorEditorSurface;
  className?: string;
  minHeightClassName?: string;
  maxHeightClassName?: string;
  /** Called when Alt+Enter is pressed. */
  onRun?: () => void;
  /** Called when Alt+Shift+Enter is pressed. */
  onQueue?: () => void;
  /** Number of steps that precede the currently-edited prompt (for $prior-context validation). */
  stepCount?: number;
  /** Whether a final step is configured (for $finalStep/$allFinalStep validation). */
  hasFinalStep?: boolean;
  /** Pending external insert request from VS Code context menus. */
  pendingInsertRequest?: PromptEditorInsertRequest | null;
  /** Called after a pending external insert has been applied. */
  onInsertApplied?: (requestId: string) => void;
}

type ContextReferenceType =
  | "file"
  | "directory"
  | "lineRange"
  | "symbol"
  | "git";

export interface ContextReferenceMatch {
  from: number;
  to: number;
  type: ContextReferenceType;
  path?: string;
  gitRef?: string;
  lineStart?: string;
  lineEnd?: string;
  symbolName?: string;
}

interface ContextReferenceValidationResult {
  id: string;
  exists: boolean;
  message?: string;
  /** CompletionItemKind, resolved live for #sym: refs so the chip can show the real symbol-kind icon. */
  symbolKind?: number;
  /**
   * "Did you mean?" replacement reference tokens (e.g. `@src/foo/Bar.ts`) for a
   * not-found @file / @directory ref, ranked by the extension host
   * (getPathSuggestions). Rendered as lint quick-fix actions. Absent/empty when
   * the reference resolves or no close match exists.
   */
  suggestions?: string[];
}

type CompletionTrigger = "@" | "#" | "~" | "$" | "path";

interface ExtensionCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  sortText?: string;
  filterText?: string;
}

interface PendingCompletionRequest {
  trigger: CompletionTrigger;
  query: string;
}

interface PendingPaste {
  from: number;
  to: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

const LINK_TOUCH_MOVE_THRESHOLD_PX = 10;
const LINK_TOUCH_LONG_PRESS_MS = 500;

const RETRY_PROMPT_PLACEHOLDER_METADATA: Record<
  RetryPromptPlaceholder,
  { detail: string; info: string }
> = {
  [RETRY_PROMPT_PLACEHOLDERS.STDOUT]: {
    detail: "stdout",
    info: "Validation script stdout",
  },
  [RETRY_PROMPT_PLACEHOLDERS.STDERR]: {
    detail: "stderr",
    info: "Validation script stderr",
  },
  [RETRY_PROMPT_PLACEHOLDERS.EXPECTED_VALUE]: {
    detail: "expected",
    info: "Configured expected value",
  },
  [RETRY_PROMPT_PLACEHOLDERS.ACTUAL_VALUE]: {
    detail: "actual",
    info: "Actual comparison value (resolved from compareSource)",
  },
  [RETRY_PROMPT_PLACEHOLDERS.EXIT_CODE]: {
    detail: "exitCode",
    info: "Numeric exit code from the validation script",
  },
  [RETRY_PROMPT_PLACEHOLDERS.COMPARE_SOURCE]: {
    detail: "compareSource",
    info: "Comparison source: stdout, stderr, exitCode, or auto",
  },
};

// Maps VS Code CompletionItemKind values to the codicon that best represents
// them — the single source shared by the completions dropdown (built from a
// live item's `kind`) and atomic reference chips (resolved asynchronously for
// #sym: refs; see symbolIconCacheKey/createContextReferenceLintExtension).
// Every name here ships in @vscode/codicons' codicon.css (checked against the
// pinned package version) — don't add one without verifying it exists there.
//
// kind 10 (Unit) is repurposed: getSelectionCompletions() (extension host)
// assigns it to the "current selection" item specifically because Unit is
// otherwise unused by any provider, giving that entry a stable,
// collision-free marker distinct from git (~) completions, which use
// Reference (17).
const COMPLETION_KIND_ICONS: Record<number, string> = {
  0: "symbol-text", // Text
  1: "symbol-method", // Method
  2: "symbol-function", // Function
  3: "symbol-constructor", // Constructor
  4: "symbol-field", // Field
  5: "symbol-variable", // Variable
  6: "symbol-class", // Class
  7: "symbol-interface", // Interface
  8: "symbol-module", // Module (also covers collapsed Namespace/Package)
  9: "symbol-property", // Property (also covers collapsed Key)
  10: "list-selection", // Unit — repurposed marker for the selection completion
  11: "symbol-value", // Value (also covers collapsed String/Number/Boolean/Array/Object/Null)
  12: "symbol-enum", // Enum
  13: "symbol-keyword", // Keyword
  14: "symbol-snippet", // Snippet
  15: "symbol-color", // Color
  16: "symbol-file", // File
  17: "source-control", // Reference — git (~) completions
  18: "folder", // Folder
  19: "symbol-enum-member", // EnumMember
  20: "symbol-constant", // Constant
  21: "symbol-struct", // Struct
  22: "symbol-event", // Event
  23: "symbol-operator", // Operator
  24: "symbol-type-parameter", // TypeParameter
};

const DEFAULT_COMPLETION_ICON = "symbol-misc";

export function getRetryPlaceholderCompletions(
  context: Pick<CompletionContext, "state" | "pos" | "explicit">,
  mode: CodeMirrorEditorMode = "endCondition"
): CompletionResult | null {
  if (mode !== "endCondition") return null;

  const line = context.state.doc.lineAt(context.pos);
  const textBefore = line.text.slice(0, context.pos - line.from);
  const openBraceIndex = textBefore.lastIndexOf("{");
  if (openBraceIndex === -1) return null;

  const afterBrace = textBefore.slice(openBraceIndex + 1);
  if (/[\s}]/.test(afterBrace)) return null;

  const from = line.from + openBraceIndex + 1;
  const options: Completion[] = Object.values(RETRY_PROMPT_PLACEHOLDERS).map(
    (placeholder) => ({
      label: placeholder,
      apply: `${placeholder}}`,
      type: "symbol-variable",
      detail: RETRY_PROMPT_PLACEHOLDER_METADATA[placeholder].detail,
      info: RETRY_PROMPT_PLACEHOLDER_METADATA[placeholder].info,
      boost: 1000,
    })
  );

  return {
    from,
    options,
  };
}

function shouldBypassCodeMirrorFiltering(
  request: PendingCompletionRequest | null
): boolean {
  if (!request) {
    return false;
  }

  return (
    request.trigger === "path" ||
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
  if (!match || match.type !== "symbol" || !match.path || !match.symbolName) {
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
  if (trigger === "path" || applyText.length === 0 || /\s$/.test(applyText)) {
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
  symbolIconCache?: Map<string, string>
): CompletionResult {
  const useFilterTextForMatching = !shouldBypassCodeMirrorFiltering(request);
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
      item.kind !== undefined
        ? COMPLETION_KIND_ICONS[item.kind] || DEFAULT_COMPLETION_ICON
        : DEFAULT_COMPLETION_ICON;
    const matchLabel =
      useFilterTextForMatching && item.filterText
        ? item.filterText
        : item.label;
    const applyText = item.insertText || item.label;
    // Final inserted text — a trailing boundary space for terminal references.
    const applyValue = withReferenceBoundarySpace(applyText, request?.trigger);

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
      request && request.trigger !== "path"
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
      apply: symbolRef
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
    from: from + (request?.trigger === "path" ? 0 : 1),
    options: completions,
  };

  if (shouldBypassCodeMirrorFiltering(request)) {
    result.filter = false;
  }

  return result;
}

// Cache key for a progressive completion's full result. The trigger is always a
// single leading character, so different triggers can never collide regardless
// of the query that follows.
function completionCacheKey(trigger: CompletionTrigger, query: string): string {
  return `${trigger} ${query}`;
}

export function buildPromptReferenceInsertion(
  docText: string,
  request: PromptEditorInsertRequest,
  selection: { from: number; to: number }
): { from: number; to: number; text: string } {
  const referencesText = request.references.join("\n");

  if (request.mode === PROMPT_EDITOR_INSERT_MODES.APPEND) {
    const prefix = docText.length > 0 && !docText.endsWith("\n") ? "\n" : "";
    return {
      from: docText.length,
      to: docText.length,
      text: `${prefix}${referencesText}`,
    };
  }

  const hasExplicitSelection = selection.from !== selection.to;
  const shouldSurroundWithNewlines =
    request.surroundWithNewlines ??
    (!hasExplicitSelection &&
      request.references.length > 1 &&
      selection.from > 0 &&
      selection.to < docText.length &&
      docText[selection.from - 1] !== "\n" &&
      docText[selection.to] !== "\n");

  const text = shouldSurroundWithNewlines
    ? `\n${referencesText}\n`
    : referencesText;

  return {
    from: selection.from,
    to: selection.to,
    text,
  };
}

/**
 * CodeMirrorEditor - CodeMirror 6 integration for prompt editing
 *
 * Features:
 * - VS Code theme integration
 * - Spell checking with Typo.js
 * - Custom autocomplete for @file and #file references
 * - Line wrapping
 * - History (undo/redo)
 * - Search support
 */
export const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = (props) => {
  const {
    id,
    value,
    onChange,
    affUri,
    dicUri,
    readOnly = false,
    mode = "prompt",
    surface = "editor",
    className,
    minHeightClassName,
    maxHeightClassName,
    onRun,
    onQueue,
    pendingInsertRequest,
    onInsertApplied,
  } = props;
  const stepCountRef = useRef(props.stepCount ?? 0);
  const hasFinalStepRef = useRef(props.hasFinalStep ?? false);
  const placeholderText = props.placeholder || EDITOR_PLACEHOLDER_TEXT.DEFAULT;

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Flips true once the EditorView is created; used as an effect dependency so
  // the pending-insert effect re-runs after a fresh mount (the insert effect
  // fires before the setup effect in definition order, so viewRef is null on
  // first execution — viewReady causes a second run once the view exists).
  const [viewReady, setViewReady] = useState(false);
  const typoCheckerRef = useRef<TypoChecker | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const onQueueRef = useRef(onQueue);
  const readOnlyRef = useRef(readOnly);
  // Tracks last reported signed-overflow to avoid redundant events
  const lastOverflowRef = useRef<number | null>(null);
  const pendingCompletionResolveRef = useRef<((value: any) => void) | null>(
    null
  );
  const pendingCompletionRequestRef = useRef<PendingCompletionRequest | null>(
    null
  );
  // Cache for a full completion result that arrived after its (already-resolved)
  // partial response — see the progressive `#` completion flow. Keyed by
  // trigger+query so the re-triggered completion source can serve it
  // synchronously without a second round trip to the extension host.
  const completionCacheRef = useRef<{
    key: string;
    result: CompletionResult;
  } | null>(null);
  const completionSeqRef = useRef(0);
  const validationSeqRef = useRef(0);
  const pendingValidationRequestsRef = useRef<
    Map<number, (value: ContextReferenceValidationResult[]) => void>
  >(new Map());
  // Pasted-image placeholders awaiting a SAVE_PASTED_IMAGE round trip. Keyed by
  // seq; the {from,to} range is kept live through edits via mapPos in the
  // updateListener so the placeholder is replaced in the right spot even if the
  // user keeps typing before the save completes.
  const pasteSeqRef = useRef(0);
  const pendingPastesRef = useRef<Map<number, PendingPaste>>(new Map());
  // Resolved #sym: symbol-kind icons, keyed by symbolIconCacheKey. Populated
  // asynchronously by createContextReferenceLintExtension's validation pass
  // and read by createAtomicReferenceExtension to upgrade a chip's icon from
  // DEFAULT_COMPLETION_ICON once the real kind is known. Persists across
  // re-renders of the setup effect (a fresh Map would just re-resolve).
  const symbolIconCacheRef = useRef<Map<string, string>>(new Map());
  // Reference-token → exists, populated by createContextReferenceLintExtension's
  // validation pass and read by createAtomicReferenceExtension to draw the
  // warning border on an unresolvable chip. Same shared-Map pattern as
  // symbolIconCacheRef; persists across setup-effect re-runs.
  const referenceValidityRef = useRef<Map<string, boolean>>(new Map());
  const vscode = getVsCodeApi();
  // When on, context references behave as atomic units (see
  // createAtomicReferenceExtension). Toggling recreates the editor via the
  // setup effect's dependency array.
  const atomicContextReferences = useSettingsStore(
    (state) => state.globalSettings.atomicContextReferences
  );
  const isMultiRootWorkspace = useSettingsStore(
    (state) => state.globalSettings.isMultiRoot
  );

  // Keep callback refs current
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  useEffect(() => {
    onQueueRef.current = onQueue;
  }, [onQueue]);

  // Update read-only state when prop changes (set contentEditable on the CodeMirror content DOM)
  useEffect(() => {
    readOnlyRef.current = readOnly;
    if (viewRef.current) {
      viewRef.current.contentDOM.contentEditable = readOnly ? "false" : "true";
    }
  }, [readOnly]);

  // Sync stepCount ref and re-run prior-context linter when step context changes
  useEffect(() => {
    stepCountRef.current = props.stepCount ?? 0;
    if (viewRef.current) {
      forceLinting(viewRef.current);
    }
  }, [props.stepCount]);

  useEffect(() => {
    hasFinalStepRef.current = props.hasFinalStep ?? false;
    if (viewRef.current) {
      forceLinting(viewRef.current);
    }
  }, [props.hasFinalStep]);

  useEffect(() => {
    if (!pendingInsertRequest || !viewRef.current || mode !== "prompt") {
      return;
    }

    const view = viewRef.current;
    const selection = view.state.selection.main;
    const change = buildPromptReferenceInsertion(
      view.state.doc.toString(),
      pendingInsertRequest,
      { from: selection.from, to: selection.to }
    );

    view.dispatch({
      changes: {
        from: change.from,
        to: change.to,
        insert: change.text,
      },
      selection: {
        anchor: change.from + change.text.length,
      },
      scrollIntoView: true,
      userEvent: "input",
    });
    view.focus();
    onInsertApplied?.(pendingInsertRequest.requestId);
  }, [mode, onInsertApplied, pendingInsertRequest, viewReady]);

  // Remeasure CodeMirror geometry on visual viewport changes (tooltip repositioning
  // on scroll; caret scroll-into-view on resize when the mobile keyboard opens).
  // Resize fires once after the keyboard fully opens — safe to dispatch scrollIntoView
  // synchronously. Scroll fires continuously during native scroll animations so we
  // only call requestMeasure there (no dispatches that could interfere).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const handleScroll = () => viewRef.current?.requestMeasure();
    const handleResize = () => {
      const view = viewRef.current;
      if (!view) return;
      view.requestMeasure();
      if (!view.hasFocus) return;
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, {
          y: "end",
          yMargin: 24,
        }),
      });
    };
    vv.addEventListener("resize", handleResize);
    vv.addEventListener("scroll", handleScroll);
    return () => {
      vv.removeEventListener("resize", handleResize);
      vv.removeEventListener("scroll", handleScroll);
    };
  }, []);

  // Re-measure after an ancestor panel is resized programmatically. This event
  // can be emitted from a CodeMirror measure write callback, where a synchronous
  // requestMeasure() is ignored because CodeMirror is already measuring.
  useEffect(() => {
    let frameId: number | null = null;
    const handleRemeasure = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = null;
        viewRef.current?.requestMeasure();
      });
    };
    window.addEventListener("fp-request-editor-remeasure", handleRemeasure);
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      window.removeEventListener(
        "fp-request-editor-remeasure",
        handleRemeasure
      );
    };
  }, []);

  // Tear down an orphaned CodeMirror MouseSelection (see destroyOrphanedMouseSelection).
  // When a drag-select ends outside the webview iframe, the editor's `mouseup` is
  // lost to the host and the MouseSelection lives on: every later transaction
  // (e.g. an arrow-key cursor move) makes it re-select from the last pointer
  // coords, snapping the caret back to position 0.
  //
  // These listeners are attached at the WINDOW level in the CAPTURE phase, NOT via
  // EditorView.domEventHandlers, on purpose: CodeMirror runs its keydown handlers
  // in a chain where the keymap handles bound keys (arrows, etc.) first and breaks
  // the chain (returns true → preventDefault), so an extension keydown handler
  // never fires for exactly the navigation keys a stuck user presses. A
  // capture-phase window listener runs before CodeMirror sees the key at all, so
  // destroying the orphan here means the subsequent cursor-move transaction no
  // longer re-arms the snap. `blur` covers focus leaving the panel. Both are
  // no-ops during normal use (no MouseSelection is active outside a live drag).
  useEffect(() => {
    const teardown = () => {
      if (viewRef.current) {
        destroyOrphanedMouseSelection(viewRef.current);
      }
    };
    window.addEventListener("keydown", teardown, true);
    window.addEventListener("blur", teardown);
    return () => {
      window.removeEventListener("keydown", teardown, true);
      window.removeEventListener("blur", teardown);
    };
  }, []);

  // Initialize Typo.js spell checker
  useEffect(() => {
    const initTypoChecker = async () => {
      try {
        const [affData, dicData] = await Promise.all([
          fetch(affUri).then((r) => r.text()),
          fetch(dicUri).then((r) => r.text()),
        ]);

        if (window.Typo) {
          typoCheckerRef.current = new window.Typo("en_US", affData, dicData, {
            platform: "any",
          });
        }
      } catch (error) {
        WebviewLog.error(
          `[CodeMirror] Failed to load Typo.js dictionaries: ${error instanceof Error ? error.message : String(error)}`
        );
        typoCheckerRef.current = null;
      }
    };

    initTypoChecker();
  }, [affUri, dicUri]);

  // Handle completion response from extension.
  //
  // Some triggers (currently `#`) answer progressively: a `partial` response
  // arrives first with the instant items (e.g. the current editor selection),
  // then a final response with the full list once the slow part (workspace
  // symbols) resolves. The partial resolves the pending CodeMirror completion
  // promise so the dropdown appears immediately; the final response — arriving
  // after that promise is already settled — is cached and applied by
  // re-triggering the completion source, which serves it synchronously.
  const handleCompletionResponse = useCallback(
    (
      items: ExtensionCompletionItem[],
      from: number,
      seq?: number,
      partial?: boolean
    ) => {
      // Discard stale responses from earlier requests
      if (seq !== undefined && seq !== completionSeqRef.current) {
        return;
      }

      const request = pendingCompletionRequestRef.current;
      const result = buildCodeMirrorCompletionResult(
        items,
        from,
        request,
        symbolIconCacheRef.current
      );

      if (partial) {
        // Deliver the instant items now, but keep the request context so the
        // forthcoming full response can be keyed and re-applied.
        if (pendingCompletionResolveRef.current) {
          pendingCompletionResolveRef.current(result);
          pendingCompletionResolveRef.current = null;
        }
        return;
      }

      // Final response. If the promise is still pending (no partial was sent,
      // e.g. there was no selection), resolve it directly.
      if (pendingCompletionResolveRef.current) {
        pendingCompletionResolveRef.current(result);
        pendingCompletionResolveRef.current = null;
        pendingCompletionRequestRef.current = null;
        return;
      }

      // A partial already resolved the promise and the dropdown is open. Cache
      // the full result and re-trigger completion so the source can serve it
      // from cache without another round trip.
      pendingCompletionRequestRef.current = null;
      if (request) {
        completionCacheRef.current = {
          key: completionCacheKey(request.trigger, request.query),
          result,
        };
        const view = viewRef.current;
        if (view) {
          startCompletion(view);
        }
      }
    },
    []
  );

  const validateContextReferences = useCallback(
    (
      references: Array<ContextReferenceMatch & { id: string }>
    ): Promise<ContextReferenceValidationResult[]> => {
      if (references.length === 0) {
        return Promise.resolve([]);
      }

      const seq = ++validationSeqRef.current;
      return new Promise<ContextReferenceValidationResult[]>((resolve) => {
        pendingValidationRequestsRef.current.set(seq, resolve);
        vscode.postMessage({
          type: MESSAGE_TYPES.VALIDATE_CONTEXT_REFS,
          references,
          seq,
        });
      });
    },
    [vscode]
  );

  // Replace a pending paste's tracked placeholder range with final text — a
  // `@ref ` on success or an empty string to remove it on failure/timeout — then
  // forget the entry. Ranges are clamped to the current doc length to survive
  // races with concurrent edits.
  const resolvePendingPaste = useCallback(
    (seq: number, replacement: string) => {
      const entry = pendingPastesRef.current.get(seq);
      if (!entry) return;
      clearTimeout(entry.timeoutId);
      pendingPastesRef.current.delete(seq);
      const view = viewRef.current;
      if (!view) return;
      const docLen = view.state.doc.length;
      const from = Math.min(entry.from, docLen);
      const to = Math.min(Math.max(entry.to, from), docLen);
      view.dispatch({ changes: { from, to, insert: replacement } });
    },
    []
  );

  const handlePastedImageSaved = useCallback(
    (seq: number, relativePath?: string, error?: string) => {
      if (error || !relativePath) {
        resolvePendingPaste(seq, "");
        const messageText = error || "Failed to save pasted image";
        WebviewLog.error(
          `[CodeMirror] Pasted image save failed: ${messageText}`
        );
        useUiStore.getState().showToast(messageText, "error");
        return;
      }
      // Trailing space terminates the @ref token so the user can keep typing.
      resolvePendingPaste(seq, `@${relativePath} `);
    },
    [resolvePendingPaste]
  );

  // Insert a placeholder at the cursor, then read the image and ship it to the
  // extension host to be saved. The placeholder is reconciled by
  // handlePastedImageSaved when PASTED_IMAGE_SAVED arrives (or on timeout).
  const processPastedImageFile = useCallback(
    (file: File, mimeType: string, view: EditorView) => {
      const pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: PASTING_IMAGE_PLACEHOLDER },
        selection: { anchor: pos + PASTING_IMAGE_PLACEHOLDER.length },
      });

      const seq = ++pasteSeqRef.current;
      const timeoutId = setTimeout(() => {
        handlePastedImageSaved(seq, undefined, "Timed out saving pasted image");
      }, PASTED_IMAGE_SAVE_TIMEOUT_MS);
      pendingPastesRef.current.set(seq, {
        from: pos,
        to: pos + PASTING_IMAGE_PLACEHOLDER.length,
        timeoutId,
      });

      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const base64 = result.slice(result.indexOf(",") + 1);
        // Approximate decoded size before shipping a large payload via postMessage.
        const approxBytes = Math.floor((base64.length * 3) / 4);
        if (!base64) {
          handlePastedImageSaved(seq, undefined, "Failed to read pasted image");
          return;
        }
        if (approxBytes > MAX_PASTED_IMAGE_BYTES) {
          handlePastedImageSaved(
            seq,
            undefined,
            "Pasted image exceeds the maximum allowed size"
          );
          return;
        }
        vscode.postMessage({
          type: MESSAGE_TYPES.SAVE_PASTED_IMAGE,
          seq,
          dataBase64: base64,
          mimeType,
        });
      };
      reader.onerror = () => {
        handlePastedImageSaved(seq, undefined, "Failed to read pasted image");
      };
      reader.readAsDataURL(file);
    },
    [vscode, handlePastedImageSaved]
  );

  // Paste handler: intercept clipboard images, let everything else fall through
  // to CodeMirror's default paste. Supports multiple images in one clipboard.
  const handleImagePaste = useCallback(
    (event: ClipboardEvent, view: EditorView): boolean => {
      const items = event.clipboardData?.items;
      if (!items) return false;
      const imageItems = Array.from(items).filter((item) =>
        item.type.startsWith("image/")
      );
      if (imageItems.length === 0) return false;

      event.preventDefault();
      for (const item of imageItems) {
        if (!mimeTypeToImageExtension(item.type)) {
          useUiStore
            .getState()
            .showToast(`Unsupported image type: ${item.type}`, "error");
          continue;
        }
        const file = item.getAsFile();
        if (!file) continue;
        processPastedImageFile(file, item.type, view);
      }
      return true;
    },
    [processPastedImageFile]
  );

  // Clear any outstanding paste timeouts when the component unmounts.
  useEffect(() => {
    const pending = pendingPastesRef.current;
    return () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timeoutId);
      }
      pending.clear();
    };
  }, []);

  // Listen for completion and context-reference validation responses from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === MESSAGE_TYPES.COMPLETIONS_RESPONSE) {
        handleCompletionResponse(
          message.items || [],
          message.from,
          message.seq,
          message.partial
        );
      } else if (message.type === MESSAGE_TYPES.CONTEXT_REFS_VALIDATION) {
        const resolve = pendingValidationRequestsRef.current.get(message.seq);
        if (resolve) {
          pendingValidationRequestsRef.current.delete(message.seq);
          resolve(message.results || []);
        }
      } else if (message.type === MESSAGE_TYPES.PASTED_IMAGE_SAVED) {
        handlePastedImageSaved(
          message.seq,
          message.relativePath,
          message.error
        );
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleCompletionResponse, handlePastedImageSaved]);

  // Custom completions source
  const customCompletions = useCallback(
    (
      context: any
    ): CompletionResult | Promise<CompletionResult | null> | null => {
      // Use lastIndexOf to find the rightmost trigger character, mirroring
      // PromptCompletionProvider's approach. Using matchBefore with @"[^"]* was
      // buggy: when the prompt contained a literal "@" (e.g. `"@"`), the pattern
      // would match from that @" all the way to the cursor (since [^"]* greedily
      // consumes everything that isn't a closing quote), swallowing any real
      // @path trigger typed later on the same line.
      const lineObj = context.state.doc.lineAt(context.pos);
      const textBefore = lineObj.text.slice(0, context.pos - lineObj.from);

      const lastAtIndex = textBefore.lastIndexOf("@");
      const lastHashIndex = textBefore.lastIndexOf("#");
      const lastTildeIndex = textBefore.lastIndexOf("~");
      const lastDollarIndex = textBefore.lastIndexOf("$");

      const maxIndex = Math.max(
        lastAtIndex,
        lastHashIndex,
        lastTildeIndex,
        lastDollarIndex
      );
      if (maxIndex === -1) return null;

      let trigger: string;
      let afterTrigger: string;

      if (maxIndex === lastAtIndex) {
        trigger = "@";
        afterTrigger = textBefore.slice(lastAtIndex + 1);
      } else if (maxIndex === lastHashIndex) {
        trigger = "#";
        afterTrigger = textBefore.slice(lastHashIndex + 1);
      } else if (maxIndex === lastTildeIndex) {
        trigger = "~";
        afterTrigger = textBefore.slice(lastTildeIndex + 1);
      } else {
        trigger = "$";
        afterTrigger = textBefore.slice(lastDollarIndex + 1);
      }

      // For @: allow spaces inside a quoted path (@"path with spaces/..."),
      // otherwise bail out if there's a space (no partial match mid-sentence).
      const isInsideQuotedPath =
        trigger === "@" &&
        afterTrigger.startsWith('"') &&
        !afterTrigger.slice(1).includes('"');

      if (afterTrigger.includes(" ") && !isInsideQuotedPath) return null;

      // For # and ~: validate character class (neither supports quoted paths)
      if (trigger === "#" && !/^[a-zA-Z0-9_/:.-]*$/.test(afterTrigger))
        return null;
      if (trigger === "~" && !/^[a-zA-Z0-9:_]*$/.test(afterTrigger))
        return null;
      if (trigger === "$" && !/^[a-zA-Z0-9:,\-]*$/.test(afterTrigger))
        return null;

      const from = lineObj.from + maxIndex; // absolute position of trigger char

      // Serve a full result cached by a progressive (partial→full) response for
      // this exact trigger+query synchronously — no second round trip. Checked
      // before the empty-query guard so it also applies when only the trigger
      // char has been typed (e.g. `#` with an active selection).
      const cacheKey = completionCacheKey(
        trigger as CompletionTrigger,
        afterTrigger
      );
      if (completionCacheRef.current?.key === cacheKey) {
        const cached = completionCacheRef.current.result;
        completionCacheRef.current = null;
        return cached;
      }

      if (from === context.pos && !context.explicit) return null;

      // Assign a sequence number so stale responses can be discarded
      const seq = ++completionSeqRef.current;

      // A fresh request invalidates any lingering progressive cache (e.g. a
      // stale selection snapshot from a prior dropdown that was dismissed).
      completionCacheRef.current = null;

      // Request completions from extension host
      return new Promise<CompletionResult | null>((resolve) => {
        // Cancel any pending completion that will never be fulfilled
        if (pendingCompletionResolveRef.current) {
          pendingCompletionResolveRef.current(null);
        }
        pendingCompletionResolveRef.current = resolve;
        pendingCompletionRequestRef.current = {
          trigger: trigger as CompletionTrigger,
          query: afterTrigger,
        };

        vscode.postMessage({
          type: MESSAGE_TYPES.REQUEST_COMPLETIONS,
          trigger,
          prefix: trigger + afterTrigger,
          position: from,
          seq,
        });
      });
    },
    [vscode]
  );

  // Path-only completions — fires when the entire editor content is a lone file path.
  // Suggests .prompt.md / .md / .txt files from the workspace as replacements.
  const pathCompletions = useCallback(
    (context: any): Promise<CompletionResult | null> | null => {
      // Match paths starting with ./ ../ / or a Windows drive letter
      const pathPattern = isMultiRootWorkspace
        ? /(?:\.\.?\/|\/|[a-zA-Z]:[/\\]|[^\s/\\]+[/\\])[^\s\n]*/
        : /(?:\.\.?\/|\/|[a-zA-Z]:[/\\])[^\s\n]*/;
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

      WebviewLog.debug(
        `[CodeMirror] pathCompletions triggered: "${before.text}" from=${before.from}`
      );

      const seq = ++completionSeqRef.current;

      return new Promise<CompletionResult | null>((resolve) => {
        if (pendingCompletionResolveRef.current) {
          pendingCompletionResolveRef.current(null);
        }
        pendingCompletionResolveRef.current = resolve;
        pendingCompletionRequestRef.current = {
          trigger: "path",
          query: before.text,
        };

        vscode.postMessage({
          type: MESSAGE_TYPES.REQUEST_COMPLETIONS,
          trigger: "path",
          prefix: before.text,
          position: before.from,
          seq,
        });
      });
    },
    [isMultiRootWorkspace, vscode]
  );

  const retryPlaceholderCompletions = useCallback(
    (context: CompletionContext): CompletionResult | null => {
      return getRetryPlaceholderCompletions(context, mode);
    },
    [mode]
  );

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorRef.current) return;

    // Create editor instance
    const view = new EditorView({
      doc: value,
      extensions: [
        minimalSetup,
        createFindKeyHandlerExtension(),
        ...(atomicContextReferences
          ? [
              createAtomicReferenceExtension(
                symbolIconCacheRef.current,
                referenceValidityRef.current
              ),
            ]
          : []),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnlyRef.current),
        history(),
        keymap.of([
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          ...lintKeymap,
          {
            key: "Alt-Shift-Enter",
            run: () => {
              if (!onQueueRef.current) return false;
              onQueueRef.current();
              return true;
            },
          },
          {
            key: "Alt-Enter",
            run: () => {
              if (!onRunRef.current) return false;
              onRunRef.current();
              return true;
            },
          },
          // Fallback: insert a tab character when no completion is active.
          // completionKeymap binds Tab to acceptCompletion (returns true only
          // when a completion dropdown is open), so this only fires when there
          // is nothing to accept — preventing Tab from moving DOM focus away.
          { key: "Tab", run: insertTab },
        ]),
        placeholder(placeholderText),
        createThemeExtension(surface),
        createPromptDecorationThemeExtension(),
        createLinterThemeExtension(),
        createActiveLineHighlightExtension(),
        highlightSelectionMatches({ minSelectionLength: 2 }),
        createSpellCheckExtension(typoCheckerRef, isMultiRootWorkspace),
        createContextReferenceLintExtension(
          validateContextReferences,
          symbolIconCacheRef.current,
          referenceValidityRef.current
        ),
        // Mount autocomplete tooltips on document.body so they escape the
        // overflow:hidden ancestors (critical on iOS where CodeMirror forces
        // position:absolute for tooltips, which causes them to be clipped and
        // hidden behind the EditorFooter). The body container is outside any
        // overflow:hidden chain, so the tooltip renders above the footer.
        // We intentionally omit tooltipSpace here — the default windowSpace
        // (document.documentElement.clientHeight) matches what coordsAtPos
        // uses for cursor Y, avoiding the mismatch that would hide the tooltip
        // when vv.offsetTop is non-zero (iOS browser chrome height).
        tooltips({ parent: document.body }),
        autocompletion({
          override:
            mode === "endCondition"
              ? [
                  retryPlaceholderCompletions,
                  customCompletions,
                  pathCompletions,
                ]
              : [customCompletions, pathCompletions],
          activateOnTyping: true,
          closeOnBlur: true,
          optionClass: (completion) =>
            `cm-completion-${completion.type || DEFAULT_COMPLETION_ICON}`,
          // `type` is a codicon name (see COMPLETION_KIND_ICONS), not
          // CodeMirror's own semantic bucket vocabulary — icons:false turns
          // off CM's built-in char-glyph icon renderer (ƒ, ○, 𝑥, ...) so
          // this is the only icon source, for every completion kind, not
          // just file/folder.
          icons: false,
          addToOptions: [
            {
              render: (completion) => {
                const icon = document.createElement("span");
                icon.className = `cm-completionIcon codicon codicon-${completion.type || DEFAULT_COMPLETION_ICON}`;
                return icon;
              },
              position: 20, // Position before label
            },
          ],
        }),
        ...(mode === "prompt"
          ? [
              EditorView.domEventHandlers({
                paste: (event, view) =>
                  handleImagePaste(event as ClipboardEvent, view),
              }),
            ]
          : []),
        createFencedBlockDecorationExtension(),
        // In atomic mode, createAtomicReferenceExtension already covers every
        // range these two would mark (same findContextReferenceMatches /
        // findInlinePriorContextRefs tokens) with a replace-widget decoration.
        // Keeping both active means two decoration sources fight over the
        // exact same range — a replace widget from one plugin and a mark from
        // another — which is unnecessary and was implicated in clicks leaving
        // the editor unresponsive. createFileRefDecorationExtension stays on
        // regardless: it covers lone prompt-path prompts (no @/#/~/$ trigger),
        // which findAtomicReferences deliberately excludes, so atomic mode
        // never puts a chip there.
        ...(atomicContextReferences
          ? []
          : [
              createLinkDecorationExtension(),
              createPriorContextDecorationExtension(),
            ]),
        createFileRefDecorationExtension(isMultiRootWorkspace),
        createPriorContextLintExtension(stepCountRef, hasFinalStepRef),
        createClickHandlerExtension(vscode, stepCountRef),
        // iOS Safari: enable the word-suggestion bar above the keyboard and
        // autocapitalization. CodeMirror defaults these to "off" which suppresses
        // the native suggestion strip entirely on iPhone/iPad.
        EditorView.contentAttributes.of({
          autocorrect: "on",
          autocapitalize: "sentences",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newValue = update.state.doc.toString();
            onChangeRef.current(newValue);
            // Keep pasted-image placeholder ranges pinned to their text as the
            // user edits before the async save round trip resolves them.
            if (pendingPastesRef.current.size > 0) {
              for (const entry of pendingPastesRef.current.values()) {
                entry.from = update.changes.mapPos(entry.from, -1);
                entry.to = update.changes.mapPos(entry.to, 1);
              }
            }
          }
          // Selection-reset diagnostics live in the transactionFilter
          // (createSelectionResetDiagnosticExtension) so we can capture the
          // dispatching call stack — an updateListener runs after the fact and
          // cannot identify who moved the caret.
          if (
            mode === "prompt" &&
            (update.docChanged || update.geometryChanged)
          ) {
            const cause = update.docChanged ? "doc" : "geometry";
            update.view.requestMeasure({
              read(v: EditorView) {
                // contentHeight is CodeMirror's computed document height — unlike
                // scrollDOM.scrollHeight it CAN go below clientHeight when content
                // is deleted, giving us the negative value we need to trigger shrink.
                const so = v.contentHeight - v.scrollDOM.clientHeight;
                return so;
              },
              write(signedOverflow: number) {
                if (!viewRef.current) return;
                const changed =
                  lastOverflowRef.current === null ||
                  Math.abs(signedOverflow - lastOverflowRef.current) >= 1;
                if (changed) {
                  lastOverflowRef.current = signedOverflow;
                  window.dispatchEvent(
                    new CustomEvent("fp-editor-overflow-change", {
                      detail: { signedOverflow, cause },
                    })
                  );
                }
              },
            });
          }
        }),
      ],
      parent: editorRef.current,
    });

    viewRef.current = view;
    setViewReady(true);

    // Dispatch ready event
    window.dispatchEvent(new CustomEvent("codemirror-ready"));

    // Check overflow immediately after mount so loading an existing prompt
    // with lots of content triggers auto-expand (treat as a doc event).
    if (mode === "prompt") {
      view.requestMeasure({
        read(v: EditorView) {
          return v.contentHeight - v.scrollDOM.clientHeight;
        },
        write(signedOverflow: number) {
          if (!viewRef.current) return;
          if (Math.abs(signedOverflow - (lastOverflowRef.current ?? 0)) >= 1) {
            lastOverflowRef.current = signedOverflow;
            window.dispatchEvent(
              new CustomEvent("fp-editor-overflow-change", {
                detail: { signedOverflow, cause: "doc" },
              })
            );
          }
        },
      });
    }

    return () => {
      view.destroy();
      viewRef.current = null;
      setViewReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    placeholderText,
    customCompletions,
    pathCompletions,
    retryPlaceholderCompletions,
    validateContextReferences,
    handleImagePaste,
    mode,
    surface,
    atomicContextReferences,
    isMultiRootWorkspace,
  ]);
  // `value` is intentionally omitted — the setup effect initializes the editor
  // once; value changes are handled by the separate effect below.
  // `vscode` is a stable singleton — never changes.

  // Update editor content when value prop changes externally
  useEffect(() => {
    if (!viewRef.current) return;

    const currentValue = viewRef.current.state.doc.toString();
    if (currentValue !== value) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: currentValue.length,
          insert: value,
        },
      });
    }
  }, [value]);

  const editorClassName = [
    surface === "input"
      ? "w-full codemirror-editor"
      : "h-full w-full flex-1 min-h-0 codemirror-editor",
    minHeightClassName,
    maxHeightClassName,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <div id={id} ref={editorRef} className={editorClassName} />;
};

// Fixes the "cursor stuck at the start of the editor" bug in the VS Code webview.
//
// Selecting text by dragging creates a CodeMirror `MouseSelection`, normally torn
// down on `mouseup`. Inside the webview iframe the mouseup can land outside the
// iframe and never reach the editor's document, so the MouseSelection is orphaned.
// A live MouseSelection re-derives the selection from the *last pointer position*
// in two ways — an auto-scroll `setInterval` (when the drag reached a viewport
// edge) and, more persistently, its `update()` hook which fires a delayed
// `select()` after every subsequent transaction. So each later edit/cursor move
// snaps the caret back to position 0 (the last pointer coords near the top-left).
// CodeMirror self-heals on the next `mousemove` (buttons===0 → destroy), but
// keyboard navigation produces no mousemove, so arrow keys can't escape it.
//
// Calling `MouseSelection.destroy()` clears the interval, removes its listeners,
// and nulls `inputState.mouseSelection` so the per-transaction re-select stops
// firing. By the time any key is pressed the mouse button is necessarily up, so a
// stale MouseSelection is always an orphan — see the window-level capture-phase
// `keydown`/`blur` teardown in the component (NOT EditorView.domEventHandlers,
// whose keydown handler is pre-empted by the keymap for bound keys like arrows).
// `inputState.mouseSelection` is not in CodeMirror's public typings; access it
// defensively so a future internal change degrades to a no-op instead of throwing.
export function destroyOrphanedMouseSelection(view: EditorView): void {
  const inputState = (
    view as unknown as {
      inputState?: { mouseSelection?: { destroy?: () => void } | null };
    }
  ).inputState;
  inputState?.mouseSelection?.destroy?.();
}

// Intercept Ctrl/Cmd+F before it can bubble to the page — without this, the
// keystroke would also reach OutputSection's window-level "open find" listener.
// We open CodeMirror's own search panel directly so searchKeymap's Mod-f
// binding never needs to fire, and stop the event outright so it can't
// trigger anything else listening on ancestor elements or window.
function createFindKeyHandlerExtension() {
  return EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openSearchPanel(view);
        return true;
      }
      return false;
    },
  });
}

export interface AtomicReferenceChip {
  from: number;
  to: number;
  /** Codicon name (without the `codicon-` prefix) shown as the chip's leading icon. */
  icon: string;
  /** Short label shown in place of the full reference text. */
  label: string;
  /** Full original reference text — surfaced as the chip's hover title. */
  title: string;
  /** data-* attributes forwarded to the existing link click/tap handler. */
  attrs: Record<string, string>;
  /**
   * True once the async validation pass (createContextReferenceLintExtension)
   * has confirmed the reference doesn't resolve — drives the warning-colored
   * border. Undefined until validated (no border), so a freshly-typed chip
   * isn't flagged before the debounced check runs. Only context references
   * (@/#/~) are validated this way; prior-context ($) chips leave it undefined.
   */
  invalid?: boolean;
}

// Basename of a workspace-relative path, tolerant of a trailing slash.
function referenceBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

// Compact label for a ~git reference: keywords stay as-is, a commit hash is
// shortened to 7 chars (the full hash remains in the document + hover title).
function gitReferenceLabel(gitRef: string): string {
  if (gitRef === "diff" || gitRef === "staged") return gitRef;
  const stash = gitRef.match(/^stash:(\d+)$/);
  if (stash) return `stash ${stash[1]}`;
  return gitRef.slice(0, 7);
}

const PRIOR_CONTEXT_CHIP_LABELS: Record<
  Exclude<InlinePriorContextRef["kind"], "step">,
  string
> = {
  previous: "previous",
  all: "all steps",
  finalStep: "final step",
  allFinalStep: "all final",
};

// Looks up the codicon for a resolved #sym: reference, keyed by
// symbolIconCacheKey(path, symbolName, lineStart, lineEnd). Returns undefined
// until (if ever) the async lookup in createContextReferenceLintExtension
// resolves it, in which case the chip falls back to DEFAULT_COMPLETION_ICON.
type SymbolIconResolver = (
  path: string,
  symbolName: string,
  lineStart?: string,
  lineEnd?: string
) => string | undefined;

function describeContextReferenceChip(
  ref: ContextReferenceMatch,
  docText: string,
  getSymbolIcon?: SymbolIconResolver
): Omit<AtomicReferenceChip, "from" | "to"> {
  const title = docText.slice(ref.from, ref.to);
  const attrs: Record<string, string> = { "data-type": ref.type };

  switch (ref.type) {
    case "directory":
      attrs["data-path"] = ref.path ?? "";
      return {
        icon: "folder",
        label: `${referenceBasename(ref.path ?? "")}/`,
        title,
        attrs,
      };
    case "lineRange":
      attrs["data-path"] = ref.path ?? "";
      if (ref.lineStart) attrs["data-line-start"] = ref.lineStart;
      if (ref.lineEnd) attrs["data-line-end"] = ref.lineEnd;
      return {
        icon: "list-selection",
        label: `${referenceBasename(ref.path ?? "")}:${ref.lineStart}-${ref.lineEnd}`,
        title,
        attrs,
      };
    case "symbol":
      attrs["data-path"] = ref.path ?? "";
      if (ref.symbolName) attrs["data-symbol-name"] = ref.symbolName;
      if (ref.lineStart) attrs["data-line-start"] = ref.lineStart;
      if (ref.lineEnd) attrs["data-line-end"] = ref.lineEnd;
      return {
        icon:
          (ref.path &&
            ref.symbolName &&
            getSymbolIcon?.(
              ref.path,
              ref.symbolName,
              ref.lineStart,
              ref.lineEnd
            )) ||
          DEFAULT_COMPLETION_ICON,
        label: ref.symbolName || referenceBasename(ref.path ?? ""),
        title,
        attrs,
      };
    case "git":
      if (ref.gitRef) attrs["data-git-ref"] = ref.gitRef;
      return {
        icon: "source-control",
        label: gitReferenceLabel(ref.gitRef ?? ""),
        title,
        attrs,
      };
    case "file":
    default:
      attrs["data-path"] = ref.path ?? "";
      return {
        icon: "symbol-file",
        label: referenceBasename(ref.path ?? ""),
        title,
        attrs,
      };
  }
}

function describePriorContextChip(
  ref: InlinePriorContextRef,
  docText: string
): Omit<AtomicReferenceChip, "from" | "to"> {
  const title = docText.slice(ref.from, ref.to);
  const dataRef =
    ref.kind === "step" ? `step:${ref.indices?.join(",") ?? ""}` : ref.kind;
  const label =
    ref.kind === "step"
      ? `step ${ref.indices?.join(",") ?? ""}`
      : PRIOR_CONTEXT_CHIP_LABELS[ref.kind];
  return {
    icon: "book",
    label,
    title,
    attrs: { "data-type": "priorContext", "data-ref": dataRef },
  };
}

// Enrich every atomic reference with the metadata needed to render its chip.
// Covers @/#/~ references and $ prior-context refs — the same tokens the link
// decorations render — and skips refs inside fenced blocks (not decorated as
// links) and lone prompt-path prompts (no @/#/~/$ trigger). Returned sorted by
// start with overlaps dropped (widest wins) so the resulting decoration/atomic
// RangeSet stays well-formed — e.g. a `$token` that falls inside an `@path.ts`
// match is absorbed by the enclosing reference.
export function findAtomicReferences(
  docText: string,
  getSymbolIcon?: SymbolIconResolver,
  getValidity?: (referenceToken: string) => boolean | undefined
): AtomicReferenceChip[] {
  const fencedRanges = getFencedBlockRanges(docText);

  const candidates: Array<{
    from: number;
    to: number;
    invalid?: boolean;
    describe: () => Omit<AtomicReferenceChip, "from" | "to">;
  }> = [
    ...findContextReferenceMatches(docText).map((ref) => ({
      from: ref.from,
      to: ref.to,
      // Keyed by the exact reference token (validity is content-based, so two
      // identical tokens share a result). `true` only once the async pass
      // confirmed it doesn't resolve; left undefined while unvalidated or
      // resolvable so a freshly-typed chip isn't flagged and no border shows.
      invalid:
        getValidity?.(docText.slice(ref.from, ref.to)) === false
          ? true
          : undefined,
      describe: () => describeContextReferenceChip(ref, docText, getSymbolIcon),
    })),
    ...findInlinePriorContextRefs(docText).map((ref) => ({
      from: ref.from,
      to: ref.to,
      describe: () => describePriorContextChip(ref, docText),
    })),
  ]
    .filter((ref) => !isInFencedBlock(ref.from, ref.to, fencedRanges))
    .sort((a, b) => a.from - b.from || b.to - a.to);

  const chips: AtomicReferenceChip[] = [];
  let lastTo = -1;
  for (const candidate of candidates) {
    if (candidate.from < lastTo) continue; // overlaps a wider range already kept
    chips.push({
      ...candidate.describe(),
      from: candidate.from,
      to: candidate.to,
      invalid: candidate.invalid,
    });
    lastTo = candidate.to;
  }
  return chips;
}

// Inline widget that renders a context reference as a compact, outlined chip
// showing just the file/folder name (or short git hash / prior-context label)
// instead of the full path. The full reference text stays in the document (so
// context expansion is unchanged) and is surfaced on hover via the title.
class AtomicReferenceWidget extends WidgetType {
  constructor(private readonly chip: AtomicReferenceChip) {
    super();
  }

  eq(other: AtomicReferenceWidget): boolean {
    return (
      other.chip.icon === this.chip.icon &&
      other.chip.label === this.chip.label &&
      other.chip.title === this.chip.title &&
      other.chip.invalid === this.chip.invalid
    );
  }

  ignoreEvent(event: Event): boolean {
    // WidgetType ignores every event by default. That is useful for controls
    // embedded in an editor, but these chips deliberately reuse the editor's
    // delegated link handlers below. Let only those events reach CodeMirror;
    // in particular, keep mousedown ignored so its built-in handler cannot
    // create a MouseSelection at an indeterminate position inside a replace
    // widget (the source of the stuck-cursor behavior).
    return !ATOMIC_REFERENCE_LINK_EVENTS.has(event.type);
  }

  toDOM(): HTMLElement {
    // cm-link + the data-* attributes let the shared click/tap handler open
    // the reference while recognizing this element's button-like chip UX.
    const chip = document.createElement("span");
    chip.className = "cm-link cm-atomic-ref";
    // Warning-colored border when validation found the reference unresolvable —
    // the chip's counterpart to the lint squiggle (which a chip replaces). The
    // lint hover still supplies the "context not found" message on the same span.
    if (this.chip.invalid) {
      chip.classList.add("cm-atomic-ref-invalid");
    }
    chip.title = this.chip.title;
    for (const [key, value] of Object.entries(this.chip.attrs)) {
      chip.setAttribute(key, value);
    }
    if (this.chip.icon) {
      const icon = document.createElement("span");
      icon.className = `cm-atomic-ref-icon codicon codicon-${this.chip.icon}`;
      chip.appendChild(icon);
    }
    const label = document.createElement("span");
    label.className = "cm-atomic-ref-label";
    label.textContent = this.chip.label;
    chip.appendChild(label);
    return chip;
  }
}

const ATOMIC_REFERENCE_LINK_EVENTS = new Set([
  "click",
  "touchstart",
  "touchmove",
  "touchcancel",
  "touchend",
]);

// Stable identity for a #sym: reference, independent of its position in the
// document — correlates an async symbol-kind lookup (resolved in
// createContextReferenceLintExtension) back to the matching chip icon in
// createAtomicReferenceExtension without changing the reference's stored
// text/wire format. Exported for unit testing only.
export function symbolIconCacheKey(
  path: string,
  symbolName: string,
  lineStart?: string,
  lineEnd?: string
): string {
  return `${path}::${symbolName}::${lineStart ?? ""}-${lineEnd ?? ""}`;
}

// Dispatched once a #sym: reference's real kind resolves asynchronously (see
// createContextReferenceLintExtension), so createAtomicReferenceExtension
// knows to rebuild chip decorations outside of a doc-change cycle.
const symbolKindsUpdatedEffect = StateEffect.define<void>();

// Dispatched once the async validation pass updates a reference's exists/not-
// found state (see createContextReferenceLintExtension), so the chip plugin
// rebuilds to add/remove the warning border outside a doc-change cycle — the
// validity map counterpart to symbolKindsUpdatedEffect.
const referenceValidityUpdatedEffect = StateEffect.define<void>();

// Atomic mode: replace each reference's text with a compact chip widget and
// mark the range atomic via the atomicRanges facet, so arrow keys skip over the
// whole reference and Backspace/Delete removes it in one press — the caret can
// never land inside. Clicks/taps are DOM events, untouched by atomicRanges, so
// the existing link handlers still open the reference. Built over the whole doc
// (not just visibleRanges) so off-screen references stay atomic for cursor
// motion. Gated on `ui.atomicContextReferences` by the caller.
//
// symbolIconCache is populated asynchronously by createContextReferenceLintExtension
// (keyed by symbolIconCacheKey) as #sym: refs' real kinds resolve; passing the
// same Map instance to both extensions is what lets a chip "upgrade" from
// DEFAULT_COMPLETION_ICON to the correct symbol-* icon without a second
// decoration pipeline.
export function createAtomicReferenceExtension(
  symbolIconCache?: Map<string, string>,
  referenceValidity?: Map<string, boolean>
) {
  const getSymbolIcon: SymbolIconResolver | undefined = symbolIconCache
    ? (path, symbolName, lineStart, lineEnd) =>
        symbolIconCache.get(
          symbolIconCacheKey(path, symbolName, lineStart, lineEnd)
        )
    : undefined;

  const getValidity = referenceValidity
    ? (referenceToken: string) => referenceValidity.get(referenceToken)
    : undefined;

  const buildDecorations = (view: EditorView) => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const chip of findAtomicReferences(
      view.state.doc.toString(),
      getSymbolIcon,
      getValidity
    )) {
      builder.add(
        chip.from,
        chip.to,
        Decoration.replace({ widget: new AtomicReferenceWidget(chip) })
      );
    }
    return builder.finish();
  };

  return ViewPlugin.fromClass(
    class {
      decorations;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: any) {
        const chipStateUpdated = update.transactions.some((tr: any) =>
          tr.effects.some(
            (effect: any) =>
              effect.is(symbolKindsUpdatedEffect) ||
              effect.is(referenceValidityUpdatedEffect)
          )
        );
        if (update.docChanged || chipStateUpdated) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.decorations || Decoration.none
        ),
    }
  );
}

// Prompt-editor-specific decoration styles (link, file-ref, fenced-block, prior-context).
// Generic base theme (colours, gutter, cursor, autocomplete) lives in codemirrorTheme.ts.
function createPromptDecorationThemeExtension() {
  return EditorView.baseTheme({
    ".cm-link": {
      color: "var(--vscode-textLink-foreground)",
      textDecoration: "underline",
      cursor: "pointer",
    },
    ".cm-link:hover": {
      color: "var(--vscode-textLink-activeForeground)",
    },
    ".cm-prompt-file-ref": {
      color: "var(--vscode-textLink-foreground)",
      textDecoration: "underline",
      fontFamily: "var(--vscode-editor-font-family)",
    },
    ".cm-fenced-block": {
      color: "var(--vscode-disabledForeground)",
      fontStyle: "italic",
    },
    ".cm-prior-context-ref": {
      fontStyle: "italic",
    },
    // Atomic-mode reference chip: a compact outlined box showing just the
    // file/folder name (or short git/prior-context label). Placed after
    // `.cm-link` so its non-underlined, boxed styling wins the cascade even
    // though the chip also carries the cm-link class (for click handling).
    ".cm-atomic-ref": {
      display: "inline-flex",
      alignItems: "baseline",
      gap: "3px",
      padding: "0 5px",
      margin: "0 1px",
      border:
        "1px solid var(--vscode-input-border, var(--vscode-panel-border))",
      borderRadius: "4px",
      // editorActionList-background/foreground are the closest VS Code vars to a "chip" look,
      // while still contrasting with colors we pick in the symbol icon color map.
      backgroundColor: "var(--vscode-editorActionList-background)",
      color: "var(--vscode-editorActionList-foreground)",
      fontFamily: "var(--vscode-editor-font-family)",
      fontSize: "0.92em",
      lineHeight: "1.35",
      textDecoration: "none",
      whiteSpace: "nowrap",
      verticalAlign: "baseline",
      cursor: "pointer",
    },
    // Per-kind left+bottom accent lives in codemirrorTheme.ts
    // (buildChipAccentShadowRules), keyed off the same SYMBOL_ICON_COLORS map
    // that colors the chip's icon.
    ".cm-atomic-ref:hover": {
      color: "var(--vscode-editorActionList-foreground)",
      borderColor: "var(--vscode-focusBorder)",
      fontWeight: "bold",
    },
    // Unresolvable reference: warning-colored border matching the lint squiggle
    // (which uses `orange`, see createLinterThemeExtension's cm-lintRange-warning).
    // Kept orange even on hover so the not-found signal isn't lost to the focus
    // border; the lint tooltip on hover explains why. Placed after the base and
    // :hover rules so it wins the cascade.
    ".cm-atomic-ref-invalid": {
      borderColor: "orange",
    },
    ".cm-atomic-ref-invalid:hover": {
      borderColor: "orange",
    },
    // Compound with .codicon (rather than relying on cascade order against the
    // global .codicon rule in globals.css, which sets a flat 16px/line-height:1)
    // so the shrink deterministically wins. Without it, the icon's 16px box
    // became the tallest child of the inline-flex chip, inflating that line's
    // height wherever a chip appeared — the icon must render no taller than
    // the chip's own text to avoid that.
    ".cm-atomic-ref-icon.codicon": {
      fontSize: "0.85em !important",
      lineHeight: "1 !important",
      opacity: "0.85",
    },
    ".cm-atomic-ref-label": {
      // No max-width/ellipsis: the label already dropped the directory
      // portion of the path (see referenceBasename), so the remaining
      // basename/symbol/selection text is short enough to show in full —
      // truncating it further would hide useful info like line numbers.
    },
  });
}

// Linter theme for squiggly underlines
function createLinterThemeExtension() {
  return EditorView.baseTheme({
    ".cm-lintRange": {
      backgroundPosition: "left bottom",
      backgroundRepeat: "repeat-x",
      paddingBottom: "0.7px",
    },
    ".cm-lintRange-error": {
      backgroundImage:
        "url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%226%22 height=%223%22><path d=%22m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0%22 stroke=%22%23d11%22 fill=%22none%22 stroke-width=%22.7%22/></svg>')",
    },
    ".cm-lintRange-warning": {
      backgroundImage:
        "url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%226%22 height=%223%22><path d=%22m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0%22 stroke=%22orange%22 fill=%22none%22 stroke-width=%22.7%22/></svg>')",
    },
    // Lint tooltip container — explicit VS Code vars so it's correct in both
    // dark and light modes regardless of CodeMirror's own dark/light defaults.
    ".cm-tooltip.cm-tooltip-lint": {
      backgroundColor:
        "var(--vscode-editorWidget-background, var(--vscode-editor-background))",
      border:
        "1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border))",
      boxShadow: "0 2px 8px var(--vscode-widget-shadow)",
      color:
        "var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground))",
    },
    ".cm-diagnosticMessage": {
      color:
        "var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground))",
    },
    ".cm-diagnosticAction": {
      display: "block",
      font: "inherit",
      border: "1px solid var(--vscode-button-border, transparent)",
      padding: "4px 8px",
      margin: "2px 0",
      backgroundColor: "var(--vscode-button-background)",
      color: "var(--vscode-button-foreground)",
      borderRadius: "2px",
      cursor: "pointer",
      textAlign: "left",
      width: "100%",
    },
    ".cm-diagnosticAction:hover": {
      backgroundColor: "var(--vscode-button-hoverBackground)",
    },
  });
}

// Same behavior as @codemirror/view's highlightActiveLine(), except a range
// is skipped once it spans more than one line — matching VS Code, which
// suppresses the current-line highlight for multi-line selections because it
// otherwise cuts a visible gap into the selection highlight on the first and
// last selected lines.
const activeLineDeco = Decoration.line({ class: "cm-activeLine" });
function createActiveLineHighlightExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: ReturnType<typeof Decoration.set>;
      constructor(view: EditorView) {
        this.decorations = this.getDeco(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = this.getDeco(update.view);
        }
      }
      getDeco(view: EditorView) {
        let lastLineStart = -1;
        const deco = [];
        for (const r of view.state.selection.ranges) {
          const headLine = view.lineBlockAt(r.head);
          if (!r.empty && view.lineBlockAt(r.anchor).from !== headLine.from) {
            continue;
          }
          if (headLine.from > lastLineStart) {
            deco.push(activeLineDeco.range(headLine.from));
            lastLineStart = headLine.from;
          }
        }
        return Decoration.set(deco);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// Spell checking with Typo.js
function createSpellCheckExtension(
  typoCheckerRef: React.RefObject<TypoChecker | null>,
  allowWorkspaceFolderPrefix: boolean
) {
  return linter(
    (view) => {
      if (!typoCheckerRef.current) return [];

      // Skip spellcheck entirely when the document is a lone file-path reference
      if (
        looksLikeFilePath(view.state.doc.toString().trim(), {
          allowWorkspaceFolderPrefix,
        })
      ) {
        return [];
      }

      const diagnostics: any[] = [];

      // Only check visible ranges for performance
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);

        // Get ranges to exclude from spell checking (@ and # references)
        const excludedRanges = getCompletionRanges(text);

        // Match words and contractions. Hyphens and underscores act as
        // separators — the regex stops at them, so "step-by-step" is matched
        // as three separate tokens. CamelCase words are further split by
        // splitCamelCaseWord().
        const wordRegex = /[a-zA-Z]+(?:'[a-zA-Z]+)*/g;
        let match;

        while ((match = wordRegex.exec(text)) !== null) {
          const word = match[0];

          // Skip if word is within a completion range
          if (
            isInExcludedRange(
              match.index,
              match.index + word.length,
              excludedRanges
            )
          ) {
            continue;
          }

          // Skip all-caps words (likely acronyms)
          if (word === word.toUpperCase() && word.length > 1) {
            continue;
          }

          // Split camelCase / PascalCase words into component parts and check
          // each individually with its correct document position.
          const parts = splitCamelCaseWord(word);
          for (const part of parts) {
            if (part.text.length <= 1) continue;
            // Skip all-caps parts (e.g. "XML" within "XMLParser")
            if (part.text === part.text.toUpperCase()) continue;

            if (!typoCheckerRef.current.check(part.text)) {
              const checker = typoCheckerRef.current;
              const partFrom = from + match.index + part.offset;
              const partTo = partFrom + part.text.length;
              const diagnostic = {
                from: partFrom,
                to: partTo,
                severity: "error" as const,
                message: `Spelling: "${part.text}"`,
                get actions() {
                  if (!(this as any)._cachedActions) {
                    const suggestions = checker.suggest((this as any)._word);
                    (this as any)._cachedActions = suggestions
                      .slice(0, 5)
                      .map((suggestion: string) => ({
                        name: `Change to "${suggestion}"`,
                        apply: (view: EditorView, from: number, to: number) => {
                          view.dispatch({
                            changes: { from, to, insert: suggestion },
                          });
                        },
                      }));
                  }
                  return (this as any)._cachedActions;
                },
                _word: part.text,
                _cachedActions: null,
              };
              diagnostics.push(diagnostic);
            }
          }
        }
      }

      return diagnostics;
    },
    {
      delay: 200,
      needsRefresh: (update) => update.docChanged || update.viewportChanged,
    }
  );
}

function createContextReferenceLintExtension(
  validateReferences: (
    references: Array<ContextReferenceMatch & { id: string }>
  ) => Promise<ContextReferenceValidationResult[]>,
  symbolIconCache?: Map<string, string>,
  referenceValidity?: Map<string, boolean>
) {
  return linter(
    async (view): Promise<Diagnostic[]> => {
      const allReferences: Array<ContextReferenceMatch & { id: string }> = [];
      const fencedReferenceIds = new Set<string>();
      const fencedRanges = getFencedBlockRanges(view.state.doc.toString());

      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        const matches = findContextReferenceMatches(text, from);
        matches.forEach((match, index) => {
          const id = `${match.from}:${match.to}:${match.type}:${index}`;
          allReferences.push({ ...match, id });
          if (isInFencedBlock(match.from, match.to, fencedRanges)) {
            fencedReferenceIds.add(id);
          }
        });
      }

      if (allReferences.length === 0) {
        return [];
      }

      const results = await validateReferences(allReferences);
      const resultById = new Map(results.map((result) => [result.id, result]));

      // Piggyback the resolved symbol kinds (present only for "symbol" refs,
      // see handleContextRefsValidation) onto the atomic-chip icon cache —
      // this lint pass already validates every visible reference on a
      // debounce, so it's the natural place to keep that cache warm rather
      // than running a second round trip just for icons.
      if (symbolIconCache) {
        let changed = false;
        for (const reference of allReferences) {
          if (
            reference.type !== "symbol" ||
            !reference.path ||
            !reference.symbolName
          ) {
            continue;
          }
          const symbolKind = resultById.get(reference.id)?.symbolKind;
          if (symbolKind === undefined) continue;
          const icon =
            COMPLETION_KIND_ICONS[symbolKind] || DEFAULT_COMPLETION_ICON;
          const key = symbolIconCacheKey(
            reference.path,
            reference.symbolName,
            reference.lineStart,
            reference.lineEnd
          );
          if (symbolIconCache.get(key) !== icon) {
            symbolIconCache.set(key, icon);
            changed = true;
          }
        }
        if (changed) {
          view.dispatch({ effects: symbolKindsUpdatedEffect.of(undefined) });
        }
      }

      // Feed the atomic-chip validity map so an unresolvable reference's chip
      // shows the warning border (the chip's stand-in for the lint squiggle it
      // replaces). Keyed by the exact reference token, matching what
      // findAtomicReferences looks up. Fenced references are skipped — they get
      // no chip — and their "expansion suppressed" warning is a separate signal
      // that does not mean the reference itself is invalid.
      if (referenceValidity) {
        let validityChanged = false;
        for (const reference of allReferences) {
          if (fencedReferenceIds.has(reference.id)) continue;
          const result = resultById.get(reference.id);
          if (!result) continue;
          const token = view.state.doc.sliceString(
            reference.from,
            reference.to
          );
          if (referenceValidity.get(token) !== result.exists) {
            referenceValidity.set(token, result.exists);
            validityChanged = true;
          }
        }
        if (validityChanged) {
          view.dispatch({
            effects: referenceValidityUpdatedEffect.of(undefined),
          });
        }
      }

      return allReferences.flatMap((reference): Diagnostic[] => {
        const result = resultById.get(reference.id);
        const inFenced = fencedReferenceIds.has(reference.id);

        if (inFenced) {
          // Warn only when the reference points to something that actually exists —
          // the user may not realize expansion is silently suppressed.
          if (result?.exists) {
            return [
              {
                from: reference.from,
                to: reference.to,
                severity: "warning",
                message:
                  "Context expansion suppressed — this reference won't be expanded inside a backtick block",
              },
            ];
          }
          return [];
        }

        if (!result || result.exists) {
          return [];
        }

        return [
          {
            from: reference.from,
            to: reference.to,
            severity: "warning",
            message: result.message || "context not found",
            // One-click "did you mean?" fixes for a mistyped/collapsed path (see
            // getPathSuggestions). apply() uses the diagnostic's live from/to so
            // the swap lands correctly even if the doc changed since linting.
            actions: result.suggestions?.map((suggestion) => ({
              name: `Change to ${suggestion}`,
              apply: (view: EditorView, from: number, to: number) => {
                view.dispatch({ changes: { from, to, insert: suggestion } });
              },
            })),
          },
        ];
      });
    },
    {
      delay: 400,
      needsRefresh: (update) => update.docChanged || update.viewportChanged,
    }
  );
}

// Get ranges of @ and # completions to exclude from spell checking
function getCompletionRanges(
  text: string
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];

  // Match both plain paths (@src/file.ts) and quoted paths (@"path with spaces/file.ts"),
  // as well as ~ git change references (~diff, ~staged, ~stash:N, ~<hash>).
  const patterns = [
    /@"[^"]*"|@[^\s@#~]+/g,
    /#"[^"]*"|#[^\s@#~]+/g,
    /~(?:diff|staged|stash:\d+|[0-9a-f]{7,40})/gi,
  ];

  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      ranges.push({
        from: match.index,
        to: match.index + match[0].length,
      });
    }
  }

  return ranges;
}

// Check if a range overlaps with any excluded range
function isInExcludedRange(
  from: number,
  to: number,
  excludedRanges: Array<{ from: number; to: number }>
): boolean {
  for (const range of excludedRanges) {
    if (from < range.to && to > range.from) {
      return true;
    }
  }
  return false;
}

// Split a camelCase or PascalCase word into component parts with their offsets.
// Returns the original word as a single entry when no camelCase splitting applies
// (i.e. the word has no uppercase letter after position 0).
//
// Examples:
//   "camelCase"   → [{ text: "camel", offset: 0 }, { text: "Case", offset: 5 }]
//   "XMLParser"   → [{ text: "XML",   offset: 0 }, { text: "Parser", offset: 3 }]
//   "hello"       → [{ text: "hello", offset: 0 }]
//   "don't"       → [{ text: "don't", offset: 0 }]
function splitCamelCaseWord(
  word: string
): Array<{ text: string; offset: number }> {
  // Only split if there's an uppercase letter after position 0
  if (!/[A-Z]/.test(word.slice(1))) {
    return [{ text: word, offset: 0 }];
  }

  const parts: Array<{ text: string; offset: number }> = [];
  // Three alternations (tried in order):
  //   1. Uppercase run before an UpperLower transition ("XML" in "XMLParser")
  //   2. Uppercase letter followed by zero-or-more lowercase ("Parser", "Case")
  //   3. Pure lowercase run ("camel", "my")
  const camelRegex = /[A-Z]+(?=[A-Z][a-z])|[A-Z][a-z]*|[a-z]+/g;
  let m;
  while ((m = camelRegex.exec(word)) !== null) {
    if (m[0].length > 1) {
      parts.push({ text: m[0], offset: m.index });
    }
  }
  return parts.length > 0 ? parts : [{ text: word, offset: 0 }];
}

export function findContextReferenceMatches(
  text: string,
  offset = 0
): ContextReferenceMatch[] {
  const patterns = {
    fullFileQuoted: /@"([^"]+\.[a-zA-Z0-9]+)"(?!\/)/g,
    directoryQuoted: /@"([^"]+\/)"(?![\w])/g,
    // Include alphanumerics in the boundary check so the engine cannot
    // backtrack to a partial extension when the complete path ends in `/`.
    // Without this, `@.ctrlyoke/.history/` also matched a truncated file
    // reference such as `@.ctrlyoke/.histor`.
    fullFile: /@([^\s@#"]+\.[a-zA-Z0-9]+)(?![a-zA-Z0-9/])/g,
    directory: /@([^\s@#"]+\/)/g,
    lineRangeQuoted: /#selection:"([^"]+)":(\d+)-(\d+)/g,
    lineRange: /#selection:([^\s:]+):(\d+)-(\d+)/g,
    symbolQuoted: /#sym:"([^"]+)":([^:]+):(\d+)-(\d+)/g,
    symbol: /#sym:([^\s:]+):([^:]+):(\d+)-(\d+)/g,
  };

  const fileMatches: ContextReferenceMatch[] = [];
  const directoryMatches: ContextReferenceMatch[] = [];
  const lineRangeMatches: ContextReferenceMatch[] = [];
  const symbolMatches: ContextReferenceMatch[] = [];
  const gitMatches: ContextReferenceMatch[] = [];

  let match: RegExpExecArray | null;

  const collectPathMatches = (
    pattern: RegExp,
    type: "file" | "directory",
    target: ContextReferenceMatch[]
  ) => {
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      target.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type,
        path: match[1],
      });
    }
  };

  collectPathMatches(patterns.fullFileQuoted, "file", fileMatches);
  collectPathMatches(patterns.fullFile, "file", fileMatches);
  collectPathMatches(patterns.directoryQuoted, "directory", directoryMatches);
  collectPathMatches(patterns.directory, "directory", directoryMatches);

  const collectLineRangeMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      lineRangeMatches.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type: "lineRange",
        path: match[1],
        lineStart: match[2],
        lineEnd: match[3],
      });
    }
  };

  collectLineRangeMatches(patterns.lineRangeQuoted);
  collectLineRangeMatches(patterns.lineRange);

  const collectSymbolMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      symbolMatches.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type: "symbol",
        path: match[1],
        symbolName: match[2],
        lineStart: match[3],
        lineEnd: match[4],
      });
    }
  };

  collectSymbolMatches(patterns.symbolQuoted);
  collectSymbolMatches(patterns.symbol);

  const filteredDirectoryMatches = directoryMatches.filter((dirMatch) => {
    return !fileMatches.some(
      (fileMatch) =>
        dirMatch.from >= fileMatch.from && dirMatch.to <= fileMatch.to
    );
  });

  const collectGitMatches = (
    pattern: RegExp,
    normalize: (match: RegExpExecArray) => string
  ) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(text)) !== null) {
      const matchFrom = offset + match.index;
      if (!gitMatches.some((existing) => existing.from === matchFrom)) {
        gitMatches.push({
          from: matchFrom,
          to: offset + match.index + match[0].length,
          type: "git",
          gitRef: normalize(match),
        });
      }
    }
  };

  collectGitMatches(/~(diff|staged)/g, (m) => m[1]);
  collectGitMatches(/~(stash:\d+)/g, (m) => m[1]);
  collectGitMatches(/~([0-9a-f]{7,40})/gi, (m) => m[1].toLowerCase());

  return [
    ...fileMatches,
    ...filteredDirectoryMatches,
    ...lineRangeMatches,
    ...symbolMatches,
    ...gitMatches,
  ].sort((a, b) => a.from - b.from);
}

export function getFencedBlockRanges(
  text: string
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const regex = /```[\s\S]*?```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

export function isInFencedBlock(
  from: number,
  to: number,
  fencedRanges: Array<{ from: number; to: number }>
): boolean {
  return fencedRanges.some((r) => from >= r.from && to <= r.to);
}

// Apply disabled/italic styling to triple-backtick fenced blocks
function createFencedBlockDecorationExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: any) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const fencedRanges = getFencedBlockRanges(view.state.doc.toString());

        for (const { from, to } of view.visibleRanges) {
          for (const range of fencedRanges) {
            if (range.to <= from) continue;
            if (range.from >= to) break;
            const visFrom = Math.max(range.from, from);
            const visTo = Math.min(range.to, to);
            if (visFrom < visTo) {
              builder.add(
                visFrom,
                visTo,
                Decoration.mark({ class: "cm-fenced-block" })
              );
            }
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

// Decorate links (@file, @dir/, #file:, #sym:)
function createLinkDecorationExtension() {
  const linkPlugin = ViewPlugin.fromClass(
    class {
      decorations;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: any) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const fencedRanges = getFencedBlockRanges(view.state.doc.toString());

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          const matches = findContextReferenceMatches(text, from);

          for (const linkMatch of matches) {
            if (isInFencedBlock(linkMatch.from, linkMatch.to, fencedRanges))
              continue;

            const attrs: Record<string, string> = {
              "data-type": linkMatch.type,
            };

            if (linkMatch.path) {
              attrs["data-path"] = linkMatch.path;
            }
            if (linkMatch.gitRef) {
              attrs["data-git-ref"] = linkMatch.gitRef;
            }
            if (linkMatch.lineStart) {
              attrs["data-line-start"] = linkMatch.lineStart;
            }
            if (linkMatch.lineEnd) {
              attrs["data-line-end"] = linkMatch.lineEnd;
            }
            if (linkMatch.symbolName) {
              attrs["data-symbol-name"] = linkMatch.symbolName;
            }

            builder.add(
              linkMatch.from,
              linkMatch.to,
              Decoration.mark({
                class: "cm-link",
                attributes: attrs,
              })
            );
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );

  return linkPlugin;
}

// Decorate the entire editor content when it is a lone file-path reference
function createFileRefDecorationExtension(allowWorkspaceFolderPrefix: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: any) {
        if (update.docChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const doc = view.state.doc.toString();
        const trimmed = doc.trim();
        if (
          !trimmed ||
          !looksLikeFilePath(trimmed, { allowWorkspaceFolderPrefix })
        ) {
          return Decoration.none;
        }

        // Mark only the trimmed content (skip leading/trailing whitespace).
        // Reuse cm-link + data-* attributes so the existing click handler and
        // styles work exactly the same as for @file / #file references.
        const start = doc.indexOf(trimmed);
        const end = start + trimmed.length;
        const builder = new RangeSetBuilder<Decoration>();
        builder.add(
          start,
          end,
          Decoration.mark({
            class: "cm-link cm-prompt-file-ref",
            attributes: { "data-type": "file", "data-path": trimmed },
          })
        );
        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

// ============================================================================
// Inline prior-context reference helpers ($previous, $all, $step:N, etc.)
// ============================================================================

interface InlinePriorContextRef {
  from: number;
  to: number;
  token: string;
  kind: "previous" | "all" | "finalStep" | "allFinalStep" | "step";
  indices?: number[]; // 1-based step numbers for kind==="step"
}

/** Parse range notation like "1,3-5,2" into a flat 1-based array. Returns null on invalid input. */
function parsePriorContextStepRange(rangeText: string): number[] | null {
  if (!rangeText) return null;
  const indices: number[] = [];
  for (const part of rangeText.split(",")) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end) return null;
      for (let i = start; i <= end; i++) indices.push(i);
    } else if (/^\d+$/.test(part)) {
      indices.push(parseInt(part, 10));
    } else {
      return null;
    }
  }
  return indices.length > 0 ? indices : null;
}

/** Find all inline $prior-context refs in text, returning their absolute positions. */
function findInlinePriorContextRefs(
  text: string,
  offset = 0
): InlinePriorContextRef[] {
  const results: InlinePriorContextRef[] = [];
  const regex = /\$([A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9,\-]*)?)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const body = match[1];
    const token = match[0];
    const from = offset + match.index;
    const to = from + token.length;
    if (body === "previous") {
      results.push({ from, to, token, kind: "previous" });
    } else if (body === "all") {
      results.push({ from, to, token, kind: "all" });
    } else if (body === "finalStep") {
      results.push({ from, to, token, kind: "finalStep" });
    } else if (body === "allFinalStep") {
      results.push({ from, to, token, kind: "allFinalStep" });
    } else if (body.startsWith("step:")) {
      const indices = parsePriorContextStepRange(body.slice("step:".length));
      if (indices !== null) {
        results.push({ from, to, token, kind: "step", indices });
      }
    }
  }
  return results;
}

/** Apply cm-link decoration to inline $prior-context references. */
function createPriorContextDecorationExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: any) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const fencedRanges = getFencedBlockRanges(view.state.doc.toString());
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          const refs = findInlinePriorContextRefs(text, from);
          for (const ref of refs) {
            if (isInFencedBlock(ref.from, ref.to, fencedRanges)) continue;
            const dataRef =
              ref.kind === "step" ? `step:${ref.indices!.join(",")}` : ref.kind;
            builder.add(
              ref.from,
              ref.to,
              Decoration.mark({
                class: "cm-link cm-prior-context-ref",
                attributes: {
                  "data-type": "priorContext",
                  "data-ref": dataRef,
                },
              })
            );
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

/** Warn when $prior-context refs point to steps that don't exist. */
function createPriorContextLintExtension(
  stepCountRef: React.RefObject<number>,
  hasFinalStepRef: React.RefObject<boolean>
) {
  return linter(
    (view): Diagnostic[] => {
      const stepCount = stepCountRef.current ?? 0;
      const hasFinalStep = hasFinalStepRef.current ?? false;
      const diagnostics: Diagnostic[] = [];
      const fencedRanges = getFencedBlockRanges(view.state.doc.toString());

      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        const refs = findInlinePriorContextRefs(text, from);

        for (const ref of refs) {
          if (isInFencedBlock(ref.from, ref.to, fencedRanges)) continue;

          if (ref.kind === "previous" || ref.kind === "all") {
            if (stepCount <= 0) {
              diagnostics.push({
                from: ref.from,
                to: ref.to,
                severity: "warning",
                message: `Prior context not found — no prior steps exist at this position`,
              });
            }
          } else if (ref.kind === "finalStep" || ref.kind === "allFinalStep") {
            if (!hasFinalStep) {
              diagnostics.push({
                from: ref.from,
                to: ref.to,
                severity: "warning",
                message: `Prior context not found — no final step is configured`,
              });
            }
          } else if (ref.kind === "step" && ref.indices) {
            const outOfRange = ref.indices.filter(
              (i) => i < 1 || i > stepCount
            );
            if (outOfRange.length > 0) {
              const label =
                outOfRange.length === 1
                  ? `step ${outOfRange[0]} does not exist`
                  : `steps ${outOfRange.join(", ")} do not exist`;
              diagnostics.push({
                from: ref.from,
                to: ref.to,
                severity: "warning",
                message: `Prior context not found — ${label}`,
              });
            }
          }
        }
      }

      return diagnostics;
    },
    {
      delay: 300,
      needsRefresh: (update) => update.docChanged || update.viewportChanged,
    }
  );
}

function getLinkElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest(".cm-link") : null;
}

function openContextReferenceLink(
  target: HTMLElement,
  vscode: any,
  stepCountRef: React.RefObject<number>
): boolean {
  // Adapt the decoration's data-* attributes to the shared reference-open
  // logic (single-sourced with the output prompt row's inline links).
  return openContextReference(
    {
      type: target.getAttribute("data-type"),
      path: target.getAttribute("data-path"),
      gitRef: target.getAttribute("data-git-ref"),
      lineStart: target.getAttribute("data-line-start"),
      lineEnd: target.getAttribute("data-line-end"),
      ref: target.getAttribute("data-ref"),
    },
    vscode,
    stepCountRef.current
  );
}

// Handle clicks/taps on links. Atomic chips and git/priorContext links respond
// to plain clicks; non-atomic file/directory/lineRange/symbol text links require
// Ctrl/Cmd+Click on pointer devices. Short touch taps open directly because
// mobile has no modifier-key equivalent. Long press remains available for
// native editor positioning/selection behavior.
export function createClickHandlerExtension(
  vscode: any,
  stepCountRef: React.RefObject<number>
) {
  let touchStart: {
    x: number;
    y: number;
    time: number;
    target: HTMLElement;
  } | null = null;

  const cancelTouch = () => {
    touchStart = null;
  };

  return EditorView.domEventHandlers({
    touchstart: (event) => {
      if (event.touches.length !== 1) {
        cancelTouch();
        return false;
      }

      const target = getLinkElement(event.target);
      if (!target) {
        cancelTouch();
        return false;
      }

      const touch = event.touches[0];
      touchStart = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        target,
      };
      return false;
    },
    touchmove: (event) => {
      if (!touchStart || event.touches.length === 0) return false;

      const touch = event.touches[0];
      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;
      if (Math.sqrt(dx * dx + dy * dy) > LINK_TOUCH_MOVE_THRESHOLD_PX) {
        cancelTouch();
      }

      return false;
    },
    touchcancel: () => {
      cancelTouch();
      return false;
    },
    touchend: (event) => {
      if (!touchStart) return false;

      const start = touchStart;
      cancelTouch();

      if (Date.now() - start.time >= LINK_TOUCH_LONG_PRESS_MS) {
        return false;
      }

      const endTarget = getLinkElement(event.target);
      if (endTarget !== start.target) {
        return false;
      }

      if (!openContextReferenceLink(start.target, vscode, stepCountRef)) {
        return false;
      }

      event.preventDefault();
      return true;
    },
    click: (event, view) => {
      const target = getLinkElement(event.target);
      if (!target) return false;

      // Atomic chips are button-like and open on a plain click. Text links keep
      // the conventional editor behavior: file/directory/lineRange/symbol
      // require Ctrl/Cmd+Click, while previews open on a plain click.
      const type = target.getAttribute("data-type");
      if (
        !target.classList.contains("cm-atomic-ref") &&
        type !== "git" &&
        type !== "priorContext" &&
        !(event.ctrlKey || event.metaKey)
      ) {
        return false;
      }

      // No posAtCoords check here: the target element (found via `.closest`)
      // is all we need. Requiring a resolvable doc position broke clicks on
      // atomic-mode chips — posAtCoords over a replaced widget's DOM can
      // return null even though the click plainly landed on a real link.
      if (!openContextReferenceLink(target, vscode, stepCountRef)) {
        return false;
      }

      event.preventDefault();
      // A native click inside a contenteditable replacement widget can leave
      // the DOM selection outside CodeMirror's editable text. Reassert the
      // state selection after disarming any stale pointer selection so typing
      // continues immediately after the reference opens.
      destroyOrphanedMouseSelection(view);
      view.focus();
      return true;
    },
  });
}
