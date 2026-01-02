/**
 * PromptEditor - Spell checking and editing functionality for the prompt editor
 * Uses Typo.js for spell checking with wavy red underlines and suggestions
 */
(function () {
  class PromptEditor {
    constructor(editorElement, dictionaryPath) {
      this.editor = editorElement;
      this.dictionaryPath = dictionaryPath;
      this.spellChecker = null;
      this.misspelledWords = new Set();
      this.checkDebounceTimer = null;
      this.isUpdatingHighlights = false;
      this.suggestionMenu = null;

      this.initSpellChecker();
      this.attachEventListeners();
    }

    async initSpellChecker() {
      try {
        // Load dictionary files
        const affResponse = await fetch(`${this.dictionaryPath}/en_US.aff`);
        const dicResponse = await fetch(`${this.dictionaryPath}/en_US.dic`);

        if (!affResponse.ok || !dicResponse.ok) {
          console.warn("Failed to load spell check dictionaries");
          return;
        }

        const affData = await affResponse.text();
        const dicData = await dicResponse.text();

        // Initialize Typo.js
        this.spellChecker = new Typo("en_US", affData, dicData);

        // Re-check current content if any
        if (this.editor.textContent.trim()) {
          this.checkSpelling();
        }
      } catch (error) {
        console.error("Error initializing spell checker:", error);
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
      if (!this.spellChecker) return;

      this.isUpdatingHighlights = true;

      // Save cursor position
      const cursorOffset = this.getCursorOffset();

      // Get plain text
      const text = this.editor.textContent;

      // Extract words with positions
      const words = this.extractWords(text);

      // Clear misspelled words set
      this.misspelledWords.clear();

      // Build new HTML with spell check highlights
      const highlightedHTML = this.buildHighlightedHTML(text, words);

      // Update editor content
      this.editor.innerHTML = highlightedHTML;

      // Restore cursor position
      this.restoreCursorOffset(cursorOffset);

      this.isUpdatingHighlights = false;
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
      let html = "";
      let lastIndex = 0;

      words.forEach(({ word, start, end }) => {
        // Add text before word
        html += this.escapeHTML(text.substring(lastIndex, start));

        // Check spelling
        const isCorrect = this.spellChecker.check(word);

        if (isCorrect) {
          html += this.escapeHTML(word);
        } else {
          html += `<span class="misspelled-word" data-word="${this.escapeHTML(word)}">${this.escapeHTML(word)}</span>`;
          this.misspelledWords.add(word.toLowerCase());
        }

        lastIndex = end;
      });

      // Add remaining text
      html += this.escapeHTML(text.substring(lastIndex));

      return html;
    }

    getCursorOffset() {
      const selection = window.getSelection();
      if (!selection.rangeCount) return 0;

      const range = selection.getRangeAt(0);
      const preCaretRange = range.cloneRange();
      preCaretRange.selectNodeContents(this.editor);
      preCaretRange.setEnd(range.endContainer, range.endOffset);

      return preCaretRange.toString().length;
    }

    restoreCursorOffset(offset) {
      const selection = window.getSelection();
      const range = document.createRange();

      let currentOffset = 0;
      let found = false;

      const walker = document.createTreeWalker(
        this.editor,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let node;
      while ((node = walker.nextNode())) {
        const nodeLength = node.textContent.length;

        if (currentOffset + nodeLength >= offset) {
          range.setStart(node, offset - currentOffset);
          range.collapse(true);
          found = true;
          break;
        }

        currentOffset += nodeLength;
      }

      if (found) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
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

    escapeHTML(str) {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
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
