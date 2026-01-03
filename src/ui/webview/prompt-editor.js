/**
 * PromptEditor - Spell checking and editing functionality for the prompt editor
 * Uses Typo.js for spell checking with wavy red underlines and suggestions
 */
(function () {
  class PromptEditor {
    constructor(editorElement, affUri, dicUri) {
      this.editor = editorElement;
      this.affUri = affUri;
      this.dicUri = dicUri;
      this.spellChecker = null;
      this.misspelledWords = new Set();
      this.checkDebounceTimer = null;
      this.isUpdatingHighlights = false;
      this.suggestionMenu = null;

      this.initSpellChecker();
      this.attachEventListeners();
    }

    async initSpellChecker() {
      console.log("[PromptEditor] Initializing spell checker...");
      console.log("[PromptEditor] .aff URI:", this.affUri);
      console.log("[PromptEditor] .dic URI:", this.dicUri);
      console.log(
        "[PromptEditor] Typo available:",
        typeof Typo !== "undefined"
      );

      try {
        console.log("[PromptEditor] Loading .aff from:", this.affUri);
        console.log("[PromptEditor] Loading .dic from:", this.dicUri);

        const affResponse = await fetch(this.affUri);
        const dicResponse = await fetch(this.dicUri);

        console.log(
          "[PromptEditor] .aff response status:",
          affResponse.status,
          affResponse.ok
        );
        console.log(
          "[PromptEditor] .dic response status:",
          dicResponse.status,
          dicResponse.ok
        );

        if (!affResponse.ok || !dicResponse.ok) {
          console.warn(
            "[PromptEditor] Failed to load spell check dictionaries"
          );
          console.warn(
            "[PromptEditor] .aff ok:",
            affResponse.ok,
            "status:",
            affResponse.status
          );
          console.warn(
            "[PromptEditor] .dic ok:",
            dicResponse.ok,
            "status:",
            dicResponse.status
          );
          return;
        }

        const affData = await affResponse.text();
        const dicData = await dicResponse.text();

        console.log("[PromptEditor] .aff data length:", affData.length);
        console.log("[PromptEditor] .dic data length:", dicData.length);
        console.log(
          "[PromptEditor] .aff first 100 chars:",
          affData.substring(0, 100)
        );
        console.log(
          "[PromptEditor] .dic first 100 chars:",
          dicData.substring(0, 100)
        );

        // Initialize Typo.js
        console.log("[PromptEditor] Creating Typo instance...");
        this.spellChecker = new Typo("en_US", affData, dicData);
        console.log(
          "[PromptEditor] Typo instance created:",
          !!this.spellChecker
        );
        console.log(
          "[PromptEditor] Typo loaded flag:",
          this.spellChecker.loaded
        );

        // Test spell checker
        const testCorrect = this.spellChecker.check("hello");
        const testIncorrect = this.spellChecker.check("helo");
        console.log(
          '[PromptEditor] Spell check test - "hello":',
          testCorrect,
          "(should be true)"
        );
        console.log(
          '[PromptEditor] Spell check test - "helo":',
          testIncorrect,
          "(should be false)"
        );

        if (!testIncorrect) {
          const suggestions = this.spellChecker.suggest("helo");
          console.log('[PromptEditor] Suggestions for "helo":', suggestions);
        }

        // Re-check current content if any
        if (this.editor.textContent.trim()) {
          console.log("[PromptEditor] Re-checking existing content");
          this.checkSpelling();
        }

        console.log("[PromptEditor] Spell checker initialization complete");
      } catch (error) {
        console.error(
          "[PromptEditor] Error initializing spell checker:",
          error
        );
        console.error("[PromptEditor] Error stack:", error.stack);
      }
    }

    attachEventListeners() {
      // Debounced spell check on input
      this.editor.addEventListener("input", () => {
        clearTimeout(this.checkDebounceTimer);
        this.checkDebounceTimer = setTimeout(() => {
          if (!this.isUpdatingHighlights) {
            this.checkSpelling();
          }
        }, 300); // 300ms debounce
      });

      // Right-click for suggestions
      this.editor.addEventListener("contextmenu", (e) => {
        const word = this.getWordAtPosition(e.clientX, e.clientY);
        if (word && this.misspelledWords.has(word.toLowerCase())) {
          this.showSpellingSuggestions(word, e.clientX, e.clientY);
          e.preventDefault();
        }
      });

      // Close suggestion menu on click outside
      document.addEventListener("click", (e) => {
        if (this.suggestionMenu && !this.suggestionMenu.contains(e.target)) {
          this.closeSuggestionMenu();
        }
      });
    }

    checkSpelling() {
      if (!this.spellChecker) {
        console.log(
          "[PromptEditor] checkSpelling called but spellChecker not ready"
        );
        return;
      }

      console.log("[PromptEditor] ========== checkSpelling START ==========");
      this.isUpdatingHighlights = true;

      // EXTENSIVE LOGGING: Log DOM state BEFORE extraction
      console.log("[PromptEditor] === BEFORE EXTRACTION ===");
      console.log(
        "[PromptEditor] editor.innerHTML:",
        this.editor.innerHTML.substring(0, 500)
      );
      console.log(
        "[PromptEditor] editor.childNodes.length:",
        this.editor.childNodes.length
      );
      this.logDOMStructure();

      // Save cursor position WITH DETAILED LOGGING
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        console.log("[PromptEditor] Selection details:");
        console.log(
          "  - anchorNode:",
          selection.anchorNode?.nodeName,
          selection.anchorNode?.textContent?.substring(0, 50)
        );
        console.log("  - anchorOffset:", selection.anchorOffset);
        console.log(
          "  - focusNode:",
          selection.focusNode?.nodeName,
          selection.focusNode?.textContent?.substring(0, 50)
        );
        console.log("  - focusOffset:", selection.focusOffset);
        console.log(
          "  - range.startContainer:",
          range.startContainer?.nodeName,
          range.startContainer?.textContent?.substring(0, 50)
        );
        console.log("  - range.startOffset:", range.startOffset);
      }

      const cursorOffset = this.getCursorOffset();
      console.log("[PromptEditor] Calculated cursor offset:", cursorOffset);

      // Get plain text (converting DIV/BR/P elements to newlines)
      const text = this.getTextWithNewlines();
      console.log("[PromptEditor] === EXTRACTED TEXT ===");
      console.log("[PromptEditor] Text length:", text.length);
      console.log(
        "[PromptEditor] Text (with \\n visible):",
        JSON.stringify(text)
      );
      console.log(
        "[PromptEditor] Number of newlines:",
        (text.match(/\n/g) || []).length
      );
      console.log(
        "[PromptEditor] Text content for verification:",
        this.editor.textContent.length,
        "chars"
      );

      // Extract words with positions
      const words = this.extractWords(text);
      console.log("[PromptEditor] Extracted", words.length, "words");

      // Clear misspelled words set
      this.misspelledWords.clear();

      // Build new HTML with spell check highlights
      const highlightedHTML = this.buildHighlightedHTML(text, words);
      console.log("[PromptEditor] === GENERATED HTML ===");
      console.log("[PromptEditor] HTML length:", highlightedHTML.length);
      console.log(
        "[PromptEditor] HTML (first 500 chars):",
        highlightedHTML.substring(0, 500)
      );
      console.log(
        "[PromptEditor] Number of <div> tags:",
        (highlightedHTML.match(/<div>/g) || []).length
      );

      // Update editor content
      console.log("[PromptEditor] === SETTING INNERHTML ===");
      this.editor.innerHTML = highlightedHTML;

      console.log("[PromptEditor] === AFTER SETTING INNERHTML ===");
      console.log(
        "[PromptEditor] editor.childNodes.length:",
        this.editor.childNodes.length
      );
      console.log(
        "[PromptEditor] textContent length:",
        this.editor.textContent.length
      );
      console.log(
        "[PromptEditor] textContent (with \\n visible):",
        JSON.stringify(this.editor.textContent)
      );
      this.logDOMStructure();

      // Restore cursor position WITH DETAILED LOGGING
      console.log("[PromptEditor] === RESTORING CURSOR ===");
      console.log("[PromptEditor] Target cursor offset:", cursorOffset);
      this.restoreCursorOffset(cursorOffset);

      console.log("[PromptEditor] === AFTER CURSOR RESTORATION ===");
      const newSelection = window.getSelection();
      if (newSelection.rangeCount > 0) {
        const newRange = newSelection.getRangeAt(0);
        console.log("[PromptEditor] New selection details:");
        console.log(
          "  - anchorNode:",
          newSelection.anchorNode?.nodeName,
          newSelection.anchorNode?.textContent?.substring(0, 50)
        );
        console.log("  - anchorOffset:", newSelection.anchorOffset);
        console.log(
          "  - range.startContainer:",
          newRange.startContainer?.nodeName,
          newRange.startContainer?.textContent?.substring(0, 50)
        );
        console.log("  - range.startOffset:", newRange.startOffset);
      }

      const newCursorOffset = this.getCursorOffset();
      console.log("[PromptEditor] Verified cursor offset:", newCursorOffset);
      console.log(
        "[PromptEditor] Cursor offset delta:",
        newCursorOffset - cursorOffset
      );

      console.log(
        "[PromptEditor] Found",
        this.misspelledWords.size,
        "misspelled words:",
        [...this.misspelledWords]
      );
      console.log("[PromptEditor] ========== checkSpelling END ==========");

      this.isUpdatingHighlights = false;
    }

    logDOMStructure() {
      console.log("[PromptEditor] DOM Structure:");
      for (let i = 0; i < Math.min(this.editor.childNodes.length, 20); i++) {
        const node = this.editor.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE) {
          console.log(
            `  [${i}] TEXT: ${JSON.stringify(node.textContent.substring(0, 50))}`
          );
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const elem = node;
          console.log(
            `  [${i}] ${elem.tagName}: ${JSON.stringify(elem.textContent.substring(0, 50))} (${elem.childNodes.length} children)`
          );
        }
      }
      if (this.editor.childNodes.length > 20) {
        console.log(
          `  ... and ${this.editor.childNodes.length - 20} more nodes`
        );
      }
    }

    extractWords(text) {
      const wordRegex = /\b[a-zA-Z]+\b/g;
      const words = [];
      let match;

      while ((match = wordRegex.exec(text)) !== null) {
        words.push({
          word: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
      }

      return words;
    }

    buildHighlightedHTML(text, words) {
      // Split text into lines FIRST, then process each line separately
      // This ensures blank lines are preserved as separate elements with text nodes
      const lines = text.split("\n");
      let lineHTMLs = [];
      let globalOffset = 0;

      let checkedCount = 0;
      let misspelledCount = 0;

      // Process each line independently
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const lineText = lines[lineIndex];
        const lineStart = globalOffset;
        const lineEnd = lineStart + lineText.length;

        // Find words that belong to this line
        const lineWords = words.filter(
          (w) => w.start >= lineStart && w.end <= lineEnd
        );

        let lineHTML = "";
        let lastIndex = 0;

        lineWords.forEach(({ word, start, end }) => {
          // Convert global offsets to line-relative offsets
          const localStart = start - lineStart;
          const localEnd = end - lineStart;

          // Add text before word
          const beforeText = lineText.substring(lastIndex, localStart);
          lineHTML += this.escapeHTMLLine(beforeText);

          // Check spelling
          const isCorrect = this.spellChecker.check(word);
          checkedCount++;

          if (isCorrect) {
            lineHTML += this.escapeHTMLLine(word);
          } else {
            misspelledCount++;
            lineHTML += `<span class="misspelled-word" data-word="${this.escapeHTMLLine(word)}">${this.escapeHTMLLine(word)}</span>`;
            this.misspelledWords.add(word.toLowerCase());
            console.log("[PromptEditor] Misspelled word:", word);
          }

          lastIndex = localEnd;
        });

        // Add remaining text in line
        lineHTML += this.escapeHTMLLine(lineText.substring(lastIndex));

        // Ensure every line has at least a zero-width space to maintain cursor positions
        // This is CRITICAL for blank lines and cursor positioning
        if (lineHTML === "") {
          lineHTML = "&#8203;"; // Zero-width space - gives cursor a place to land
        }

        lineHTMLs.push(lineHTML);
        globalOffset = lineEnd + 1; // +1 for the \n we split on
      }

      console.log(
        "[PromptEditor] Checked",
        checkedCount,
        "words, found",
        misspelledCount,
        "misspelled"
      );

      // Join lines with <br>, but wrap in divs for better cursor positioning
      // Using divs ensures each line (even blank ones) is a separate block
      const html = lineHTMLs
        .map((lineHTML) => `<div>${lineHTML}</div>`)
        .join("");

      return html;
    }

    getCursorOffset() {
      const selection = window.getSelection();
      if (!selection.rangeCount) {
        console.log("[getCursorOffset] No selection range");
        return 0;
      }

      const range = selection.getRangeAt(0);

      // CRITICAL: Use the same text extraction logic as getTextWithNewlines()
      // to ensure cursor offset calculation matches the text we'll be working with
      const tempDiv = document.createElement("div");
      tempDiv.appendChild(this.editor.cloneNode(true));

      // Get the text WITH newlines using our extraction logic
      const fullText = this.getTextWithNewlinesFrom(this.editor);

      // Create a range from start of editor to cursor position
      const preCaretRange = range.cloneRange();
      preCaretRange.selectNodeContents(this.editor);
      preCaretRange.setEnd(range.endContainer, range.endOffset);

      // Get the text BEFORE cursor using our extraction logic
      const preCaretDiv = document.createElement("div");
      preCaretDiv.appendChild(preCaretRange.cloneContents());
      const textBeforeCursor = this.getTextWithNewlinesFrom(preCaretDiv);

      // Filter out zero-width spaces
      const offset = textBeforeCursor.replace(/\u200B/g, "").length;

      console.log(
        "[getCursorOffset] Text before cursor:",
        JSON.stringify(textBeforeCursor.slice(-50))
      );
      console.log(
        "[getCursorOffset] Offset (after removing zero-width):",
        offset
      );
      console.log(
        "[getCursorOffset] Full text length:",
        fullText.replace(/\u200B/g, "").length
      );

      return offset;
    }

    /**
     * Get text with newlines from any element (not just this.editor)
     */
    getTextWithNewlinesFrom(element) {
      let text = "";
      const nodes = element.childNodes;

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === "BR") {
            text += "\n";
          } else if (node.tagName === "DIV" || node.tagName === "P") {
            // Block elements - add newline before (except first)
            if (i > 0) text += "\n";

            // Get text content, filtering out zero-width spaces
            const nodeText = this.getNodeTextWithNewlines(node);
            const cleanText = nodeText.replace(/\u200B/g, ""); // Remove zero-width spaces
            text += cleanText;
          } else {
            // Inline elements (like SPAN for spell check) - just get text
            text += this.getNodeTextWithNewlines(node);
          }
        }
      }

      return text;
    }

    /**
     * Get editor text content with DIV/BR/P elements converted to \n
     */
    getTextWithNewlines() {
      return this.getTextWithNewlinesFrom(this.editor);
    }

    /**
     * Recursively get text from a node, converting BR elements to \n
     */
    getNodeTextWithNewlines(node) {
      let text = "";

      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === "BR") {
          return "\n";
        }

        // Recursively process child nodes
        for (let i = 0; i < node.childNodes.length; i++) {
          text += this.getNodeTextWithNewlines(node.childNodes[i]);
        }
      }

      return text;
    }

    restoreCursorOffset(offset) {
      console.log(
        "[restoreCursorOffset] Starting restoration to offset:",
        offset
      );

      const selection = window.getSelection();
      const range = document.createRange();

      let currentOffset = 0;
      let found = false;

      // Walk through all text nodes, counting characters (excluding zero-width spaces)
      // AND accounting for newlines between DIVs
      const walker = document.createTreeWalker(
        this.editor,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let nodeIndex = 0;
      let previousDivIndex = -1;
      let node;

      while ((node = walker.nextNode())) {
        // Find which DIV this text node belongs to
        let parentDiv = node.parentElement;
        while (
          parentDiv &&
          parentDiv !== this.editor &&
          parentDiv.tagName !== "DIV"
        ) {
          parentDiv = parentDiv.parentElement;
        }

        let currentDivIndex = -1;
        if (parentDiv && parentDiv.tagName === "DIV") {
          // Find the index of this DIV among editor's child nodes
          for (let i = 0; i < this.editor.childNodes.length; i++) {
            if (this.editor.childNodes[i] === parentDiv) {
              currentDivIndex = i;
              break;
            }
          }
        }

        // Add newline for DIV transitions (matching getTextWithNewlinesFrom logic)
        // Each DIV after the first adds a newline BEFORE its content
        if (currentDivIndex > 0 && currentDivIndex !== previousDivIndex) {
          currentOffset += 1; // Add 1 for the newline
          console.log(
            `[restoreCursorOffset] DIV transition (${previousDivIndex} -> ${currentDivIndex}), added newline, offset now: ${currentOffset}`
          );
        }
        previousDivIndex = currentDivIndex;

        // Get text without zero-width spaces for offset calculation
        const nodeText = node.textContent;
        const cleanText = nodeText.replace(/\u200B/g, "");
        const cleanLength = cleanText.length;

        console.log(
          `[restoreCursorOffset] Node ${nodeIndex} (DIV ${currentDivIndex}): "${JSON.stringify(nodeText.substring(0, 30))}" (clean: ${cleanLength} chars, raw: ${nodeText.length} chars)`
        );
        console.log(
          `[restoreCursorOffset] Current offset: ${currentOffset}, target: ${offset}`
        );

        if (currentOffset + cleanLength >= offset) {
          // Target position is within this text node
          // Calculate position in the ACTUAL node (which may include zero-width spaces)
          let targetOffsetInCleanText = offset - currentOffset;

          console.log(
            `[restoreCursorOffset] Target is in this node at clean offset: ${targetOffsetInCleanText}`
          );

          // Map clean text position back to original node position
          let actualOffset = 0;
          let cleanPosition = 0;

          for (let i = 0; i < nodeText.length; i++) {
            if (nodeText[i] !== "\u200B") {
              if (cleanPosition === targetOffsetInCleanText) {
                actualOffset = i;
                console.log(
                  `[restoreCursorOffset] Mapped to actual node offset: ${actualOffset}`
                );
                break;
              }
              cleanPosition++;
            }
          }

          // Handle case where cursor should be at end of clean text
          if (cleanPosition === targetOffsetInCleanText) {
            actualOffset = nodeText.length;
            console.log(
              `[restoreCursorOffset] Cursor at end of node, actual offset: ${actualOffset}`
            );
          }

          console.log(
            `[restoreCursorOffset] Setting range in node ${nodeIndex} at offset ${actualOffset}`
          );
          range.setStart(node, actualOffset);
          range.collapse(true);
          found = true;
          break;
        }

        currentOffset += cleanLength;
        nodeIndex++;
      }

      if (!found) {
        console.log(
          `[restoreCursorOffset] Target offset ${offset} not found, placing at end`
        );
        // Cursor is beyond all text - place at end
        const lastNode = this.getLastTextNode(this.editor);
        if (lastNode) {
          console.log(
            `[restoreCursorOffset] Placing at end of last text node: "${JSON.stringify(lastNode.textContent.substring(0, 30))}"`
          );
          range.setStart(lastNode, lastNode.textContent.length);
          range.collapse(true);
        } else {
          console.log(
            `[restoreCursorOffset] No text nodes found, placing at start of editor`
          );
          // No text nodes at all - place at start of editor
          range.setStart(this.editor, 0);
          range.collapse(true);
        }
      }

      selection.removeAllRanges();
      selection.addRange(range);
      console.log(
        `[restoreCursorOffset] Range applied, cursor restoration complete`
      );
    }

    getLastTextNode(element) {
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let lastNode = null;
      let node;
      while ((node = walker.nextNode())) {
        lastNode = node;
      }

      return lastNode;
    }

    getWordAtPosition(x, y) {
      // Get element at position
      const element = document.elementFromPoint(x, y);
      if (!element) return null;

      // Check if it's a misspelled word span
      if (element.classList.contains("misspelled-word")) {
        return element.dataset.word;
      }

      // Check if parent is misspelled word
      if (
        element.parentElement &&
        element.parentElement.classList.contains("misspelled-word")
      ) {
        return element.parentElement.dataset.word;
      }

      return null;
    }

    async showSpellingSuggestions(word, x, y) {
      this.closeSuggestionMenu();

      const suggestions = this.spellChecker.suggest(word);

      // Create context menu
      const menu = document.createElement("div");
      menu.className = "spell-check-menu";
      menu.style.position = "fixed";
      menu.style.left = x + "px";
      menu.style.top = y + "px";

      if (suggestions.length === 0) {
        menu.innerHTML = '<div class="menu-item disabled">No suggestions</div>';
      } else {
        suggestions.slice(0, 5).forEach((suggestion) => {
          const item = document.createElement("div");
          item.className = "menu-item";
          item.textContent = suggestion;
          item.addEventListener("click", (e) => {
            e.stopPropagation();
            this.replaceWord(word, suggestion);
            this.closeSuggestionMenu();
          });
          menu.appendChild(item);
        });

        // Add separator
        const separator = document.createElement("div");
        separator.className = "menu-separator";
        menu.appendChild(separator);

        // Add "Add to dictionary" option
        const addItem = document.createElement("div");
        addItem.className = "menu-item";
        addItem.textContent = "Add to dictionary";
        addItem.addEventListener("click", (e) => {
          e.stopPropagation();
          this.addToDictionary(word);
          this.closeSuggestionMenu();
        });
        menu.appendChild(addItem);
      }

      document.body.appendChild(menu);
      this.suggestionMenu = menu;
    }

    closeSuggestionMenu() {
      if (this.suggestionMenu) {
        document.body.removeChild(this.suggestionMenu);
        this.suggestionMenu = null;
      }
    }

    replaceWord(oldWord, newWord) {
      // Find all spans with this word and replace
      const spans = this.editor.querySelectorAll(
        `.misspelled-word[data-word="${this.escapeHTML(oldWord)}"]`
      );

      spans.forEach((span) => {
        const textNode = document.createTextNode(newWord);
        span.parentNode.replaceChild(textNode, span);
      });

      // Merge adjacent text nodes
      this.editor.normalize();

      // Re-check spelling
      this.checkSpelling();
    }

    addToDictionary(word) {
      // Add word to custom dictionary (stored in localStorage)
      const customDict = this.getCustomDictionary();
      customDict.add(word.toLowerCase());
      this.saveCustomDictionary(customDict);

      // Remove highlighting for this word
      this.misspelledWords.delete(word.toLowerCase());
      this.checkSpelling();
    }

    getCustomDictionary() {
      const stored = localStorage.getItem("flightpath.customDictionary");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    }

    saveCustomDictionary(dict) {
      localStorage.setItem(
        "flightpath.customDictionary",
        JSON.stringify([...dict])
      );
    }

    escapeHTMLLine(str) {
      // Escape HTML entities for a single line (no newline conversion needed)
      const div = document.createElement("div");
      div.textContent = str;
      // Preserve multiple spaces
      return div.innerHTML.replace(/  /g, " &nbsp;");
    }

    // Public API for updating editor content
    setText(text) {
      this.editor.textContent = text;
      this.checkSpelling();
    }

    getText() {
      return this.editor.textContent;
    }

    clear() {
      this.editor.innerHTML = "";
      this.misspelledWords.clear();
    }

    focus() {
      this.editor.focus();
    }
  }

  // Export to global scope
  window.PromptEditor = PromptEditor;
})();
