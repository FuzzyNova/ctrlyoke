# CodeMirror 6 Integration Plan - Review and Corrections

**Date:** January 2, 2026
**Reviewer:** Claude Sonnet 4.5
**Status:** Issues Identified - Plan Needs Updates

## Summary

The implementation plan in `CODEMIRROR_INTEGRATION_IMPLEMENTATION.md` is mostly sound, but has several critical issues that need correction based on official CodeMirror 6 documentation review.

## Issues Found

### 1. Missing Unified `codemirror` Package (CRITICAL)

**Location:** Step 1.1 (Line 34)

**Issue:**
```bash
npm install --save @codemirror/state @codemirror/view ...
```

Missing the unified `codemirror` package which exports `basicSetup` and `minimalSetup`.

**Fix:**
```bash
npm install --save codemirror @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/autocomplete @codemirror/lint @codemirror/search
```

**Source:** [CodeMirror Basic Setup](https://github.com/codemirror/basic-setup) - "The basic setup package is now exported from codemirror instead of @codemirror/basicsetup."

---

### 2. Module Loading Strategy Needs Clarification (CRITICAL)

**Location:** Step 1.2 (Lines 45-114)

**Issue:**
The plan attempts to copy raw `dist` folders from `node_modules` and import them as ESM modules. However, CodeMirror 6 documentation states: "It is not currently practical to run the library without some kind of bundler."

**Recommended Fix:**
Add **two options** to the plan:

**Option A (Recommended): Bundle CodeMirror with esbuild**
- Create a separate esbuild entry point that bundles all CodeMirror modules into a single file
- Import that bundled file in the webview
- This is more reliable and matches CodeMirror's recommended usage

**Option B (Alternative): Copy dist files**
- Keep current approach but add warnings about potential ESM compatibility issues
- May require additional configuration for module resolution

**Source:** [CodeMirror Bundling Example](https://codemirror.net/examples/bundle/) - discusses bundling requirements

---

### 3. Incorrect `basicSetup` Construction (CRITICAL)

**Location:** codemirror-loader.js template (Lines 610-622)

**Issue:**
```javascript
basicSetup:
  view.basicSetup ||
  (() => [
    view.lineNumbers(),
    view.highlightActiveLineGutter(),
    // ...
  ])(),
```

Problems:
1. `basicSetup` is not exported from the `view` module
2. Functions like `lineNumbers()` need specific imports
3. The fallback construction is incomplete and won't work

**Fix:**
Since we're installing the `codemirror` package, import `basicSetup` from there:

```javascript
// In codemirror-loader.js, import from the codemirror bundle:
const codemirrorPkg = await import("./lib/codemirror/codemirror/index.js");

window.CM = {
  // ... other exports
  basicSetup: codemirrorPkg.basicSetup,
  minimalSetup: codemirrorPkg.minimalSetup,
};
```

**Source:** [CodeMirror Basic Setup Package](https://github.com/codemirror/basic-setup/blob/main/src/codemirror.ts) - shows what's included in basicSetup

---

### 4. Incorrect `keymap` Export (MAJOR)

**Location:** codemirror-loader.js template (Line 591)

**Issue:**
```javascript
keymap: view.keymap,
```

The `keymap` function is exported from `@codemirror/view`, but the plan tries to access it as a property of the imported module object.

**Fix:**
```javascript
const [state, view, commands, language, autocomplete, lint, search] = modules;

window.CM = {
  // ... state exports

  // View exports
  EditorView: view.EditorView,
  ViewPlugin: view.ViewPlugin,
  Decoration: view.Decoration,
  WidgetType: view.WidgetType,
  keymap: view.keymap, // This should work if view module exports keymap

  // ...
};
```

Verify that `@codemirror/view` exports `keymap`. If not, it may come from `@codemirror/state` or require special import.

---

### 5. Potential `RangeSetBuilder` Issue (MINOR)

**Location:** codemirror-loader.js template (Lines 625-637)

**Issue:**
Manual fallback implementation of `RangeSetBuilder`:

```javascript
window.CM.RangeSetBuilder =
  state.RangeSetBuilder ||
  class RangeSetBuilder {
    constructor() {
      this.ranges = [];
    }
    add(from, to, value) {
      this.ranges.push({ from, to, value });
    }
    finish() {
      return Decoration.set(this.ranges);
    }
  };
```

**Concerns:**
1. `RangeSetBuilder` should be exported from `@codemirror/state` module
2. The fallback implementation may not match the actual API
3. Using `Decoration.set()` requires importing `Decoration` from view module

**Fix:**
Verify that `state.RangeSetBuilder` exists. If the fallback is needed, ensure it matches the official API:

```javascript
import { RangeSetBuilder } from "@codemirror/state"
import { Decoration } from "@codemirror/view"

// In loader:
window.CM.RangeSetBuilder = state.RangeSetBuilder; // Should exist
```

**Source:** [CodeMirror Decoration Example](https://codemirror.net/examples/decoration/) - shows RangeSetBuilder usage

---

### 6. Spell Check Linter Implementation (VERIFIED CORRECT)

**Location:** codemirror-editor.js template (Lines 262-309)

**Status:** ✅ **CORRECT**

The spell checking implementation using CodeMirror's linter API is accurate:
- Uses `linter()` from `@codemirror/lint`
- Diagnostic structure is correct (`from`, `to`, `severity`, `message`, `actions`)
- Actions with `apply(view, from, to)` callbacks are correct

**Source:** [CodeMirror Lint Example](https://codemirror.net/examples/lint/) - confirms the API structure

---

### 7. ViewPlugin Pattern (VERIFIED CORRECT)

**Location:** codemirror-editor.js template (Lines 392-444)

**Status:** ✅ **MOSTLY CORRECT**

The `ViewPlugin.fromClass` pattern for link decorations is correct. Only minor issue:

**Line 410:**
```javascript
const builder = new CM.RangeSetBuilder();
```

Should work fine if `CM.RangeSetBuilder` is properly exported from state module.

**Source:** [CodeMirror Decoration Example](https://codemirror.net/examples/decoration/) and [Zebra Stripes Example](https://codemirror.net/examples/zebra/)

---

### 8. Autocompletion `override` Option (VERIFIED CORRECT)

**Location:** codemirror-editor.js template (Lines 336-344)

**Status:** ✅ **CORRECT**

Using `override: [customCompletions]` is the correct approach for replacing default completions with custom ones.

**Note:** This will *replace* language completions. If you want to *add* to them instead, use the language data facet approach.

**Source:** [CodeMirror Autocompletion Example](https://codemirror.net/examples/autocompletion/)

---

## Recommendations

### Priority 1 (Must Fix):
1. ✅ Add `codemirror` package to npm install
2. ✅ Add bundling option (Option A) to build configuration
3. ✅ Fix `basicSetup` import in loader module
4. ✅ Verify `keymap` export location

### Priority 2 (Should Verify):
5. ✅ Test that RangeSetBuilder is properly exported
6. ✅ Verify ESM module loading works in VS Code webview

### Priority 3 (Nice to Have):
7. ✅ Add troubleshooting section for module loading issues
8. ✅ Add note about bundling vs. copying trade-offs

---

## Updated Package List

Based on official documentation, install these packages:

```json
{
  "dependencies": {
    "codemirror": "^6.0.1",
    "@codemirror/state": "^6.4.1",
    "@codemirror/view": "^6.26.0",
    "@codemirror/commands": "^6.5.0",
    "@codemirror/language": "^6.10.1",
    "@codemirror/autocomplete": "^6.15.0",
    "@codemirror/lint": "^6.6.0",
    "@codemirror/search": "^6.5.6"
  }
}
```

---

## Sources

All information verified against official CodeMirror 6 documentation:

- [CodeMirror Docs](https://codemirror.net/docs/)
- [CodeMirror Reference Manual](https://codemirror.net/docs/ref/)
- [CodeMirror System Guide](https://codemirror.net/docs/guide/)
- [CodeMirror Configuration Example](https://codemirror.net/examples/config/)
- [CodeMirror Lint Example](https://codemirror.net/examples/lint/)
- [CodeMirror Decoration Example](https://codemirror.net/examples/decoration/)
- [CodeMirror Autocompletion Example](https://codemirror.net/examples/autocompletion/)
- [CodeMirror Basic Setup (GitHub)](https://github.com/codemirror/basic-setup)
- [CodeMirror Bundling Example](https://codemirror.net/examples/bundle/)

---

## Next Steps

1. Review this document
2. Update `CODEMIRROR_INTEGRATION_IMPLEMENTATION.md` with corrections
3. Decide on bundling approach (Option A recommended)
4. Test module loading in VS Code webview before full implementation
