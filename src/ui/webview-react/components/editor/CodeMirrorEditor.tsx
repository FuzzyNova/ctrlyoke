import React, { useEffect, useRef, useCallback } from "react";
import {
  EditorView,
  placeholder,
  keymap,
  ViewPlugin,
  Decoration,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { minimalSetup } from "codemirror";
import {
  autocompletion,
  completionKeymap,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { linter } from "@codemirror/lint";
import { RangeSetBuilder } from "@codemirror/state";
import { getVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";
import { WebviewLog } from "../../utils/logger";

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
  const { value, onChange, affUri, dicUri, readOnly = false } = props;
  const placeholderText =
    props.placeholder ||
    "Use @ for files and folders, # for selections and symbols";

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const typoCheckerRef = useRef<TypoChecker | null>(null);
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  const pendingCompletionResolveRef = useRef<((value: any) => void) | null>(
    null
  );
  const pendingCompletionTriggerRef = useRef<string | null>(null);
  const completionSeqRef = useRef(0);

  const vscode = getVsCodeApi();

  // Keep onChange ref current
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
        // Calculate boost from sortText
        let boost: number;
        if (item.sortText) {
          const prefixMatch = item.sortText.match(/^(\d+)_/);
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
      pendingCompletionResolveRef.current({
        from: from + 1, // Skip the @ or # trigger character
        options: completions,
      });

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
      // Match @ or # patterns for completions
      const before = context.matchBefore(
        /@[a-zA-Z0-9_/.-]*|#[a-zA-Z0-9_/:.-]*/
      );

      if (!before) return null;
      if (before.from === before.to && !context.explicit) return null;

      const trigger = before.text[0]; // @ or #
      const from = before.from;

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
          prefix: before.text,
          position: from,
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
        keymap.of([...historyKeymap, ...searchKeymap, ...completionKeymap]),
        placeholder(placeholderText),
        createThemeExtension(),
        createLinterThemeExtension(),
        createSpellCheckExtension(typoCheckerRef),
        autocompletion({
          override: [customCompletions],
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
        createClickHandlerExtension(vscode),
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
  }, [placeholderText, customCompletions]);
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
      // Link styling for clickable @file and #file references
      ".cm-link": {
        color: "var(--vscode-textLink-foreground)",
        textDecoration: "underline",
        cursor: "pointer",
      },
      ".cm-link:hover": {
        color: "var(--vscode-textLink-activeForeground)",
      },
    },
    { dark: document.body.classList.contains("vscode-dark") }
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

      const diagnostics: any[] = [];

      // Only check visible ranges for performance
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);

        // Get ranges to exclude from spell checking (@ and # references)
        const excludedRanges = getCompletionRanges(text);

        // Match words with contractions and hyphens
        const wordRegex = /\b[a-zA-Z]+(?:['-][a-zA-Z]+)*\b/g;
        let match;

        while ((match = wordRegex.exec(text)) !== null) {
          const word = match[0];
          const wordFrom = from + match.index;
          const wordTo = wordFrom + word.length;

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

          if (!typoCheckerRef.current.check(word)) {
            const checker = typoCheckerRef.current;
            const diagnostic = {
              from: wordFrom,
              to: wordTo,
              severity: "error" as const,
              message: `Spelling: "${word}"`,
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
              _word: word,
              _cachedActions: null,
            };

            diagnostics.push(diagnostic);
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

  const patterns = [/@[^\s@#]+/g, /#[^\s@#]+/g];

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

        // Regex patterns matching PromptLinkHarness
        const patterns = {
          // @file.ext (no trailing slash, has extension)
          // Negative lookahead (?!\/) ensures we don't match if followed by /
          // This prevents @.flightpath/ from being treated as a file
          fullFile: /@([^\s@#]+\.[a-zA-Z0-9]+)(?!\/)/g,

          // @dir/ (trailing slash)
          directory: /@([^\s@#]+\/)/g,

          // #file:path:10-20 (line range)
          lineRange: /#file:([^\s:]+):(\d+)-(\d+)/g,

          // #sym:path:symbol:42 (symbol reference)
          symbol: /#sym:([^\s:]+):([^:]+):(\d+)/g,
        };

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);

          // Collect all matches with their positions
          const fileMatches: any[] = [];
          const directoryMatches: any[] = [];
          const lineRangeMatches: any[] = [];
          const symbolMatches: any[] = [];

          // 1. Full file references (@file.ext)
          let match;
          const fullFileRegex = new RegExp(patterns.fullFile.source, "g");
          while ((match = fullFileRegex.exec(text)) !== null) {
            fileMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "file",
              path: match[1],
            });
          }

          // 2. Directory references (@dir/)
          const directoryRegex = new RegExp(patterns.directory.source, "g");
          while ((match = directoryRegex.exec(text)) !== null) {
            directoryMatches.push({
              from: from + match.index,
              to: from + match.index + match[0].length,
              type: "directory",
              path: match[1],
            });
          }

          // 3. Line range references (#file:path:10-20)
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

          // 4. Symbol references (#sym:path:symbol:42)
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

          // Combine all matches (with filtered directories)
          const matches = [
            ...fileMatches,
            ...filteredDirectoryMatches,
            ...lineRangeMatches,
            ...symbolMatches,
          ];

          // Sort matches by position and add decorations
          matches.sort((a, b) => a.from - b.from);

          for (const linkMatch of matches) {
            const attrs: Record<string, string> = {
              "data-type": linkMatch.type,
              "data-path": linkMatch.path,
            };

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
          // #file:path:10-20 (line range)
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
        }

        event.preventDefault();
        return true;
      }

      return false;
    },
  });
}
