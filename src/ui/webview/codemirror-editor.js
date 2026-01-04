/**
 * CodeMirrorPromptEditor - Modern text editor for FlightPath prompts
 * Replaces contenteditable-based prompt-editor.js
 *
 * Features:
 * - Native spell checking
 * - Custom autocomplete for @file and #file references
 * - Clickable links with Ctrl+Click
 * - VS Code theme integration
 * - Undo/redo, search, multiple selections
 */

(function () {
  // Will be populated when CodeMirror modules are loaded
  let CM = null;

  class CodeMirrorPromptEditor {
    constructor(containerElement, affUri, dicUri, vscodeApi) {
      this.container = containerElement;
      this.view = null;
      this.onChangeCallback = null;
      this.pendingCompletionResolve = null;
      this.pendingCompletionTrigger = null; // Store trigger char for prefix preservation
      this.typoChecker = null;
      this.affUri = affUri;
      this.dicUri = dicUri;
      // Cache the VS Code API instance (can only be acquired once per webview)
      this.vscode = vscodeApi || window.vscode;

      this.init();
    }

    async init() {
      // Wait for CodeMirror to be available
      await this.waitForCodeMirror();

      // Initialize Typo.js spell checker (parallel with CodeMirror)
      this.initTypoChecker(this.affUri, this.dicUri);

      // Create editor instance
      this.view = new CM.EditorView({
        doc: "",
        extensions: this.buildExtensions(),
        parent: this.container,
      });
    }

    async waitForCodeMirror() {
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (window.CM) {
            CM = window.CM;
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);
      });
    }

    buildExtensions() {
      const { EditorView, keymap, ViewPlugin, Decoration } = CM;
      const { minimalSetup } = CM;
      const { autocompletion, completionKeymap } = CM;
      const { history, historyKeymap } = CM;
      const { searchKeymap } = CM;

      return [
        minimalSetup,
        EditorView.lineWrapping,
        history(),
        keymap.of([...historyKeymap, ...searchKeymap, ...completionKeymap]),
        this.themeExtension(),
        this.linterThemeExtension(),
        this.spellCheckExtension(),
        this.autocompletionExtension(),
        this.linkDecorationExtension(),
        this.updateListenerExtension(),
        this.keymapExtension(),
        this.clickHandlerExtension(),
      ];
    }

    // Theme matching VS Code
    themeExtension() {
      const { EditorView } = CM;

      return EditorView.theme(
        {
          "&": {
            color: "var(--vscode-editor-foreground)",
            backgroundColor: "var(--vscode-editor-background)",
            height: "100%",
          },
          ".cm-content": {
            caretColor: "var(--vscode-editorCursor-foreground)",
            fontFamily:
              "var(--vscode-editor-font-family, 'Consolas, monospace')",
            fontSize: "var(--vscode-editor-font-size, 14px)",
            padding: "8px 0",
          },
          ".cm-line": {
            padding: "0 4px",
          },
          ".cm-cursor": {
            borderLeftColor: "var(--vscode-editorCursor-foreground)",
          },
          ".cm-selectionBackground": {
            backgroundColor:
              "var(--vscode-editor-selectionBackground) !important",
          },
          "&.cm-focused .cm-selectionBackground": {
            backgroundColor:
              "var(--vscode-editor-selectionBackground) !important",
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
          ".cm-link": {
            color: "var(--vscode-textLink-foreground)",
            textDecoration: "underline",
            cursor: "pointer",
          },
          ".cm-link:hover": {
            color: "var(--vscode-textLink-activeForeground)",
          },
          "&.cm-focused": {
            outline: "1px solid var(--vscode-focusBorder)",
          },
          // Autocomplete dropdown styling with VS Code theme colors
          ".cm-tooltip-autocomplete": {
            backgroundColor: "var(--vscode-editorSuggestWidget-background)",
            border: "1px solid var(--vscode-editorSuggestWidget-border)",
            boxShadow: "0 2px 8px var(--vscode-widget-shadow)",
          },
          ".cm-tooltip-autocomplete ul": {
            fontFamily:
              "var(--vscode-editor-font-family, 'Consolas, monospace')",
          },
          ".cm-tooltip-autocomplete li": {
            color: "var(--vscode-editorSuggestWidget-foreground)",
          },
          ".cm-tooltip-autocomplete li[aria-selected]": {
            backgroundColor:
              "var(--vscode-editorSuggestWidget-selectedBackground)",
            color: "var(--vscode-editorSuggestWidget-selectedForeground)",
          },
          // Type-based completion styling (icons and labels with VS Code semantic token colors)
          // Classes are applied to <li> elements via optionClass
          ".cm-completion-class .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-classForeground, #ee9d28)",
          },
          ".cm-completion-class .cm-completionLabel": {
            color: "var(--vscode-symbolIcon-classForeground, #ee9d28)",
          },
          ".cm-completion-method .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-methodForeground, #b180d7)",
          },
          ".cm-completion-method .cm-completionLabel": {
            color: "var(--vscode-symbolIcon-methodForeground, #b180d7)",
          },
          ".cm-completion-function .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-functionForeground, #b180d7)",
          },
          ".cm-completion-function .cm-completionLabel": {
            color: "var(--vscode-symbolIcon-functionForeground, #b180d7)",
          },
          ".cm-completion-property .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-propertyForeground, #75beff)",
          },
          ".cm-completion-property .cm-completionLabel": {
            color: "var(--vscode-symbolIcon-propertyForeground, #75beff)",
          },
          ".cm-completion-variable .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-variableForeground, #75beff)",
          },
          ".cm-completion-variable .cm-completionLabel": {
            color: "var(--vscode-symbolIcon-variableForeground, #75beff)",
          },
          ".cm-completion-type .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-typeForeground, #4ec9b0)",
          },
          ".cm-completion-type .cm-completionLabel": {
            color: "var(--vscode-symbolIcon-typeForeground, #4ec9b0)",
          },
          ".cm-completion-string .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-stringForeground, #ce9178)",
          },
          ".cm-completion-string .cm-completionLabel": {
            color: "var(--vscode-symbolIcon-stringForeground, #ce9178)",
          },
          ".cm-completion-keyword .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-keywordForeground, #569cd6)",
          },
          ".cm-completion-keyword .cm-completionLabel": {
            color: "var(--vscode-symbolIcon-keywordForeground, #569cd6)",
          },
          // Custom styling for file/folder completions
          ".cm-completion-file .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-fileForeground, #858585)",
          },
          ".cm-completion-file .cm-completionLabel": {
            color: "var(--vscode-editorSuggestWidget-foreground)",
          },
          ".cm-completion-folder .cm-completionIcon": {
            color: "var(--vscode-symbolIcon-folderForeground, #dcb67a",
          },
          ".cm-completion-folder .cm-completionLabel": {
            color: "var(--vscode-symbolIcon-folderForeground, #dcb67a",
          },
        },
        { dark: document.body.classList.contains("vscode-dark") }
      );
    }

    // Linter theme for squiggly underlines and tooltips
    linterThemeExtension() {
      const { EditorView } = CM;

      return EditorView.baseTheme({
        // Squiggly underlines for linter diagnostics
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
        ".cm-lintRange-info": {
          backgroundImage:
            "url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%226%22 height=%223%22><path d=%22m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0%22 stroke=%22%23999%22 fill=%22none%22 stroke-width=%22.7%22/></svg>')",
        },
        ".cm-lintRange-hint": {
          backgroundImage:
            "url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%226%22 height=%223%22><path d=%22m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0%22 stroke=%22%2366d%22 fill=%22none%22 stroke-width=%22.7%22/></svg>')",
        },
        // Vertical layout for spell check action buttons
        ".cm-tooltip-lint": {
          padding: "0",
          margin: "0",
        },
        ".cm-diagnostic": {
          padding: "3px 6px 3px 8px",
          marginLeft: "-1px",
          display: "block",
          whiteSpace: "pre-wrap",
        },
        ".cm-diagnosticText": {
          display: "block",
          marginBottom: "4px",
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
        ".cm-diagnosticAction:active": {
          backgroundColor: "var(--vscode-button-background)",
        },
      });
    }

    // Typo.js spell checking via CodeMirror linter
    spellCheckExtension() {
      const { linter } = CM;

      return linter(
        (view) => {
          if (!this.typoChecker) return [];

          const diagnostics = [];
          const text = view.state.doc.toString();

          // Get ranges to exclude from spell checking (@ and # references)
          const excludedRanges = this.getCompletionRanges(text);

          const wordRegex = /\b[a-zA-Z]+\b/g;
          let match;

          while ((match = wordRegex.exec(text)) !== null) {
            const word = match[0];
            const from = match.index;
            const to = from + word.length;

            // Skip spell checking if word is within a completion range
            if (this.isInExcludedRange(from, to, excludedRanges)) {
              continue;
            }

            if (!this.typoChecker.check(word)) {
              const suggestions = this.typoChecker.suggest(word);
              const message =
                suggestions.length > 0
                  ? `Spelling: "${word}". Suggestions: ${suggestions.slice(0, 3).join(", ")}`
                  : `Spelling: "${word}"`;

              diagnostics.push({
                from: from,
                to: to,
                severity: "warning",
                message: message,
                actions: suggestions.slice(0, 5).map((suggestion) => ({
                  name: `Change to "${suggestion}"`,
                  apply: (view, from, to) => {
                    view.dispatch({
                      changes: { from, to, insert: suggestion },
                    });
                  },
                })),
              });
            }
          }

          return diagnostics;
        },
        {
          delay: 300, // Debounce spell checking
        }
      );
    }

    // Get ranges of @ and # completions to exclude from spell checking
    getCompletionRanges(text) {
      const ranges = [];

      // Patterns matching @ and # completions
      const patterns = [
        // @file.ext (no trailing slash, has extension or path separator)
        /@[^\s@#]+/g,

        // #file:, #selection, #caret, #sym:, etc.
        /#[^\s@#]+/g,
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
    isInExcludedRange(from, to, excludedRanges) {
      for (const range of excludedRanges) {
        // Check if word is completely or partially within excluded range
        if (from < range.to && to > range.from) {
          return true;
        }
      }
      return false;
    }

    // Initialize Typo.js checker
    async initTypoChecker(affUri, dicUri) {
      console.log("[CodeMirror] Loading Typo.js dictionaries...");

      try {
        const [affData, dicData] = await Promise.all([
          fetch(affUri).then((r) => r.text()),
          fetch(dicUri).then((r) => r.text()),
        ]);

        this.typoChecker = new Typo("en_US", affData, dicData, {
          platform: "any",
        });

        console.log("[CodeMirror] Typo.js dictionaries loaded");
      } catch (error) {
        console.error(
          "[CodeMirror] Failed to load Typo.js dictionaries:",
          error
        );
        this.typoChecker = null;
      }
    }

    // Autocomplete for @file and #file
    autocompletionExtension() {
      const { autocompletion } = CM;

      return autocompletion({
        override: [this.customCompletions.bind(this)],
        activateOnTyping: true,
        closeOnBlur: true,
        // Add type-based class to each option for coloring
        optionClass: this.completionOptionClass.bind(this),
        // Add icon elements for file/folder types
        addToOptions: [
          {
            render: (completion, state) => {
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
      });
    }

    // Add CSS class based on completion type for theme coloring
    completionOptionClass(completion) {
      // Add type-based class to the <li> element for styling
      return `cm-completion-${completion.type || "text"}`;
    }

    customCompletions(context) {
      // Match @ or # patterns for completions
      // @ matches: @file.ext, @path/to/file, @dir/
      // # matches: #selection, #caret, #file:path:10-20, #sym:path:symbol:42
      const before = context.matchBefore(
        /@[a-zA-Z0-9_/.-]*|#[a-zA-Z0-9_/:.-]*/
      );

      console.log("[CodeMirror] customCompletions called, before:", before);

      if (!before) {
        console.log("[CodeMirror] No match found, returning null");
        return null;
      }

      // Don't provide completions on empty match unless explicitly requested
      if (before.from === before.to && !context.explicit) {
        console.log(
          "[CodeMirror] Empty match and not explicit, returning null"
        );
        return null;
      }

      const trigger = before.text[0]; // @ or #
      const from = before.from;

      console.log(
        `[CodeMirror] Requesting completions: trigger="${trigger}", prefix="${before.text}", position=${from}, explicit=${context.explicit}`
      );

      // Request completions from extension host
      return new Promise((resolve) => {
        this.pendingCompletionResolve = resolve;
        this.pendingCompletionTrigger = trigger; // Store for apply text

        // Use cached VS Code API instance
        this.vscode.postMessage({
          type: "requestCompletions",
          trigger: trigger,
          prefix: before.text,
          position: from,
        });

        console.log(
          "[CodeMirror] Message sent to extension, waiting for response..."
        );
      });
    }

    // Handle completion response from extension
    handleCompletionResponse(items, from) {
      console.log(
        `[CodeMirror] handleCompletionResponse called: ${items.length} items, from=${from}`
      );

      if (!this.pendingCompletionResolve) {
        console.log(
          "[CodeMirror] No pending completion resolve, ignoring response"
        );
        return;
      }

      // Get the trigger character to prepend to completion text
      const trigger = this.pendingCompletionTrigger || "";

      const completions = items.map((item, index) => {
        // Calculate boost from sortText if available, otherwise use index
        // sortText format: "0_...", "1_...", etc. where lower prefix = higher priority
        let boost;
        if (item.sortText) {
          // Extract prefix number (e.g., "0_" -> 0, "1_" -> 1)
          const prefixMatch = item.sortText.match(/^(\d+)_/);
          if (prefixMatch) {
            const prefix = parseInt(prefixMatch[1]);
            // Invert so lower prefix = higher boost (0 -> 1000, 1 -> 900, etc.)
            // Also incorporate index within same prefix for stability
            boost = 1000 - prefix * 100 - index * 0.01;
          } else {
            // No numeric prefix, use negative index
            boost = -index;
          }
        } else {
          // No sortText, preserve array order with negative index
          boost = -index;
        }

        // Map VS Code CompletionItemKind (numeric) to CodeMirror type string
        // https://code.visualstudio.com/api/references/vscode-api#CompletionItemKind
        let type = "text";
        if (item.kind !== undefined) {
          const kindMap = {
            0: "text", // Text
            1: "method", // Method
            2: "function", // Function
            3: "function", // Constructor (treat as function)
            4: "property", // Field (treat as property)
            5: "variable", // Variable
            6: "class", // Class
            7: "interface", // Interface
            8: "namespace", // Module
            9: "property", // Property
            10: "constant", // Unit
            11: "constant", // Value
            12: "enum", // Enum
            13: "keyword", // Keyword
            14: "text", // Snippet (treat as text)
            15: "string", // Color (treat as string)
            16: "file", // File
            17: "text", // Reference
            18: "folder", // Folder (changed from "directory" to match CodeMirror's expected type)
            19: "enum", // EnumMember (treat as enum)
            20: "constant", // Constant
            21: "class", // Struct (treat as class)
            22: "text", // Event
            23: "text", // Operator
            24: "type", // TypeParameter
          };
          type = kindMap[item.kind] || "text";

          // Log mapping for first item to debug
          if (index === 0) {
            console.log(
              `[CodeMirror] Kind mapping for first item: kind=${item.kind} (${typeof item.kind}) -> type="${type}"`
            );
          }
        }

        return {
          label: item.label,
          type: type,
          // Don't prepend trigger - it stays in the document at position 'from'
          // We only replace from 'from + 1' onward
          apply: item.insertText || item.label,
          detail: item.detail,
          // info: item.documentation, // Commented out to keep tooltip compact (can re-enable with setting)
          // Preserve sort order from extension (server-side relevance ranking)
          boost: boost,
          // Store sortText for debugging
          _sortText: item.sortText,
        };
      });

      console.log(
        `[CodeMirror] Resolved ${items.length} completions with fuzzy matching enabled`
      );

      // Return completion result
      // Enable CodeMirror's built-in fuzzy matching (matches VS Code behavior)
      // IMPORTANT: Skip trigger character (@/#) in 'from' position so CodeMirror
      // matches against "src" instead of "@src" (labels don't include trigger)
      this.pendingCompletionResolve({
        from: from + 1, // Skip the @ or # trigger character
        options: completions,
        filter: true, // Let CodeMirror do fuzzy matching (highlights matches, ranks by relevance)
      });

      this.pendingCompletionResolve = null;
      this.pendingCompletionTrigger = null;
    }

    // Decorate links (@file, @dir/, #file:, #sym:)
    linkDecorationExtension() {
      const { ViewPlugin, Decoration } = CM;

      const linkPlugin = ViewPlugin.fromClass(
        class {
          decorations;

          constructor(view) {
            this.decorations = this.buildDecorations(view);
          }

          update(update) {
            if (update.docChanged || update.viewportChanged) {
              this.decorations = this.buildDecorations(update.view);
            }
          }

          buildDecorations(view) {
            const builder = new CM.RangeSetBuilder();

            // Regex patterns matching PromptLinkProvider
            const patterns = {
              // @file.ext (no trailing slash, has extension)
              fullFile: /@([^\s@#]+\.[a-zA-Z0-9]+)/g,

              // @dir/ (trailing slash)
              directory: /@([^\s@#]+\/)/g,

              // #file:path:10-20 (line range)
              lineRange: /#file:([^\s:]+):(\d+)-(\d+)/g,

              // #sym:path:symbol:42 (symbol reference)
              symbol: /#sym:([^\s:]+):([^:]+):(\d+)/g,
            };

            for (let { from, to } of view.visibleRanges) {
              const text = view.state.doc.sliceString(from, to);

              // Collect all matches with their positions
              const matches = [];

              // 1. Full file references (@file.ext)
              let match;
              const fullFileRegex = new RegExp(patterns.fullFile.source, "g");
              while ((match = fullFileRegex.exec(text)) !== null) {
                matches.push({
                  from: from + match.index,
                  to: from + match.index + match[0].length,
                  type: "file",
                  path: match[1],
                });
              }

              // 2. Directory references (@dir/)
              const directoryRegex = new RegExp(patterns.directory.source, "g");
              while ((match = directoryRegex.exec(text)) !== null) {
                matches.push({
                  from: from + match.index,
                  to: from + match.index + match[0].length,
                  type: "directory",
                  path: match[1],
                });
              }

              // 3. Line range references (#file:path:10-20)
              const lineRangeRegex = new RegExp(patterns.lineRange.source, "g");
              while ((match = lineRangeRegex.exec(text)) !== null) {
                matches.push({
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
                matches.push({
                  from: from + match.index,
                  to: from + match.index + match[0].length,
                  type: "symbol",
                  path: match[1],
                  symbolName: match[2],
                  line: match[3],
                });
              }

              // Sort matches by position and add decorations
              matches.sort((a, b) => a.from - b.from);

              for (const linkMatch of matches) {
                const attrs = {
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
    clickHandlerExtension() {
      const { EditorView } = CM;

      return EditorView.domEventHandlers({
        click: (event, view) => {
          if (!(event.ctrlKey || event.metaKey)) return false;

          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;

          // Check if we clicked on a link decoration
          const target = event.target;
          if (target.classList.contains("cm-link")) {
            const type = target.getAttribute("data-type");
            const path = target.getAttribute("data-path");

            // Handle different link types
            if (type === "file" || type === "directory") {
              // Simple file/directory open (no line numbers)
              this.vscode.postMessage({
                type: "openFile",
                path: path,
              });
            } else if (type === "lineRange") {
              // #file:path:10-20 (line range)
              const lineStart = target.getAttribute("data-line-start");
              const lineEnd = target.getAttribute("data-line-end");
              this.vscode.postMessage({
                type: "openFile",
                path: path,
                lineStart: lineStart ? parseInt(lineStart) : undefined,
                lineEnd: lineEnd ? parseInt(lineEnd) : undefined,
              });
            } else if (type === "symbol") {
              // #sym:path:symbol:42 (single line)
              const line = target.getAttribute("data-line");
              this.vscode.postMessage({
                type: "openFile",
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

    // Update listener for change notifications
    updateListenerExtension() {
      const { EditorView } = CM;

      return EditorView.updateListener.of((update) => {
        if (update.docChanged && this.onChangeCallback) {
          this.onChangeCallback(this.getText());
        }
      });
    }

    // Custom keybindings
    keymapExtension() {
      const { keymap } = CM;
      const { defaultKeymap } = CM;

      return keymap.of([
        ...defaultKeymap,
        // Add custom keybindings here if needed
        // { key: "Ctrl-Enter", run: () => { /* trigger run */ return true; } }
      ]);
    }

    // Public API
    getText() {
      return this.view ? this.view.state.doc.toString() : "";
    }

    setText(text) {
      if (!this.view) return;

      const { EditorView } = CM;
      this.view.dispatch({
        changes: {
          from: 0,
          to: this.view.state.doc.length,
          insert: text,
        },
      });
    }

    clear() {
      this.setText("");
    }

    focus() {
      if (this.view) {
        this.view.focus();
      }
    }

    onChange(callback) {
      this.onChangeCallback = callback;
    }

    destroy() {
      if (this.view) {
        this.view.destroy();
        this.view = null;
      }
    }
  }

  // Export to global scope
  window.CodeMirrorPromptEditor = CodeMirrorPromptEditor;
})();
