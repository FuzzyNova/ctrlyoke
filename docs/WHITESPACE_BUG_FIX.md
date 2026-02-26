# Whitespace Bug Fix

## Problem

When editing text in the prompt editor and adding multiple return carriages (newlines), the cursor would:

- Jump back to the last line of text
- Collapse return characters and whitespace
- Generally behave erratically

## Root Cause

The spell-checking logic was interfering with cursor position in two ways:

1. **Whitespace Collapse in HTML Escaping**: The `escapeHTML()` function was using `textContent` → `innerHTML` conversion, which doesn't preserve consecutive whitespace or newlines. When the editor content was replaced during spell checking, multiple newlines would collapse into single spaces.

2. **Cursor Position Restoration**: The `restoreCursorOffset()` function only walked TEXT nodes, ignoring `<br>` elements. This caused the cursor position calculation to be incorrect when the content included line breaks.

## Solution

### 1. Preserve Whitespace in HTML (`escapeHTML`)

Modified the function to explicitly preserve newlines and multiple spaces:

```javascript
escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  let escaped = div.innerHTML;

  // Preserve whitespace: replace newlines with <br> and multiple spaces
  escaped = escaped
    .replace(/\n/g, '<br>')
    .replace(/  /g, ' &nbsp;'); // Preserve double spaces

  return escaped;
}
```

### 2. Handle BR Elements in Cursor Restoration (`restoreCursorOffset`)

Updated the TreeWalker to accept both TEXT nodes and BR elements, counting each BR as a single character (newline):

```javascript
const walker = document.createTreeWalker(
  this.editor,
  NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  {
    acceptNode: (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return NodeFilter.FILTER_ACCEPT;
      }
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  },
  false
);
```

## Testing

To verify the fix:

1. Open the FlightPath extension (F5 in VS Code)
2. Open the dashboard
3. Click in the prompt editor
4. Type some text, then press Enter multiple times to create several blank lines
5. Continue typing after the blank lines
6. Wait for spell check to run (300ms debounce)
7. **Expected**: Cursor stays in place, blank lines are preserved
8. **Previously**: Cursor would jump, blank lines would collapse

## Files Modified

- `src/ui/webview/prompt-editor.js`
  - `escapeHTML()` method
  - `restoreCursorOffset()` method
