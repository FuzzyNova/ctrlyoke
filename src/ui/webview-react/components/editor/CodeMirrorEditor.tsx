import React, {
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useState,
} from "react";
import {
  EditorView,
  placeholder,
  keymap,
  ViewPlugin,
  ViewUpdate,
  type PluginValue,
  Decoration,
  WidgetType,
  repositionTooltips,
} from "@codemirror/view";
import { createThemeExtension } from "@utils/codemirrorTheme";
import { createPromptMarkdownExtension } from "@utils/codemirrorLanguage";
import {
  DEFAULT_COMPLETION_ICON,
  findAtomicReferences,
  findConditionOutputRefs,
  findContextReferenceMatches,
  findInlinePriorContextRefs,
  findCodeRanges,
  isInCodeRange,
  type AtomicReferenceChip,
  type ContextReferenceMatch,
  type SymbolIconResolver,
} from "@utils/atomicReferences";
import { Compartment, EditorState } from "@codemirror/state";
import { minimalSetup } from "codemirror";
import { completionKeymap } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
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
import { Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { getVsCodeApi } from "../../hooks/useVsCodeApi";
import {
  asAtomicReferenceKind,
  openContextReference,
} from "@utils/contextReferenceActions";
import {
  ATOMIC_REFERENCE_KINDS,
  BOOLEAN_STRING_VALUES,
  CODE_MIRROR_EDITOR_MODES,
  PROMPT_DIAGNOSTIC_FIELDS,
  USER_FEEDBACK_SEVERITY,
  CTRLYOKE_SLASH_TOKEN_KINDS,
  OUTPUT_SNAPSHOT_SAVE_TIMEOUT_MS,
  type CodeMirrorEditorMode,
} from "@root/types/DashboardConstants";
import { COMPLETION_KIND_ICONS } from "@root/types/SymbolKindConstants";
import {
  MESSAGE_TYPES,
  EDITOR_PLACEHOLDER_TEXT,
  PROMPT_EDITOR_INSERT_MODES,
  MAX_PASTED_IMAGE_BYTES,
  PASTING_IMAGE_PLACEHOLDER,
  PASTED_IMAGE_SAVE_TIMEOUT_MS,
  mimeTypeToImageExtension,
  type PromptEditorInsertRequest,
} from "../../types/messages";
import { WebviewLog } from "../../utils/logger";
import { useSettingsStore } from "../../store/settingsStore";
import { looksLikeFilePath } from "@root/utils/promptPathUtils";
import {
  checkPriorContextRefs,
  diagnoseResolvedReferences,
  getConditionOutputDiagnostics,
  resolvePromptReferences,
  type ContextReferenceResolver,
  type ContextReferenceValidationResult,
  type PromptDiagnostic,
} from "@root/utils/PromptDiagnosticRules";
import { formatInlinePriorContextBody } from "@root/utils/FileReferenceParser";
import { scanCtrlYokeSlashTokens } from "@root/utils/CtrlYokeSlashTokens";
import { createGitChangeReferencePattern } from "@root/utils/ReferencePatterns";
import { REFERENCE_BOUNDARY_CHAR_RE } from "@root/utils/ReferenceBoundary";
import { notifyUser } from "@utils/notifyUser";
import { createPromptCompletionClient } from "@utils/promptCompletion/createPromptCompletionClient";
import { promptTokenCompletionExtension } from "@utils/promptCompletion/promptTokenCompletionExtension";
import {
  buildCodeMirrorCompletionResult,
  findCustomCompletionContext,
  findSlashCompletionContext,
  symbolIconCacheKey,
} from "@utils/promptCompletion/promptCompletionResult";
import {
  EDITOR_OVERFLOW_CAUSES,
  EDITOR_OVERFLOW_EVENT,
  EDITOR_REMEASURE_EVENT,
  type EditorOverflowDetail,
} from "@utils/editorAutoExpand";

export { keyboardTooltipSpace } from "@utils/keyboardTooltipSpace";
export {
  buildCodeMirrorCompletionResult,
  findCustomCompletionContext,
  findSlashCompletionContext,
};

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

export type { CodeMirrorEditorMode } from "@root/types/DashboardConstants";
type CodeMirrorEditorSurface = "editor" | "input";

interface CodeMirrorEditorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  affUri: string;
  dicUri: string;
  /** When true, the editor is read-only (no edits allowed). */
  readOnly?: boolean;
  /** Editor mode controls which condition-output references are valid. */
  mode?: CodeMirrorEditorMode;
  /** Visual surface used by the editor theme. */
  surface?: CodeMirrorEditorSurface;
  className?: string;
  minHeightClassName?: string;
  maxHeightClassName?: string;
  /** Called when Ctrl+Enter is pressed. */
  onRun?: () => void;
  /** Called when Ctrl+Shift+Enter is pressed. */
  onQueue?: () => void;
  /** Number of steps that precede the currently-edited prompt (for $prior-context validation). */
  stepCount?: number;
  /** Whether a final step is configured (for $finalStep/$allFinalStep validation). */
  hasFinalStep?: boolean;
  /** Whether this step has an effective pre-condition configured. */
  hasPreCondition?: boolean;
  /** Pending external insert request from VS Code context menus. */
  pendingInsertRequest?: PromptEditorInsertRequest | null;
  /** Called after a pending external insert has been applied. */
  onInsertApplied?: (requestId: string) => void;
}

export type { ContextReferenceValidationResult };

interface PendingPlaceholder {
  from: number;
  to: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

const LINK_TOUCH_MOVE_THRESHOLD_PX = 10;
const LINK_TOUCH_LONG_PRESS_MS = 500;

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

  let text = shouldSurroundWithNewlines
    ? `\n${referencesText}\n`
    : referencesText;

  // Without surrounding newlines, the reference lands directly against
  // whatever precedes the cursor/selection. If that character is legal
  // inside a filename (e.g. the trailing char of a word), the trigger
  // char's word-boundary lookbehind (see REFERENCE_BOUNDARY_CHAR_RE) would
  // reject it as mid-word and the reference would silently fail to parse —
  // insert a leading space to keep it a real trigger.
  if (!shouldSurroundWithNewlines && selection.from > 0) {
    const charBefore = docText[selection.from - 1];
    if (REFERENCE_BOUNDARY_CHAR_RE.test(charBefore)) {
      text = ` ${text}`;
    }
  }

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
    mode = CODE_MIRROR_EDITOR_MODES.PROMPT,
    surface = "editor",
    className,
    minHeightClassName,
    maxHeightClassName,
    onRun,
    onQueue,
    onBlur,
    pendingInsertRequest,
    onInsertApplied,
  } = props;
  const stepCountRef = useRef(props.stepCount ?? 0);
  const hasFinalStepRef = useRef(props.hasFinalStep ?? false);
  const hasPreConditionRef = useRef(props.hasPreCondition ?? false);
  const modeRef = useRef<CodeMirrorEditorMode>(mode);
  const placeholderText = props.placeholder || EDITOR_PLACEHOLDER_TEXT.DEFAULT;
  const placeholderCompartmentRef = useRef(new Compartment());

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
  const onBlurRef = useRef(onBlur);
  const readOnlyRef = useRef(readOnly);
  // Tracks last reported signed-overflow to avoid redundant events
  const lastOverflowRef = useRef<number | null>(null);
  const validationSeqRef = useRef(0);
  const pendingValidationRequestsRef = useRef<
    Map<number, (value: ContextReferenceValidationResult[]) => void>
  >(new Map());
  // Pasted-image placeholders awaiting a SAVE_PASTED_IMAGE round trip. Keyed by
  // seq; the {from,to} range is kept live through edits via mapPos in the
  // updateListener so the placeholder is replaced in the right spot even if the
  // user keeps typing before the save completes.
  const pasteSeqRef = useRef(0);
  const pendingPastesRef = useRef<Map<number, PendingPlaceholder>>(new Map());
  // Output-capture placeholders use their own sequence space because their
  // replies carry a different message type, but share the same range shape
  // and resolver as pasted-image placeholders.
  const captureSeqRef = useRef(0);
  const pendingCapturesRef = useRef<Map<number, PendingPlaceholder>>(new Map());
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

  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);

  // Update read-only state when prop changes (set contentEditable on the CodeMirror content DOM)
  useEffect(() => {
    readOnlyRef.current = readOnly;
    if (viewRef.current) {
      viewRef.current.contentDOM.contentEditable = readOnly
        ? BOOLEAN_STRING_VALUES.FALSE
        : BOOLEAN_STRING_VALUES.TRUE;
    }
  }, [readOnly]);

  // Sync stepCount ref and re-run prior-context linter when step context changes
  useEffect(() => {
    stepCountRef.current = props.stepCount ?? 0;
    if (viewRef.current) {
      relintForContextChange(viewRef.current);
    }
  }, [props.stepCount]);

  useEffect(() => {
    hasFinalStepRef.current = props.hasFinalStep ?? false;
    if (viewRef.current) {
      relintForContextChange(viewRef.current);
    }
  }, [props.hasFinalStep]);

  useEffect(() => {
    hasPreConditionRef.current = props.hasPreCondition ?? false;
    if (viewRef.current) {
      relintForContextChange(viewRef.current);
    }
  }, [props.hasPreCondition]);

  useEffect(() => {
    modeRef.current = mode;
    if (viewRef.current) {
      relintForContextChange(viewRef.current);
    }
  }, [mode]);

  useEffect(() => {
    if (
      !pendingInsertRequest ||
      !viewRef.current ||
      mode !== CODE_MIRROR_EDITOR_MODES.PROMPT
    ) {
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
    // requestMeasure alone does NOT re-run the tooltip plugin's own measure
    // request, so an already-open dropdown would keep the placement it computed
    // against the pre-keyboard viewport. repositionTooltips re-evaluates
    // keyboardTooltipSpace, which is what flips it above the caret.
    const handleScroll = () => {
      const view = viewRef.current;
      if (!view) return;
      view.requestMeasure();
      repositionTooltips(view);
    };
    const handleResize = () => {
      const view = viewRef.current;
      if (!view) return;
      view.requestMeasure();
      repositionTooltips(view);
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
    window.addEventListener(EDITOR_REMEASURE_EVENT, handleRemeasure);
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      window.removeEventListener(EDITOR_REMEASURE_EVENT, handleRemeasure);
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
  // longer re-arms the snap. `blur-sm` covers focus leaving the panel. Both are
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
      window.removeEventListener("blur-sm", teardown);
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

  // Replace a pending placeholder with final text — a `@ref ` on success or
  // an empty string on failure/timeout — then forget the entry. Ranges are
  // clamped to the current doc length to survive races with concurrent edits.
  const resolvePendingPlaceholder = useCallback(
    (
      pending: Map<number, PendingPlaceholder>,
      seq: number,
      replacement: string
    ) => {
      const entry = pending.get(seq);
      if (!entry) return;
      clearTimeout(entry.timeoutId);
      pending.delete(seq);
      const view = viewRef.current;
      if (!view) return;
      const docLen = view.state.doc.length;
      const from = Math.min(entry.from, docLen);
      const to = Math.min(Math.max(entry.to, from), docLen);
      view.dispatch({ changes: { from, to, insert: replacement } });
    },
    []
  );

  const resolvePendingPaste = useCallback(
    (seq: number, replacement: string) => {
      resolvePendingPlaceholder(pendingPastesRef.current, seq, replacement);
    },
    [resolvePendingPlaceholder]
  );

  const resolvePendingCapture = useCallback(
    (seq: number, replacement: string) => {
      resolvePendingPlaceholder(pendingCapturesRef.current, seq, replacement);
    },
    [resolvePendingPlaceholder]
  );

  const handleOutputSnapshotSaved = useCallback(
    (seq: number, relativePath?: string, error?: string) => {
      if (error || !relativePath) {
        resolvePendingCapture(seq, "");
        const messageText = error || "Failed to save output snapshot";
        WebviewLog.error(
          `[CodeMirror] Output snapshot save failed: ${messageText}`
        );
        notifyUser(messageText, USER_FEEDBACK_SEVERITY.ERROR);
        return;
      }
      // Trailing space terminates the @ref token so the user can keep typing.
      resolvePendingCapture(seq, `@${relativePath} `);
    },
    [resolvePendingCapture]
  );

  const handleOutputCapturePicked = useCallback(
    (captureId: string, from: number, to: number) => {
      const seq = ++captureSeqRef.current;
      const timeoutId = setTimeout(() => {
        handleOutputSnapshotSaved(
          seq,
          undefined,
          "Timed out saving output snapshot"
        );
      }, OUTPUT_SNAPSHOT_SAVE_TIMEOUT_MS);
      pendingCapturesRef.current.set(seq, { from, to, timeoutId });
      vscode.postMessage({
        type: MESSAGE_TYPES.SAVE_OUTPUT_SNAPSHOT,
        seq,
        captureId,
      });
    },
    [vscode, handleOutputSnapshotSaved]
  );

  // Latest-value refs let the one long-lived client read current values without
  // being rebuilt (which would recreate the editor view).
  const isMultiRootWorkspaceRef = useRef(isMultiRootWorkspace);
  isMultiRootWorkspaceRef.current = isMultiRootWorkspace;
  const outputCapturePickedRef = useRef(handleOutputCapturePicked);
  outputCapturePickedRef.current = handleOutputCapturePicked;
  const viewRefForCompletion = viewRef;
  const completionClient = useMemo(
    () =>
      createPromptCompletionClient({
        transport: vscode,
        getView: () => viewRefForCompletion.current,
        getSymbolIconCache: () => symbolIconCacheRef.current,
        getIsMultiRootWorkspace: () => isMultiRootWorkspaceRef.current,
        onOutputCapturePicked: (captureId, from, to) =>
          outputCapturePickedRef.current(captureId, from, to),
      }),
    [vscode, viewRefForCompletion]
  );
  useEffect(() => () => completionClient.dispose(), [completionClient]);

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

  const handlePastedImageSaved = useCallback(
    (seq: number, relativePath?: string, error?: string) => {
      if (error || !relativePath) {
        resolvePendingPaste(seq, "");
        const messageText = error || "Failed to save pasted image";
        WebviewLog.error(
          `[CodeMirror] Pasted image save failed: ${messageText}`
        );
        notifyUser(messageText, USER_FEEDBACK_SEVERITY.ERROR);
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
          notifyUser(
            `Unsupported image type: ${item.type}`,
            USER_FEEDBACK_SEVERITY.ERROR
          );
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

  // Clear any outstanding async attachment timeouts when the component
  // unmounts. The maps themselves are cleared so late replies are ignored.
  useEffect(() => {
    const pendingPastes = pendingPastesRef.current;
    const pendingCaptures = pendingCapturesRef.current;
    return () => {
      for (const entry of pendingPastes.values()) {
        clearTimeout(entry.timeoutId);
      }
      for (const entry of pendingCaptures.values()) {
        clearTimeout(entry.timeoutId);
      }
      pendingPastes.clear();
      pendingCaptures.clear();
    };
  }, []);

  // Listen for context-reference validation and attachment responses from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === MESSAGE_TYPES.CONTEXT_REFS_VALIDATION) {
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
      } else if (message.type === MESSAGE_TYPES.OUTPUT_SNAPSHOT_SAVED) {
        handleOutputSnapshotSaved(
          message.seq,
          message.relativePath,
          message.error
        );
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handlePastedImageSaved, handleOutputSnapshotSaved]);

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorRef.current) return;

    // Create editor instance
    const view = new EditorView({
      doc: value,
      extensions: [
        minimalSetup,
        // Markdown colours only. Everything ctrlyoke draws below outranks them
        // so a reference inside emphasis or link syntax still renders as a
        // reference. Mark decorations need `Prec.highest`, not `Prec.high`:
        // `syntaxHighlighting`'s own plugin is `Prec.high`, and at equal
        // precedence its span nests inside ours, where the markdown colour
        // would override `.cm-link`'s.
        ...(mode === CODE_MIRROR_EDITOR_MODES.PROMPT
          ? [createPromptMarkdownExtension()]
          : []),
        createFindKeyHandlerExtension(),
        ...(atomicContextReferences
          ? [
              Prec.high(
                createAtomicReferenceExtension(
                  symbolIconCacheRef.current,
                  referenceValidityRef.current
                )
              ),
            ]
          : []),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnlyRef.current),
        history(),
        // Highest precedence: minimalSetup's defaultKeymap already binds
        // Mod-Enter (= Ctrl-Enter on Windows/Linux) to insertBlankLine, which
        // would otherwise swallow Ctrl-Enter before it reaches onRun.
        Prec.highest(
          keymap.of([
            {
              key: "Ctrl-Shift-Enter",
              run: () => {
                if (!onQueueRef.current) return false;
                onQueueRef.current();
                return true;
              },
            },
            {
              key: "Ctrl-Enter",
              run: () => {
                if (!onRunRef.current) return false;
                onRunRef.current();
                return true;
              },
            },
          ])
        ),
        keymap.of([
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          ...lintKeymap,
          // Fallback: insert a tab character when no completion is active.
          // completionKeymap binds Tab to acceptCompletion (returns true only
          // when a completion dropdown is open), so this only fires when there
          // is nothing to accept — preventing Tab from moving DOM focus away.
          { key: "Tab", run: insertTab },
        ]),
        placeholderCompartmentRef.current.of(placeholder(placeholderText)),
        createThemeExtension(surface),
        createPromptDecorationThemeExtension(),
        createLinterThemeExtension(),
        createActiveLineHighlightExtension(),
        highlightSelectionMatches({ minSelectionLength: 2 }),
        createSpellCheckExtension(typoCheckerRef, isMultiRootWorkspace),
        Prec.high(
          createContextReferenceLintExtension(
            validateContextReferences,
            symbolIconCacheRef.current,
            referenceValidityRef.current
          )
        ),
        promptTokenCompletionExtension({
          sources: [completionClient.customSource, completionClient.pathSource],
        }),
        EditorView.domEventHandlers({
          blur: () => {
            onBlurRef.current?.();
            return false;
          },
          ...(mode === CODE_MIRROR_EDITOR_MODES.PROMPT
            ? {
                paste: (event, view) =>
                  handleImagePaste(event as ClipboardEvent, view),
              }
            : {}),
        }),
        // Default precedence on purpose: a higher-precedence mark is drawn
        // inside a lower one, and this mark's opaque background must stay
        // outermost or it covers the lint squiggle and selection matches.
        createCodeRangeDecorationExtension(),
        // In atomic mode, createAtomicReferenceExtension already covers every
        // range these would mark (same findContextReferenceMatches /
        // findInlinePriorContextRefs / scanCtrlYokeSlashTokens tokens) with a
        // replace-widget decoration. Keeping both active means two decoration
        // sources fight over the exact same range — a replace widget from one
        // plugin and a mark from another — which is unnecessary and was
        // implicated in clicks leaving the editor unresponsive.
        // createFileRefDecorationExtension stays on regardless: it covers lone
        // prompt-path prompts (no @/#/~/$/slash trigger), which
        // findAtomicReferences deliberately excludes, so atomic mode never
        // puts a chip there.
        ...(atomicContextReferences
          ? []
          : [
              Prec.highest([
                createLinkDecorationExtension(referenceValidityRef.current),
                createPriorContextDecorationExtension(
                  referenceValidityRef.current
                ),
                createConditionOutputDecorationExtension(),
                createSlashTokenDecorationExtension(),
              ]),
            ]),
        Prec.highest(createFileRefDecorationExtension(isMultiRootWorkspace)),
        Prec.high([
          createPriorContextLintExtension(
            stepCountRef,
            hasFinalStepRef,
            referenceValidityRef.current
          ),
          createConditionOutputLintExtension(hasPreConditionRef, modeRef),
        ]),
        createClickHandlerExtension(vscode, stepCountRef),
        // iOS Safari: enable the word-suggestion bar above the keyboard and
        // autocapitalization. CodeMirror defaults these to "off" which suppresses
        // the native suggestion strip entirely on iPhone/iPad.
        EditorView.contentAttributes.of({
          autocorrect: "on",
          autocapitalize: "sentences",
          "aria-label": "Prompt editor",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newValue = update.state.doc.toString();
            onChangeRef.current(newValue);
            // Keep async attachment placeholder ranges pinned to their text as
            // the user edits before the save round trip resolves them.
            for (const pending of [
              pendingPastesRef.current,
              pendingCapturesRef.current,
            ]) {
              for (const entry of pending.values()) {
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
            mode === CODE_MIRROR_EDITOR_MODES.PROMPT &&
            (update.docChanged || update.geometryChanged)
          ) {
            const cause = update.docChanged
              ? EDITOR_OVERFLOW_CAUSES.DOC
              : EDITOR_OVERFLOW_CAUSES.GEOMETRY;
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
                    new CustomEvent<EditorOverflowDetail>(
                      EDITOR_OVERFLOW_EVENT,
                      { detail: { signedOverflow, cause } }
                    )
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
    if (mode === CODE_MIRROR_EDITOR_MODES.PROMPT) {
      view.requestMeasure({
        read(v: EditorView) {
          return v.contentHeight - v.scrollDOM.clientHeight;
        },
        write(signedOverflow: number) {
          if (!viewRef.current) return;
          if (Math.abs(signedOverflow - (lastOverflowRef.current ?? 0)) >= 1) {
            lastOverflowRef.current = signedOverflow;
            window.dispatchEvent(
              new CustomEvent<EditorOverflowDetail>(EDITOR_OVERFLOW_EVENT, {
                detail: { signedOverflow, cause: EDITOR_OVERFLOW_CAUSES.DOC },
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
    completionClient,
    validateContextReferences,
    handleImagePaste,
    mode,
    surface,
    atomicContextReferences,
    isMultiRootWorkspace,
  ]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartmentRef.current.reconfigure(
        placeholder(placeholderText)
      ),
    });
  }, [placeholderText, viewReady]);
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
// `keydown`/`blur-sm` teardown in the component (NOT EditorView.domEventHandlers,
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

// Editor-side adapter class on an atomic reference chip: it carries the shared
// `.atomic-reference-chip` presentation plus CodeMirror-only layout, and marks
// the element as a click/tap target for the editor's delegated link handlers.
const ATOMIC_REFERENCE_CHIP_CLASS = "cm-atomic-ref";

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
    // Deliberately NOT `cm-link`: a chip already reads as clickable, and that
    // class's link color + underline paint *inside* the chip box (its rules are
    // unlayered CodeMirror theme CSS, so they beat the layered
    // `.atomic-reference-chip` rules in globals.css regardless of specificity).
    // `getLinkElement` matches `.cm-atomic-ref` alongside `.cm-link` so the
    // shared click/tap handler still opens the reference from its data-* attrs.
    const chip = document.createElement("span");
    chip.className = `atomic-reference-chip ${ATOMIC_REFERENCE_CHIP_CLASS}`;
    // Warning-colored border when validation found the reference unresolvable —
    // the chip's counterpart to the lint squiggle (which a chip replaces). The
    // native title (full reference text on hover) is suppressed while invalid so
    // it doesn't fight the lint tooltip that opens on the same span; the lint
    // message folds that reference text in instead (see the linter's
    // renderMessage). Valid chips keep the native title as their only hover.
    if (this.chip.invalid) {
      chip.classList.add("cm-atomic-ref-invalid");
      // Also flag it for the click handler so it refuses to open a target the
      // validation pass already resolved as nonexistent (see
      // openContextReferenceLink).
      chip.setAttribute("data-invalid", BOOLEAN_STRING_VALUES.TRUE);
    } else {
      chip.title = this.chip.title;
    }
    for (const [key, value] of Object.entries(this.chip.attrs)) {
      chip.setAttribute(key, value);
    }
    if (this.chip.icon) {
      const icon = document.createElement("span");
      icon.className = `cm-atomic-ref-icon atomic-reference-chip-icon codicon codicon-${this.chip.icon}`;
      chip.appendChild(icon);
    }
    const label = document.createElement("span");
    label.className = "cm-atomic-ref-label atomic-reference-chip-label";
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

// Dispatched once a #sym: reference's real kind resolves asynchronously (see
// createContextReferenceLintExtension), so createAtomicReferenceExtension
// knows to rebuild chip decorations outside of a doc-change cycle.
const symbolKindsUpdatedEffect = StateEffect.define<void>();

// Dispatched once the async validation pass updates a reference's exists/not-
// found state (see createContextReferenceLintExtension), so the chip plugin
// rebuilds to add/remove the warning border outside a doc-change cycle — the
// validity map counterpart to symbolKindsUpdatedEffect.
const referenceValidityUpdatedEffect = StateEffect.define<void>();

// Dispatched when non-document lint inputs (stepCount, hasFinalStep,
// hasPreCondition, mode) change. forceLinting alone is a no-op unless a lint is
// already pending, so without this effect a prompt first linted before the
// workflow's steps loaded keeps its stale "steps do not exist" warnings until
// the user edits the text. The ref-driven linters' needsRefresh watches it.
const lintContextChangedEffect = StateEffect.define<void>();

function isLintRefreshUpdate(update: ViewUpdate): boolean {
  return (
    update.docChanged ||
    update.viewportChanged ||
    update.transactions.some((tr) =>
      tr.effects.some((effect) => effect.is(lintContextChangedEffect))
    )
  );
}

/** Re-run linting after a non-document lint input changed (see lintContextChangedEffect). */
export function relintForContextChange(view: EditorView): void {
  view.dispatch({ effects: lintContextChangedEffect.of(undefined) });
  forceLinting(view);
}

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
    class implements PluginValue {
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

// Prompt-editor-specific decoration styles (link, file-ref, code-range, prior-context).
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
    // Literal (unexpanded) ranges: readable code, not greyed out. The
    // suppressed-expansion lint warning is what flags a mistaken reference.
    ".cm-code-range": {
      fontFamily: "var(--vscode-editor-font-family)",
      backgroundColor: "var(--vscode-textPreformat-background)",
      borderRadius: "3px",
    },
    ".cm-prior-context-ref": {
      fontStyle: "italic",
    },
    ".cm-condition-output-ref": {
      fontStyle: "italic",
    },
    // Atomic-mode reference chip: the box/icon/label styling is the shared
    // `.atomic-reference-chip` rule in globals.css. This is the CodeMirror-only
    // adapter — editor widgets stay on one line even though output chips may
    // wrap long find-expanded references.
    ".cm-atomic-ref": {
      whiteSpace: "nowrap",
      verticalAlign: "baseline",
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
    // The offending reference path, folded into a not-found lint message on its
    // own line (see the linter's renderMessage). Italic + muted to read as a
    // subordinate detail; break-all so a long path wraps instead of forcing the
    // tooltip wide.
    ".cm-reference-lint-path": {
      display: "block",
      fontStyle: "italic",
      opacity: "0.85",
      marginTop: "2px",
      wordBreak: "break-all",
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
    class implements PluginValue {
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
        const excludedRanges = [
          ...getCompletionRanges(text),
          ...getMarkdownNonProseRanges(view.state, from, to),
        ];

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

/**
 * Map a shared {@link PromptDiagnostic} onto a CodeMirror diagnostic. The
 * `detail` line (the offending reference) is folded into the tooltip on its own
 * italic line; `replacements` become one-click "Change to" quick fixes.
 */
function toCodeMirrorDiagnostic(diagnostic: PromptDiagnostic): Diagnostic {
  const { detail, replacements } = diagnostic;
  return {
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    message: diagnostic.message,
    // The atomic chip suppresses its native hover title while invalid (see
    // AtomicReferenceWidget.toDOM), so the lint tooltip carries the full
    // reference text — otherwise the chip's compact label (basename only)
    // leaves the actual offending path invisible.
    ...(detail
      ? {
          renderMessage: () => {
            // Rendered inside lint's inline .cm-diagnosticText span, so the
            // path line is a display:block span (not a div) to stay valid
            // inline-nesting while still sitting on its own line.
            const fragment = document.createDocumentFragment();
            fragment.append(diagnostic.message);
            const pathLine = document.createElement("span");
            pathLine.className = "cm-reference-lint-path";
            pathLine.textContent = detail;
            fragment.appendChild(pathLine);
            return fragment;
          },
        }
      : {}),
    // apply() uses the diagnostic's live from/to so the swap lands correctly
    // even if the doc changed since linting.
    ...(replacements?.length
      ? {
          actions: replacements.map((replacement) => ({
            name: `Change to ${replacement}`,
            apply: (view: EditorView, from: number, to: number) => {
              view.dispatch({ changes: { from, to, insert: replacement } });
            },
          })),
        }
      : {}),
  };
}

export function createContextReferenceLintExtension(
  validateReferences: ContextReferenceResolver,
  symbolIconCache?: Map<string, string>,
  referenceValidity?: Map<string, boolean>
) {
  return linter(
    async (view): Promise<Diagnostic[]> => {
      const resolved = await resolvePromptReferences(
        view.state.doc.toString(),
        validateReferences
      );
      if (resolved.length === 0) {
        return [];
      }

      // Piggyback the resolved symbol kinds (present only for "symbol" refs,
      // see handleContextRefsValidation) onto the atomic-chip icon cache —
      // this lint pass already validates every reference on a debounce, so
      // it's the natural place to keep that cache warm rather than running a
      // second round trip just for icons.
      if (symbolIconCache) {
        let changed = false;
        for (const { reference, result } of resolved) {
          if (
            reference.type !== ATOMIC_REFERENCE_KINDS.SYMBOL ||
            !reference.path ||
            !reference.symbolName
          ) {
            continue;
          }
          const symbolKind = result?.symbolKind;
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
      // findAtomicReferences looks up. References inside code are skipped — they get
      // no chip — and their "expansion suppressed" warning is a separate signal
      // that does not mean the reference itself is invalid.
      if (referenceValidity) {
        let validityChanged = false;
        for (const { text: token, inCode, result } of resolved) {
          if (inCode || !result) continue;
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

      return diagnoseResolvedReferences(resolved).map(toCodeMirrorDiagnostic);
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
    createGitChangeReferencePattern(),
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

/**
 * Fence info strings (`typescript`, `ts title=a.ts`) and link/image
 * destinations are not prose, so spellcheck skips them. Offsets are relative to
 * `from`, matching the text slice the caller checks.
 */
function getMarkdownNonProseRanges(
  state: EditorState,
  from: number,
  to: number
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name === "CodeInfo" || node.name === "URL") {
        ranges.push({ from: node.from - from, to: node.to - from });
      }
    },
  });
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

// Mark fenced blocks and inline code spans as literal (`.cm-code-range`)
export function createCodeRangeDecorationExtension() {
  return ViewPlugin.fromClass(
    class implements PluginValue {
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
        const codeRanges = findCodeRanges(view.state.doc.toString());

        for (const { from, to } of view.visibleRanges) {
          for (const range of codeRanges) {
            if (range.to <= from) continue;
            if (range.from >= to) break;
            const visFrom = Math.max(range.from, from);
            const visTo = Math.min(range.to, to);
            if (visFrom < visTo) {
              builder.add(
                visFrom,
                visTo,
                Decoration.mark({ class: "cm-code-range" })
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

// Decorate links (@file, @dir/, #selection:, #sym:)
export function createLinkDecorationExtension(
  referenceValidity?: Map<string, boolean>
) {
  const linkPlugin = ViewPlugin.fromClass(
    class implements PluginValue {
      decorations;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: any) {
        // Rebuild on referenceValidityUpdatedEffect too, so a link mark picks up
        // (or clears) data-invalid when the async validation pass resolves —
        // same effect the atomic-chip plugin listens for.
        const validityUpdated = update.transactions.some((tr: any) =>
          tr.effects.some((effect: any) =>
            effect.is(referenceValidityUpdatedEffect)
          )
        );
        if (update.docChanged || update.viewportChanged || validityUpdated) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const codeRanges = findCodeRanges(view.state.doc.toString());

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          const matches = findContextReferenceMatches(text, from);

          for (const linkMatch of matches) {
            if (isInCodeRange(linkMatch.from, linkMatch.to, codeRanges))
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
            if (linkMatch.secretName) {
              attrs["data-secret-name"] = linkMatch.secretName;
            }
            // Keyed by the exact reference token, matching the validity map the
            // lint pass populates; blocks opening a nonexistent target (see
            // openContextReferenceLink). Undefined until validated → no flag.
            if (
              referenceValidity?.get(
                view.state.doc.sliceString(linkMatch.from, linkMatch.to)
              ) === false
            ) {
              attrs["data-invalid"] = BOOLEAN_STRING_VALUES.TRUE;
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

/** Decorate explicit ctrlyoke skill/MCP references; native slash commands stay plain text. */
export function createSlashTokenDecorationExtension() {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const codeRanges = findCodeRanges(view.state.doc.toString());

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          for (const token of scanCtrlYokeSlashTokens(text)) {
            if (
              isInCodeRange(
                token.index + from,
                token.index + from + token.length,
                codeRanges
              )
            ) {
              continue;
            }

            const attributes: Record<string, string> =
              token.kind === CTRLYOKE_SLASH_TOKEN_KINDS.MCP
                ? {
                    "data-type": CTRLYOKE_SLASH_TOKEN_KINDS.MCP,
                    "data-mcp-server-name": token.name,
                  }
                : {
                    "data-type": CTRLYOKE_SLASH_TOKEN_KINDS.SKILL,
                    "data-skill-name": token.name,
                  };

            builder.add(
              token.index + from,
              token.index + from + token.length,
              Decoration.mark({
                class: "cm-link",
                attributes,
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

// Decorate the entire editor content when it is a lone file-path reference
function createFileRefDecorationExtension(allowWorkspaceFolderPrefix: boolean) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
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
            attributes: {
              "data-type": ATOMIC_REFERENCE_KINDS.FILE,
              "data-path": trimmed,
            },
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

/** Apply cm-link decoration to inline $prior-context references. */
function createPriorContextDecorationExtension(
  referenceValidity?: Map<string, boolean>
) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: any) {
        const validityUpdated = update.transactions.some((tr: any) =>
          tr.effects.some((effect: any) =>
            effect.is(referenceValidityUpdatedEffect)
          )
        );
        if (update.docChanged || update.viewportChanged || validityUpdated) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const codeRanges = findCodeRanges(view.state.doc.toString());
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          const refs = findInlinePriorContextRefs(text, from);
          for (const ref of refs) {
            if (isInCodeRange(ref.from, ref.to, codeRanges)) continue;
            const attributes: Record<string, string> = {
              "data-type": ATOMIC_REFERENCE_KINDS.PRIOR_CONTEXT,
              "data-ref": formatInlinePriorContextBody(ref.ref),
            };
            if (referenceValidity?.get(ref.token) === false) {
              attributes["data-invalid"] = BOOLEAN_STRING_VALUES.TRUE;
            }
            builder.add(
              ref.from,
              ref.to,
              Decoration.mark({
                class: "cm-link cm-prior-context-ref",
                attributes,
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

/** Apply a marker to inline condition-output references. */
function createConditionOutputDecorationExtension() {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const codeRanges = findCodeRanges(view.state.doc.toString());
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          const refs = findConditionOutputRefs(text, from);
          for (const ref of refs) {
            if (isInCodeRange(ref.from, ref.to, codeRanges)) continue;
            builder.add(
              ref.from,
              ref.to,
              Decoration.mark({ class: "cm-condition-output-ref" })
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
export function createPriorContextLintExtension(
  stepCountRef: React.RefObject<number>,
  hasFinalStepRef: React.RefObject<boolean>,
  referenceValidity?: Map<string, boolean>
) {
  return linter(
    (view): Diagnostic[] => {
      const checks = checkPriorContextRefs(view.state.doc.toString(), {
        stepCount: stepCountRef.current ?? 0,
        hasFinalStep: hasFinalStepRef.current ?? false,
      });

      let validityChanged = false;
      for (const check of checks) {
        if (
          referenceValidity &&
          referenceValidity.get(check.token) !== check.valid
        ) {
          referenceValidity.set(check.token, check.valid);
          validityChanged = true;
        }
      }
      if (validityChanged) {
        view.dispatch({
          effects: referenceValidityUpdatedEffect.of(undefined),
        });
      }

      return checks.flatMap((check) =>
        check.diagnostic ? [toCodeMirrorDiagnostic(check.diagnostic)] : []
      );
    },
    {
      delay: 300,
      needsRefresh: isLintRefreshUpdate,
    }
  );
}

/** Warn when condition-output refs are unavailable in the current editor context. */
export function createConditionOutputLintExtension(
  hasPreConditionRef: React.RefObject<boolean>,
  modeRef: React.RefObject<CodeMirrorEditorMode>
) {
  return linter(
    (view): Diagnostic[] =>
      getConditionOutputDiagnostics(view.state.doc.toString(), {
        hasPreCondition: hasPreConditionRef.current ?? false,
        field:
          (modeRef.current ?? CODE_MIRROR_EDITOR_MODES.PROMPT) ===
          CODE_MIRROR_EDITOR_MODES.END_CONDITION
            ? PROMPT_DIAGNOSTIC_FIELDS.RETRY_PROMPT
            : PROMPT_DIAGNOSTIC_FIELDS.PROMPT,
      }).map(toCodeMirrorDiagnostic),
    {
      delay: 300,
      needsRefresh: isLintRefreshUpdate,
    }
  );
}

function getLinkElement(target: EventTarget | null): HTMLElement | null {
  // Atomic chips are link targets without being `.cm-link` — see
  // AtomicReferenceWidget.toDOM for why they don't carry that class.
  return target instanceof HTMLElement
    ? target.closest(`.cm-link, .${ATOMIC_REFERENCE_CHIP_CLASS}`)
    : null;
}

function openContextReferenceLink(
  target: HTMLElement,
  vscode: any,
  stepCountRef: React.RefObject<number>
): boolean {
  if (target.getAttribute("data-type") === CTRLYOKE_SLASH_TOKEN_KINDS.SKILL) {
    const skillName = target.getAttribute("data-skill-name");
    if (!skillName) return false;

    vscode.postMessage({
      type: MESSAGE_TYPES.OPEN_SKILL,
      skillName,
    });
    return true;
  }

  if (target.getAttribute("data-type") === CTRLYOKE_SLASH_TOKEN_KINDS.MCP) {
    const mcpServerName = target.getAttribute("data-mcp-server-name");
    if (!mcpServerName) return false;

    vscode.postMessage({
      type: MESSAGE_TYPES.REQUEST_MCP_CONFIG_PREVIEW,
      mcpServerName,
    });
    return true;
  }

  // The async validation pass marks references it resolved as nonexistent with
  // data-invalid (on the atomic chip and on the non-atomic link mark). Refuse to
  // open those — otherwise the click asks VS Code to open a file that isn't
  // there — and surface why, since the click is otherwise a dead no-op. Returns
  // true so the caller still consumes the event (preventDefault) rather than
  // falling through to editor cursor placement.
  if (target.getAttribute("data-invalid") === BOOLEAN_STRING_VALUES.TRUE) {
    notifyUser(
      "Can't open — this reference doesn't resolve to an existing file",
      USER_FEEDBACK_SEVERITY.WARNING
    );
    return true;
  }

  // Adapt the decoration's data-* attributes to the shared reference-open
  // logic (single-sourced with the output prompt row's inline links).
  return openContextReference(
    {
      type: asAtomicReferenceKind(target.getAttribute("data-type")),
      path: target.getAttribute("data-path"),
      gitRef: target.getAttribute("data-git-ref"),
      lineStart: target.getAttribute("data-line-start"),
      lineEnd: target.getAttribute("data-line-end"),
      ref: target.getAttribute("data-ref"),
      secretName: target.getAttribute("data-secret-name"),
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
        !target.classList.contains(ATOMIC_REFERENCE_CHIP_CLASS) &&
        type !== ATOMIC_REFERENCE_KINDS.GIT &&
        type !== ATOMIC_REFERENCE_KINDS.PRIOR_CONTEXT &&
        type !== ATOMIC_REFERENCE_KINDS.SKILL &&
        type !== ATOMIC_REFERENCE_KINDS.MCP &&
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
