import React, { useEffect, useRef, useCallback } from "react";
import {
  EditorView,
  placeholder,
  keymap,
  ViewPlugin,
  Decoration,
  highlightActiveLine,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { minimalSetup } from "codemirror";
import {
  autocompletion,
  completionKeymap,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { linter, lintKeymap } from "@codemirror/lint";
import { RangeSetBuilder } from "@codemirror/state";
import { getVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES, EDITOR_PLACEHOLDER_TEXT } from "../../types/messages";
import { WebviewLog } from "../../utils/logger";
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

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  affUri: string;
  dicUri: string;
  /** When true, the editor is read-only (no edits allowed). */
  readOnly?: boolean;
  /** Called when Alt+Enter is pressed. */
  onRun?: () => void;
  /** Called when Alt+Shift+Enter is pressed. */
  onQueue?: () => void;
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
    value,
    onChange,
    affUri,
    dicUri,
    readOnly = false,
    onRun,
    onQueue,
  } = props;
  const placeholderText = props.placeholder || EDITOR_PLACEHOLDER_TEXT.DEFAULT;

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const typoCheckerRef = useRef<TypoChecker | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const onQueueRef = useRef(onQueue);
  const readOnlyRef = useRef(readOnly);
  const pendingCompletionResolveRef = useRef<((value: any) => void) | null>(
    null
  );
  const pendingCompletionTriggerRef = useRef<string | null>(null);
  const completionSeqRef = useRef(0);

  const vscode = getVsCodeApi();

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

  // Handle completion response from extension
  const handleCompletionResponse = useCallback(
    (items: any[], from: number, seq?: number) => {
      // Discard stale responses from earlier requests
      if (seq !== undefined && seq !== completionSeqRef.current) {
        return;
      }
      if (!pendingCompletionResolveRef.current) {
        return;
      }

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

        // Map VS Code CompletionItemKind to CodeMirror type
        const kindMap: Record<number, string> = {
          0: "text",
          1: "method",
          2: "function",
          3: "function",
          4: "property",
          5: "variable",
          6: "class",
          7: "interface",
          8: "namespace",
          9: "property",
          10: "constant",
          11: "constant",
          12: "enum",
          13: "keyword",
          14: "text",
          15: "string",
          16: "file",
          17: "text",
          18: "folder",
          19: "enum",
          20: "constant",
          21: "class",
        };

        const type =
          item.kind !== undefined ? kindMap[item.kind] || "text" : "text";

        return {
          label: item.label,
          type,
          detail: item.detail,
          boost,
          // Don't prepend trigger - it stays in the document at position 'from'
          // We only replace from 'from + 1' onward
          apply: item.insertText || item.label,
        };
      });

      // IMPORTANT: Skip trigger character (@/#) in 'from' position so CodeMirror
      // matches against "src" instead of "@src" (labels don't include trigger)
      // "path" completions replace from the start of the typed path (no trigger char to skip)
      const isPathCompletion = pendingCompletionTriggerRef.current === "path";
      const fromOffset = isPathCompletion ? 0 : 1;

      const result: CompletionResult = {
        from: from + fromOffset,
        options: completions,
      };
      // Disable CodeMirror's built-in fuzzy filter for path completions.
      // The query text (the full path) won't match filename labels, so we
      // handle all filtering on the extension side.
      if (isPathCompletion) {
        result.filter = false;
      }

      pendingCompletionResolveRef.current(result);

      pendingCompletionResolveRef.current = null;
      pendingCompletionTriggerRef.current = null;
    },
    []
  );

  // Listen for completion responses from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === MESSAGE_TYPES.COMPLETIONS_RESPONSE) {
        handleCompletionResponse(
          message.items || [],
          message.from,
          message.seq
        );
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleCompletionResponse]);

  // Custom completions source
  const customCompletions = useCallback(
    (context: any): Promise<CompletionResult | null> | null => {
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

      const maxIndex = Math.max(lastAtIndex, lastHashIndex, lastTildeIndex);
      if (maxIndex === -1) return null;

      let trigger: string;
      let afterTrigger: string;

      if (maxIndex === lastAtIndex) {
        trigger = "@";
        afterTrigger = textBefore.slice(lastAtIndex + 1);
      } else if (maxIndex === lastHashIndex) {
        trigger = "#";
        afterTrigger = textBefore.slice(lastHashIndex + 1);
      } else {
        trigger = "~";
        afterTrigger = textBefore.slice(lastTildeIndex + 1);
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

      const from = lineObj.from + maxIndex; // absolute position of trigger char

      if (from === context.pos && !context.explicit) return null;

      // Assign a sequence number so stale responses can be discarded
      const seq = ++completionSeqRef.current;

      // Request completions from extension host
      return new Promise<CompletionResult | null>((resolve) => {
        // Cancel any pending completion that will never be fulfilled
        if (pendingCompletionResolveRef.current) {
          pendingCompletionResolveRef.current(null);
        }
        pendingCompletionResolveRef.current = resolve;
        pendingCompletionTriggerRef.current = trigger;

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
      const before = context.matchBefore(
        /(?:\.\.?\/|\/|[a-zA-Z]:[/\\])[^\s\n]*/
      );
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
        pendingCompletionTriggerRef.current = "path";

        vscode.postMessage({
          type: MESSAGE_TYPES.REQUEST_COMPLETIONS,
          trigger: "path",
          prefix: before.text,
          position: before.from,
          seq,
        });
      });
    },
    [vscode]
  );

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorRef.current) return;

    // Create editor instance
    const view = new EditorView({
      doc: value,
      extensions: [
        minimalSetup,
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
              onQueueRef.current?.();
              return true;
            },
          },
          {
            key: "Alt-Enter",
            run: () => {
              onRunRef.current?.();
              return true;
            },
          },
        ]),
        placeholder(placeholderText),
        createThemeExtension(),
        createLinterThemeExtension(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        createSpellCheckExtension(typoCheckerRef),
        autocompletion({
          override: [customCompletions, pathCompletions],
          activateOnTyping: true,
          closeOnBlur: true,
          optionClass: (completion) =>
            `cm-completion-${completion.type || "text"}`,
          // Add icon elements for file/folder types
          addToOptions: [
            {
              render: (completion) => {
                // Only render icons for file/folder types
                // Return null for other types to avoid empty space
                if (completion.type === "file") {
                  const icon = document.createElement("span");
                  icon.className = "cm-completionIcon";
                  icon.textContent = "📄";
                  return icon;
                } else if (completion.type === "folder") {
                  const icon = document.createElement("span");
                  icon.className = "cm-completionIcon";
                  icon.textContent = "📁";
                  return icon;
                }

                // Return null for all other types (let CodeMirror handle them)
                return null;
              },
              position: 20, // Position before label
            },
          ],
        }),
        createLinkDecorationExtension(),
        createFileRefDecorationExtension(),
        createClickHandlerExtension(vscode),
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
          }
        }),
      ],
      parent: editorRef.current,
    });

    viewRef.current = view;

    // Dispatch ready event
    window.dispatchEvent(new CustomEvent("codemirror-ready"));

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeholderText, customCompletions, pathCompletions]);
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

  return <div ref={editorRef} className="h-full w-full codemirror-editor" />;
};

// VS Code theme integration
function createThemeExtension() {
  return EditorView.theme(
    {
      "&": {
        color: "var(--vscode-editor-foreground)",
        backgroundColor: "var(--vscode-editor-background)",
        height: "100%",
      },
      ".cm-content": {
        caretColor: "var(--vscode-editorCursor-foreground)",
        fontFamily: "var(--vscode-editor-font-family, 'Consolas, monospace')",
        fontSize: "var(--vscode-editor-font-size, 14px)",
        padding: "8px 0",
      },
      ".cm-line": {
        padding: "0 8px",
      },
      ".cm-cursor": {
        borderLeftColor: "var(--vscode-editorCursor-foreground)",
      },
      ".cm-selectionBackground": {
        backgroundColor: "var(--vscode-editor-selectionBackground) !important",
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "var(--vscode-editor-selectionBackground) !important",
      },
      ".cm-activeLine": {
        backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--vscode-editorGutter-background)",
        color: "var(--vscode-editorLineNumber-foreground)",
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
      },
      "&.cm-focused": {
        outline: "1px solid var(--vscode-focusBorder)",
      },
      ".cm-placeholder": {
        color: "var(--vscode-input-placeholderForeground)",
        fontStyle: "italic",
      },
      // Autocomplete dropdown styling
      ".cm-tooltip-autocomplete": {
        backgroundColor: "var(--vscode-editorSuggestWidget-background)",
        border: "1px solid var(--vscode-editorSuggestWidget-border)",
        boxShadow: "0 2px 8px var(--vscode-widget-shadow)",
      },
      ".cm-tooltip-autocomplete ul": {
        fontFamily: "var(--vscode-editor-font-family, 'Consolas, monospace')",
      },
      ".cm-tooltip-autocomplete li": {
        color: "var(--vscode-editorSuggestWidget-foreground)",
      },
      ".cm-tooltip-autocomplete li:hover": {
        backgroundColor: "var(--vscode-list-hoverBackground)",
        color: "var(--vscode-list-hoverForeground)",
      },
      ".cm-tooltip-autocomplete li[aria-selected]": {
        backgroundColor: "var(--vscode-editorSuggestWidget-selectedBackground)",
        color: "var(--vscode-editorSuggestWidget-selectedForeground)",
      },
      // Type-based completion styling
      ".cm-completion-file .cm-completionIcon": {
        color: "var(--vscode-symbolIcon-fileForeground, #858585)",
      },
      ".cm-completion-folder .cm-completionIcon": {
        color: "var(--vscode-symbolIcon-folderForeground, #dcb67a)",
      },
      ".cm-completion-class .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-classForeground, #ee9d28)",
      },
      ".cm-completion-method .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-methodForeground, #b180d7)",
      },
      ".cm-completion-function .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-functionForeground, #b180d7)",
      },
      ".cm-completion-property .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-propertyForeground, #75beff)",
      },
      ".cm-completion-variable .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-variableForeground, #75beff)",
      },
      // Find/replace search match highlights (@codemirror/search)
      ".cm-searchMatch": {
        backgroundColor:
          "var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33))",
        outline:
          "1px solid var(--vscode-editor-findMatchHighlightBorder, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor:
          "var(--vscode-editor-findMatchBackground, rgba(234, 92, 0, 0.7))",
        outline: "1px solid var(--vscode-editor-findMatchBorder, #f38518)",
      },
      // Selection match highlight (highlightSelectionMatches)
      ".cm-selectionMatch": {
        backgroundColor:
          "var(--vscode-editor-selectionHighlightBackground, rgba(173, 214, 255, 0.15))",
        outline:
          "1px solid var(--vscode-editor-selectionHighlightBorder, rgba(173, 214, 255, 0.4))",
      },
      // Link styling for clickable @file and #file references
      ".cm-link": {
        color: "var(--vscode-textLink-foreground)",
        textDecoration: "underline",
        cursor: "pointer",
      },
      ".cm-link:hover": {
        color: "var(--vscode-textLink-activeForeground)",
      },
      // File-reference styling — applied when the entire editor content is a lone path
      ".cm-prompt-file-ref": {
        color: "var(--vscode-textLink-foreground)",
        textDecoration: "underline",
        fontFamily: "var(--vscode-editor-font-family)",
      },
    },
    {
      // CodeMirror only supports dark:true/false — no separate high-contrast mode.
      // In VS Code the body carries "vscode-dark"; in the browser-hosted dashboard
      // --fp-color-theme-kind is injected on :root via buildThemeStyleBlock and
      // mirrored onto the body class by standalone-shim.js, so both checks work.
      dark:
        document.body.classList.contains("vscode-dark") ||
        window
          .getComputedStyle(document.documentElement)
          .getPropertyValue("--fp-color-theme-kind")
          .trim() !== "light",
    }
  );
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

// Spell checking with Typo.js
function createSpellCheckExtension(
  typoCheckerRef: React.RefObject<TypoChecker | null>
) {
  return linter(
    (view) => {
      if (!typoCheckerRef.current) return [];

      // Skip spellcheck entirely when the document is a lone file-path reference
      if (looksLikeFilePath(view.state.doc.toString().trim())) return [];

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

        // Regex patterns matching PromptLinkProvider.
        // Each reference type supports both plain paths and quoted paths
        // (quoted form used when the path contains spaces).
        const patterns = {
          // @"path with spaces/file.ext" (quoted path, full file)
          fullFileQuoted: /@"([^"]+\.[a-zA-Z0-9]+)"(?!\/)/g,

          // @"path with spaces/dir/" (quoted path, directory)
          directoryQuoted: /@"([^"]+\/)"(?![\w])/g,

          // @file.ext (unquoted, no trailing slash, has extension)
          // Negative lookahead (?!\/) ensures we don't match if followed by /
          fullFile: /@([^\s@#"]+\.[a-zA-Z0-9]+)(?!\/)/g,

          // @dir/ (unquoted, trailing slash)
          directory: /@([^\s@#"]+\/)/g,

          // #selection:"path with spaces/file":10-20 (quoted path, line range)
          lineRangeQuoted: /#selection:"([^"]+)":(\d+)-(\d+)/g,

          // #selection:path:10-20 (unquoted, line range)
          lineRange: /#selection:([^\s:]+):(\d+)-(\d+)/g,

          // #sym:"path with spaces/file":symbol:42 (quoted path, symbol reference)
          symbolQuoted: /#sym:"([^"]+)":([^:]+):(\d+)/g,

          // #sym:path:symbol:42 (unquoted, symbol reference)
          symbol: /#sym:([^\s:]+):([^:]+):(\d+)/g,
        };

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);

          // Collect all matches with their positions
          const fileMatches: any[] = [];
          const directoryMatches: any[] = [];
          const lineRangeMatches: any[] = [];
          const symbolMatches: any[] = [];

          let match;

          // 1a. Quoted full file references (@"path with spaces/file.ext")
          const fullFileQuotedRegex = new RegExp(
            patterns.fullFileQuoted.source,
            "g"
          );
          while ((match = fullFileQuotedRegex.exec(text)) !== null) {
            fileMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "file",
              path: match[1],
            });
          }

          // 1b. Plain full file references (@file.ext)
          const fullFileRegex = new RegExp(patterns.fullFile.source, "g");
          while ((match = fullFileRegex.exec(text)) !== null) {
            fileMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "file",
              path: match[1],
            });
          }

          // 2a. Quoted directory references (@"path with spaces/dir/")
          const directoryQuotedRegex = new RegExp(
            patterns.directoryQuoted.source,
            "g"
          );
          while ((match = directoryQuotedRegex.exec(text)) !== null) {
            directoryMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "directory",
              path: match[1],
            });
          }

          // 2b. Plain directory references (@dir/)
          const directoryRegex = new RegExp(patterns.directory.source, "g");
          while ((match = directoryRegex.exec(text)) !== null) {
            directoryMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "directory",
              path: match[1],
            });
          }

          // 3a. Quoted line range references (#selection:"path with spaces/file":10-20)
          const lineRangeQuotedRegex = new RegExp(
            patterns.lineRangeQuoted.source,
            "g"
          );
          while ((match = lineRangeQuotedRegex.exec(text)) !== null) {
            lineRangeMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "lineRange",
              path: match[1],
              lineStart: match[2],
              lineEnd: match[3],
            });
          }

          // 3b. Plain line range references (#selection:path:10-20)
          const lineRangeRegex = new RegExp(patterns.lineRange.source, "g");
          while ((match = lineRangeRegex.exec(text)) !== null) {
            lineRangeMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "lineRange",
              path: match[1],
              lineStart: match[2],
              lineEnd: match[3],
            });
          }

          // 4a. Quoted symbol references (#sym:"path with spaces/file":symbol:42)
          const symbolQuotedRegex = new RegExp(
            patterns.symbolQuoted.source,
            "g"
          );
          while ((match = symbolQuotedRegex.exec(text)) !== null) {
            symbolMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "symbol",
              path: match[1],
              symbolName: match[2],
              line: match[3],
            });
          }

          // 4b. Plain symbol references (#sym:path:symbol:42)
          const symbolRegex = new RegExp(patterns.symbol.source, "g");
          while ((match = symbolRegex.exec(text)) !== null) {
            symbolMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "symbol",
              path: match[1],
              symbolName: match[2],
              line: match[3],
            });
          }

          // Filter out directory matches that are contained within file matches
          // This prevents @path/ from being a separate link when @path/to/file.ts exists
          const filteredDirectoryMatches = directoryMatches.filter(
            (dirMatch) => {
              return !fileMatches.some(
                (fileMatch) =>
                  dirMatch.from >= fileMatch.from && dirMatch.to <= fileMatch.to
              );
            }
          );

          // 5. Git change references (~diff, ~staged, ~stash:N, ~<hash>)
          const gitMatches: any[] = [];

          const gitPatterns = {
            gitFixed: /~(diff|staged)/g,
            gitStash: /~(stash:\d+)/g,
            gitCommit: /~([0-9a-f]{7,40})/gi,
          };

          const gitFixedRegex = new RegExp(gitPatterns.gitFixed.source, "g");
          while ((match = gitFixedRegex.exec(text)) !== null) {
            gitMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "git",
              gitRef: match[1],
            });
          }

          const gitStashRegex = new RegExp(gitPatterns.gitStash.source, "g");
          while ((match = gitStashRegex.exec(text)) !== null) {
            gitMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "git",
              gitRef: match[1],
            });
          }

          const gitCommitRegex = new RegExp(gitPatterns.gitCommit.source, "gi");
          while ((match = gitCommitRegex.exec(text)) !== null) {
            // Ensure this wasn't already matched as gitFixed or gitStash
            const matchFrom = from + match.index;
            if (!gitMatches.some((m) => m.from === matchFrom)) {
              gitMatches.push({
                from: matchFrom,
                to: from + match.index + match[0].length,
                type: "git",
                gitRef: match[1].toLowerCase(),
              });
            }
          }

          // Combine all matches (with filtered directories)
          const matches = [
            ...fileMatches,
            ...filteredDirectoryMatches,
            ...lineRangeMatches,
            ...symbolMatches,
            ...gitMatches,
          ];

          // Sort matches by position and add decorations
          matches.sort((a, b) => a.from - b.from);

          for (const linkMatch of matches) {
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
            if (linkMatch.line) {
              attrs["data-line"] = linkMatch.line;
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
function createFileRefDecorationExtension() {
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
        if (!trimmed || !looksLikeFilePath(trimmed)) {
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

// Handle Ctrl+Click on links
function createClickHandlerExtension(vscode: any) {
  return EditorView.domEventHandlers({
    click: (event, view) => {
      if (!(event.ctrlKey || event.metaKey)) return false;

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      // Check if we clicked on a link decoration
      const target = event.target as HTMLElement;
      if (target.classList.contains("cm-link")) {
        const type = target.getAttribute("data-type");
        const path = target.getAttribute("data-path");

        // Handle different link types
        if (type === "file" || type === "directory") {
          // Simple file/directory open (no line numbers)
          vscode.postMessage({
            type: MESSAGE_TYPES.OPEN_FILE,
            path: path,
          });
        } else if (type === "lineRange") {
          // #selection:path:10-20 (line range)
          const lineStart = target.getAttribute("data-line-start");
          const lineEnd = target.getAttribute("data-line-end");
          vscode.postMessage({
            type: MESSAGE_TYPES.OPEN_FILE,
            path: path,
            lineStart: lineStart ? parseInt(lineStart) : undefined,
            lineEnd: lineEnd ? parseInt(lineEnd) : undefined,
          });
        } else if (type === "symbol") {
          // #sym:path:symbol:42 (single line)
          const line = target.getAttribute("data-line");
          vscode.postMessage({
            type: MESSAGE_TYPES.OPEN_FILE,
            path: path,
            lineStart: line ? parseInt(line) : undefined,
            lineEnd: line ? parseInt(line) : undefined,
          });
        } else if (type === "git") {
          // ~diff, ~staged, ~stash:N, ~<hash>
          const gitRef = target.getAttribute("data-git-ref");
          vscode.postMessage({
            type: MESSAGE_TYPES.OPEN_GIT_CHANGE,
            ref: gitRef,
          });
        }

        event.preventDefault();
        return true;
      }

      return false;
    },
  });
}
