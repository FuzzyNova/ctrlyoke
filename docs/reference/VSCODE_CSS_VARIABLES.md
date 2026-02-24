# VS Code CSS Custom Properties Reference

> **Official source:** https://code.visualstudio.com/api/references/theme-color
>
> VS Code injects all theme colors as CSS custom properties into webview documents. The naming rule is: replace dots with hyphens and prefix with `--vscode-`. For example, `editor.background` → `--vscode-editor-background`.

## How Variables Are Injected

VS Code automatically injects CSS variables into every webview. The full set is driven by the active theme. Variables that a theme does not explicitly define are **not injected** (they return `undefined` / fall back to the CSS fallback value if one is provided).

The VS Code source files that define all registered colors:

- [`colorRegistry.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/colorRegistry.ts) — central registry
- [`baseColors.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/colors/baseColors.ts) — global/base colors
- [`editorColors.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/colors/editorColors.ts) — editor colors
- [`inputColors.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/colors/inputColors.ts) — input/dropdown/button colors
- [`listColors.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/colors/listColors.ts) — list/tree colors

## Always-Present Variables (Not Theme-Dependent)

These come from VS Code editor settings, not themes — always defined:

| Variable                      | Source setting      |
| ----------------------------- | ------------------- |
| `--vscode-editor-font-family` | `editor.fontFamily` |
| `--vscode-editor-font-weight` | `editor.fontWeight` |
| `--vscode-editor-font-size`   | `editor.fontSize`   |

## Naming Convention

| Theme color identifier           | CSS custom property                       |
| -------------------------------- | ----------------------------------------- |
| `editor.background`              | `--vscode-editor-background`              |
| `button.secondaryForeground`     | `--vscode-button-secondaryForeground`     |
| `inputValidation.errorBorder`    | `--vscode-inputValidation-errorBorder`    |
| `list.activeSelectionBackground` | `--vscode-list-activeSelectionBackground` |
| `sideBar.background`             | `--vscode-sideBar-background`             |

Note: the camelCase within a segment is preserved. Only the `.` separator becomes `-`.

## Variables Used in This Project (Tailwind Token Mapping)

These are all `--vscode-*` variables referenced in the FlightPath webview. Each is mapped to a Tailwind token in `tailwind.config.js` — never use them as inline arbitrary values in className strings; use the token.

| CSS Variable                                | Tailwind Token         | Notes                                                                                                                                             |
| ------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--vscode-editor-background`                | `editor-bg`            |                                                                                                                                                   |
| `--vscode-editor-foreground`                | `editor-fg`            |                                                                                                                                                   |
| `--vscode-foreground`                       | `foreground`           | Global text color                                                                                                                                 |
| `--vscode-panel-border`                     | `panel-border`         |                                                                                                                                                   |
| `--vscode-sideBar-background`               | `sidebar-bg`           |                                                                                                                                                   |
| `--vscode-sideBar-dropBackground`           | `sidebar-drop-bg`      |                                                                                                                                                   |
| `--vscode-focusBorder`                      | `focus-border`         | Keyboard focus rings                                                                                                                              |
| `--vscode-widget-border`                    | `widget-border`        | Popups, overlays                                                                                                                                  |
| `--vscode-button-background`                | `btn-bg`               |                                                                                                                                                   |
| `--vscode-button-hoverBackground`           | `btn-hover`            |                                                                                                                                                   |
| `--vscode-button-foreground`                | `btn-fg`               |                                                                                                                                                   |
| `--vscode-button-border`                    | `btn-border`           | Only defined in high-contrast themes (null in Dark+/Light+); fallback is `--vscode-widget-border` which is explicitly set in both standard themes |
| `--vscode-button-secondaryBackground`       | `btn-secondary-bg`     |                                                                                                                                                   |
| `--vscode-button-secondaryHoverBackground`  | `btn-secondary-hover`  |                                                                                                                                                   |
| `--vscode-button-secondaryForeground`       | `btn-secondary-fg`     |                                                                                                                                                   |
| `--vscode-input-background`                 | `input-bg`             |                                                                                                                                                   |
| `--vscode-input-foreground`                 | `input-fg`             |                                                                                                                                                   |
| `--vscode-input-border`                     | `input-border`         |                                                                                                                                                   |
| `--vscode-input-placeholderForeground`      | `input-placeholder`    |                                                                                                                                                   |
| `--vscode-inputValidation-errorBackground`  | `input-error-bg`       |                                                                                                                                                   |
| `--vscode-inputValidation-errorForeground`  | `input-error-fg`       |                                                                                                                                                   |
| `--vscode-inputValidation-errorBorder`      | `input-error-border`   |                                                                                                                                                   |
| `--vscode-list-hoverBackground`             | `list-hover-bg`        |                                                                                                                                                   |
| `--vscode-list-hoverForeground`             | `list-hover-fg`        |                                                                                                                                                   |
| `--vscode-list-activeSelectionBackground`   | `list-active-bg`       |                                                                                                                                                   |
| `--vscode-list-activeSelectionForeground`   | `list-active-fg`       |                                                                                                                                                   |
| `--vscode-list-inactiveSelectionBackground` | `list-inactive-bg`     |                                                                                                                                                   |
| `--vscode-list-focusBackground`             | `list-focus-bg`        |                                                                                                                                                   |
| `--vscode-dropdown-background`              | `dropdown-bg`          |                                                                                                                                                   |
| `--vscode-dropdown-foreground`              | `dropdown-fg`          |                                                                                                                                                   |
| `--vscode-dropdown-border`                  | `dropdown-border`      |                                                                                                                                                   |
| `--vscode-dropdown-listBackground`          | `dropdown-selected-bg` |                                                                                                                                                   |
| `--vscode-descriptionForeground`            | `description-fg`       | Secondary/muted text                                                                                                                              |
| `--vscode-errorForeground`                  | `error-fg`             |                                                                                                                                                   |
| `--vscode-editorWarning-foreground`         | `warning-fg`           |                                                                                                                                                   |
| `--vscode-editorInfo-foreground`            | `info-fg`              |                                                                                                                                                   |
| `--vscode-textLink-foreground`              | `link-fg`              |                                                                                                                                                   |
| `--vscode-textLink-activeForeground`        | `link-active-fg`       |                                                                                                                                                   |
| `--vscode-disabledForeground`               | `disabled-fg`          |                                                                                                                                                   |
| `--vscode-badge-background`                 | `badge-bg`             |                                                                                                                                                   |
| `--vscode-badge-foreground`                 | `badge-fg`             |                                                                                                                                                   |
| `--vscode-toolbar-hoverBackground`          | `toolbar-hover-bg`     |                                                                                                                                                   |
| `--vscode-commandCenter-background`         | `cmd-bg`               |                                                                                                                                                   |
| `--vscode-commandCenter-foreground`         | `cmd-fg`               |                                                                                                                                                   |
| `--vscode-commandCenter-activeBackground`   | `cmd-active-bg`        |                                                                                                                                                   |
| `--vscode-commandCenter-activeForeground`   | `cmd-active-fg`        |                                                                                                                                                   |
| `--vscode-commandCenter-inactiveForeground` | `cmd-inactive-fg`      |                                                                                                                                                   |
| `--vscode-commandCenter-border`             | `cmd-border`           | Defaults to `contrastBorder` (null in standard themes); fallback is `--vscode-widget-border`                                                      |
| `--vscode-commandCenter-activeBorder`       | `cmd-active-border`    | Fallback is `--vscode-focusBorder`                                                                                                                |
| `--vscode-commandCenter-inactiveBorder`     | `cmd-inactive-border`  | Fallback is `--vscode-widget-border`                                                                                                              |
| `--vscode-keybindingLabel-background`       | `keybinding-bg`        | Fallback: `rgba(128,128,128,0.17)`                                                                                                                |
| `--vscode-notificationsInfoIcon-foreground` | `notification-info-fg` |                                                                                                                                                   |
| `--vscode-charts-green`                     | `bash-status-success`  | Also used for live-run indicators                                                                                                                 |
| `--vscode-charts-red`                       | `bash-status-error`    |                                                                                                                                                   |
| `--vscode-charts-yellow`                    | `bash-status-running`  |                                                                                                                                                   |

### Variables Used Directly (Not Tokenized)

These appear in `CodeMirrorEditor.tsx` inside the `EditorView.theme({...})` call (CodeMirror CSS-in-JS — cannot use Tailwind) or in `style={{}}` props:

| Variable                                  | Location         | Reason not tokenized         |
| ----------------------------------------- | ---------------- | ---------------------------- |
| `--vscode-editorCursor-foreground`        | CodeMirrorEditor | Theme object only            |
| `--vscode-editor-selectionBackground`     | CodeMirrorEditor | Theme object only            |
| `--vscode-editor-lineHighlightBackground` | CodeMirrorEditor | Theme object only            |
| `--vscode-editorGutter-background`        | CodeMirrorEditor | Theme object only            |
| `--vscode-editorLineNumber-foreground`    | CodeMirrorEditor | Theme object only            |
| `--vscode-editorSuggestWidget-*`          | CodeMirrorEditor | Theme object only            |
| `--vscode-symbolIcon-*`                   | CodeMirrorEditor | Theme object only            |
| `--vscode-textCodeBlock-background`       | MarkdownText     | No semantic token equivalent |
| `--vscode-charts-blue`                    | StatusIcon       | No semantic token equivalent |

## Variable Availability by Theme

Most VS Code themes define the common variables listed above. Variables that are **frequently undefined** in minimal or third-party themes:

- `--vscode-button-border` — **always null in Dark+ and Light+**; only defined in high-contrast themes (via `contrastBorder`). The `btn-border` token falls back to `--vscode-widget-border` which is always present.
- `--vscode-list-hoverForeground` — some themes rely on contrast with hover background instead
- `--vscode-toolbar-hoverBackground` — not defined in all themes
- `--vscode-widget-border` — may be undefined in flat themes
- `--vscode-dropdown-selectedBackground` — newer addition, not in all themes
- `--vscode-notificationsInfoIcon-foreground` — may be undefined
- `--vscode-charts-*` — only defined in themes that explicitly support chart colors

When a variable is undefined, VS Code omits it from the injected CSS entirely (does not inject `--vscode-foo: ;`). Always provide a meaningful fallback in the token definition where the missing variable would break layout or readability.

## Full Variable Reference

The complete list of 400+ available theme color identifiers is at:
https://code.visualstudio.com/api/references/theme-color

To convert any identifier to its CSS variable name: replace `.` with `-` and prepend `--vscode-`.
