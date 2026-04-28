# Color Audit Plan

## Executive Summary

After auditing all color usage across `src/ui/webview-react/`, the verdict is:
**tailwind.config.js is the right single source of truth — but it has gaps, and several components bypass it.**
The CodeMirror JS theme and certain inline styles (boxShadow, color-mix overlays, canvas) are _legitimately_ outside Tailwind and should stay that way. Everything else should route through named tokens.

Three categories of work:

1. **Bug fixes** — undefined class names that silently produce no styling
2. **Missing tokens** — VS Code variables used directly in components that belong in tailwind.config.js
3. **Hardcoded palette** — Tailwind default colors (green-400, amber-400, blue-600, etc.) that should use semantic tokens

---

## What is Correctly Structured (Do Not Change)

### CodeMirrorEditor.tsx — JS theme object

CodeMirror's theming API takes a JavaScript style object, not CSS class strings.
Tailwind cannot reach inside `EditorView.theme({...})`. These ~40 `--vscode-*` references are appropriate and not duplicatable via Tailwind tokens. No action needed.

### OutputMinimap.tsx — canvas inline styles

The minimap renders to a `<canvas>`. Colors are read from inline JS variables and drawn via the Canvas 2D API. Tailwind classes cannot help here. The VS Code variables used (`--vscode-minimapGutter-*`, `--vscode-scrollbarSlider-*`) are correct and appropriate.

### Inline boxShadow / color-mix overlay styles

These cannot be expressed as Tailwind utilities:

- `EditorSection.tsx:216` — `boxShadow: "0 0 0 1px var(--vscode-focusBorder)"`
- `WorkflowStatus.tsx:484` — `boxShadow: "0 0 0 1px var(--vscode-focusBorder)"`
- `StartupOverlay.tsx:41` — `color-mix(in srgb, var(--vscode-editor-background) 70%, transparent)`
- `TerminalControlBar.tsx:169` — `color-mix(in srgb, var(--vscode-terminal-background, ...) 92%, transparent)`

Leave as-is. These are the correct pattern for complex CSS values that Tailwind utilities cannot express.

### globals.css

Well-structured. The comment at the top correctly describes its limited purpose: variables for non-Tailwind contexts only (inline styles, arbitrary value classes for spacing). Do not add VS Code color variables here — tailwind.config.js already covers them.

### TerminalInstance.tsx / PromptEditor.tsx popup

Both use dynamic inline styles for popup/overlay widgets where the colors come from VS Code secondary button/widget variables. These are appropriate as inline styles given the dynamic composition involved.

---

## Work Items

### 1. Bug Fixes — Undefined Class Names (High Priority)

These classes do not exist in Tailwind's default palette OR in tailwind.config.js. They silently produce no styling.

| File                               | Line | Broken Class           | Fix                                               |
| ---------------------------------- | ---- | ---------------------- | ------------------------------------------------- |
| `components/output/BashOutput.tsx` | 146  | `text-vscode-fg`       | → `text-editor-fg`                                |
| `components/output/DiffView.tsx`   | 240  | `border-vscode-border` | → `border` (uses DEFAULT from borderColor config) |
| `components/output/DiffView.tsx`   | 240  | `bg-vscode-bg`         | → `bg-editor-bg`                                  |

**Action**: Fix these three class names directly. No config changes needed — the correct tokens already exist.

---

### 2. Missing Tokens in tailwind.config.js (Medium Priority)

These VS Code variables are used directly in component class strings (via Tailwind's arbitrary value syntax) but have no named token. Add them to tailwind.config.js so callers use a named token instead of an inline var reference.

| Current Usage                                 | File                           | Add Token       | Maps To                                                              |
| --------------------------------------------- | ------------------------------ | --------------- | -------------------------------------------------------------------- |
| `text-[var(--vscode-charts-blue)]`            | `prompts/StatusIcon.tsx:38,43` | `"charts-blue"` | `var(--vscode-charts-blue, #4084d6)`                                 |
| `bg-[var(--vscode-textCodeBlock-background)]` | `output/MarkdownText.tsx:345`  | `"code-block"`  | `var(--vscode-textCodeBlock-background)`                             |
| `bg-[var(--vscode-terminal-background,...)]`  | `output/TerminalView.tsx:219`  | `"terminal-bg"` | `var(--vscode-terminal-background, var(--vscode-editor-background))` |

**Action**: Add three entries to the `colors` block in tailwind.config.js, then update the three call sites to use the named class (`text-charts-blue`, `bg-code-block`, `bg-terminal-bg`).

> Note: The existing `terminal-ansi*` tokens in tailwind.config.js follow the same pattern — this is consistent.

---

### 3. Hardcoded Tailwind Palette Colors (Medium Priority)

These use Tailwind's default numeric palette (green-400, amber-400, blue-600, etc.) instead of semantic tokens. They won't adapt to VS Code themes.

#### 3a. Status Indicator Dots

Five uses of `bg-green-400/500`, `bg-red-400`, `bg-yellow-400` as small indicator dots.
The tokens `bash-status-success`, `bash-status-error`, `bash-status-running` already exist in tailwind.config.js and point to the right VS Code chart colors. The `bash-` prefix is misleading (these aren't bash-specific). **Rename them** and update all call sites.

| Current Token         | Rename To           | VS Code Var                            |
| --------------------- | ------------------- | -------------------------------------- |
| `bash-status-success` | `indicator-success` | `var(--vscode-charts-green, #89d185)`  |
| `bash-status-error`   | `indicator-error`   | `var(--vscode-charts-red, #c24038)`    |
| `bash-status-running` | `indicator-running` | `var(--vscode-charts-yellow, #d19a66)` |

Files to update:

- `components/layout/OutputSection.tsx:1040` — `bg-green-400` → `bg-indicator-success`
- `components/layout/GlobalSettingsVerticalTabBar.tsx:42` — `bg-green-500` → `bg-indicator-success`
- `components/settings/ServerSection.tsx:121` — `bg-green-500` → `bg-indicator-success`
- `components/output/TerminalView.tsx:500` — `bg-green-400` → `bg-indicator-success`
- `components/output/TerminalView.tsx:505` — `bg-red-400` → `bg-indicator-error`
- `components/shared/HarnessDropdown.tsx:64` — `bg-yellow-400` → `bg-indicator-running`
- `components/shared/HarnessDropdown.tsx:65` — `bg-green-500` → `bg-indicator-success`
- `components/shared/HarnessDropdown.tsx:66` — `bg-red-400` → `bg-indicator-error`

Also update the existing `bash-status-*` references in BashOutput and CliOutput (or keep aliases for backward compat within the same file).

#### 3b. WorkflowPropertiesPanel Success Text

- `components/layout/WorkflowPropertiesPanel.tsx:82` — `text-green-500` → `text-indicator-success`

#### 3c. Favorite Star (RecentWorkflows)

Yellow star color. No VS Code theme variable maps to "favorite yellow" — this is intentionally fixed. Add a token:

```js
"favorite": "#e5c014",  // fixed, intentionally theme-independent
```

- `components/workflow/RecentWorkflows.tsx:174,175` — `text-yellow-400 hover:text-yellow-300` → `text-favorite hover:opacity-80`

#### 3d. SettingSourceBadge (Workspace/User Scope Indicators)

These indicate whether a setting comes from workspace or user scope. No VS Code variable maps to this concept — the amber/blue distinction is semantic and intentional.

Add tokens:

```js
"scope-workspace": "#d97706",  // amber-600 equivalent, readable in both themes
"scope-user": "#3b82f6",       // blue-500 equivalent
```

- `components/shared/SettingSourceBadge.tsx:15,16` — replace `text-amber-400 border-amber-400/50 bg-amber-400/10` with `text-scope-workspace border-scope-workspace/50 bg-scope-workspace/10` (and similarly for blue)

> **Why not VS Code vars?** VS Code has no semantic "workspace vs user" color distinction. These are product-level semantic colors, not theme colors. Fixed colors (with Tailwind opacity modifiers) are appropriate.

#### 3e. CLI/Managed Badges (RunningWorkflowItem, WorkflowStatus)

Two "CLI" label badges using raw blue palette values.

Add tokens:

```js
"cli-badge-bg": "#1d4ed8",    // blue-700 equivalent
"cli-badge-fg": "#ffffff",
"cli-managed-bg": "rgba(30,64,175,0.5)",   // blue-800/50
"cli-managed-fg": "#93c5fd",  // blue-300
"cli-managed-border": "rgba(37,99,235,0.4)",  // blue-600/40
```

Or, simpler — these are small badges and the blue conveys "CLI mode". Use `btn-bg` / `btn-fg` (VS Code button colors) since "CLI badge" = an active action indicator:

- Consider using `bg-btn-bg text-btn-fg` which are already in tailwind.config.js and will theme correctly.

**Action**: Discuss with the team whether "CLI" badges should use VS Code button colors (themes correctly) or fixed blue (design intent). Use tokens either way.

#### 3f. MCP Registry Verified Icon

- `components/shared/McpServersEditor.tsx:1454` — `text-blue-400` for a verified checkmark icon

Maps to "verified" / "trusted" concept. Add:

```js
"verified": "var(--vscode-charts-blue, #4084d6)",
```

Then use `text-verified`. This reuses the `charts-blue` token proposed in §2 (could be the same definition).

#### 3g. Description Text

- `components/settings/ServerSection.tsx:164` — `text-gray-500` → `text-description-fg` (already in config)

---

### 4. Collapsible.tsx — Replace gray-\* / dark: classes (Low Priority)

`components/shared/Collapsible.tsx` uses raw gray palette colors with `dark:` prefix:

```
border-gray-200 dark:border-gray-700
hover:bg-gray-50 dark:hover:bg-gray-800
text-gray-900 dark:text-gray-100
text-gray-500
```

**Problem**: Tailwind's `dark:` prefix requires a `dark` class on `<html>`. VS Code applies `vscode-dark` to `<body>`, not `dark` on `<html>`. These dark-mode variants do nothing in the VS Code webview. The component renders the same in light and dark themes.

**Fix**: Replace all gray classes with VS Code semantic tokens:

| Current                                   | Replace With                    |
| ----------------------------------------- | ------------------------------- |
| `border-gray-200 dark:border-gray-700`    | `border` (DEFAULT border token) |
| `hover:bg-gray-50 dark:hover:bg-gray-800` | `hover:bg-list-hover-bg`        |
| `text-gray-900 dark:text-gray-100`        | `text-foreground`               |
| `text-gray-500`                           | `text-description-fg`           |

---

## Implementation Order

| Priority    | Item                                                      | Files Changed                | Risk                                |
| ----------- | --------------------------------------------------------- | ---------------------------- | ----------------------------------- |
| 1 (bug fix) | §1 — Fix undefined class names                            | 2 files                      | Zero — these do nothing currently   |
| 2           | §2 — Add 3 tokens + update call sites                     | tailwind.config.js + 3 files | Low                                 |
| 3           | §3a+3b — Rename bash-status-\* + indicator dots           | tailwind.config.js + 9 files | Low — visual test all themes        |
| 4           | §3g + §4 — description-fg + Collapsible.tsx               | 2 files                      | Low                                 |
| 5           | §3c–3f — Semantic badges (favorite, scope, CLI, verified) | tailwind.config.js + 5 files | Low — discuss CLI badge color first |

---

## Non-Goal: Centralizing CodeMirror Colors

Do **not** extract CodeMirror's VS Code variable strings into a separate `codeMirrorThemeVars.ts` constants file. The variables are:

- Already co-located with the code that uses them
- Not referenced anywhere else in the codebase
- Named clearly enough (`--vscode-editorSuggestWidget-background`) that they self-document

Extracting them adds indirection without reducing duplication (they appear once). This is a case where co-location beats centralization.
