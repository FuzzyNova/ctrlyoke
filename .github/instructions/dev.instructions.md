---
applyTo: "src/dev/**"
---

<purpose>
Development-only commands and diagnostics registered exclusively when `IS_DEV_MODE = true`. The `src/dev/` directory contains a single module (`DevCommands.ts`) that provides tooling for investigating VS Code APIs, discovering Copilot models, debugging chat/CLI integrations, and generating reference artifacts. In production builds, esbuild's dead code elimination strips this code entirely — it is never shipped.
</purpose>

<architecture>
**Conditional registration** in `src/extension.ts`:

```typescript
import { IS_DEV_MODE } from "./utils/BuildConfig";

if (IS_DEV_MODE) {
  const { registerDevCommands } = require("./dev/DevCommands");
  registerDevCommands(context);
}
```

**IS_DEV_MODE** (`src/utils/BuildConfig.ts`): A build-time boolean replaced by esbuild via the `define` option.

- `npm run compile` → `__DEV_MODE__ = true` (dev build)
- `npm run build:prod` → `__DEV_MODE__ = false` (production build, dead code eliminated)
- Defaults to `true` if `__DEV_MODE__` is somehow undefined at runtime (safe for F5 debugging).

**Single palette entry point**: `flightpath.devMenu` is the only dev command declared in `package.json` (with `"when": "flightpath.devMode"`). It shows a QuickPick that dispatches to all other dev commands. Individual commands are registered programmatically at runtime only.

**`flightpath.devMode` context key** is set via `setContext` inside `registerDevCommands`, which makes the `devMenu` command visible in the palette.

**All commands** are registered with `context.subscriptions.push(...)` so they are properly disposed when the extension deactivates.
</architecture>

<devCommands>
| Command ID | Palette Visible | Purpose |
|---|---|---|
| `flightpath.devMenu` | ✅ (when `flightpath.devMode`) | QuickPick hub dispatching to all other dev tools. The only dev command in `package.json`. |
| `flightpath.test.copilotAutomation` | via devMenu | Legacy POC: opens Copilot Chat and sends a test message via `workbench.action.chat.submit` to verify chat automation feasibility. |
| `flightpath.test.fileAttachment` | via devMenu | Tests `github.copilot.chat.attachFile` and `github.copilot.chat.attachSelection` commands step-by-step, logging results to the Output channel. |
| `flightpath.test.chatModelSelection` | via devMenu | Iterates over known model IDs and calls `workbench.action.chat.changeModel` for each, logging success/failure to confirm which models can be switched programmatically. |
| `flightpath.test.chatAgentSelection` | via devMenu | Tests various agent-selection commands (`workbench.action.chat.openagent`, `workbench.action.chat.assignSelectedAgent`, etc.) with different parameter formats to determine programmability. |
| `flightpath.listChatCommands` | via devMenu | Filters all registered VS Code commands to those containing `copilot`, `copilot-chat`, `workbench.action.chat`, or `github.copilot`; saves the result to `docs/reference/CHAT_COMMANDS.md`. |
| `flightpath.listAllCommands` | via devMenu | Dumps all registered VS Code commands to `docs/reference/VSCODE_COMMANDS.md`. |
| `flightpath.showLanguageId` | via devMenu | Displays the language ID and file name of the active editor document in a modal — useful for debugging language detection in completions. |
| `flightpath.exportDiscoveredModels` | via devMenu | Queries `ModelRegistry` for all discovered Copilot models and writes `scripts/discovered-models.json`. Used in the model-update workflow before running `npm run sync-models`. |
| `flightpath.dumpCssVars` | via devMenu | Opens a temporary WebviewPanel, reads all `--vscode-*` CSS custom properties from `getComputedStyle`, and writes them to `docs/reference/vscode-css-vars.json` — useful for theming and webview styling work. |
</devCommands>

<modelUpdateWorkflow>
The `flightpath.exportDiscoveredModels` command is part of a repeatable workflow for keeping model lists in sync:

1. Run extension (`F5`)
2. Run command: **FlightPath: Export Discovered Models** → writes `scripts/discovered-models.json`
3. `npm run sync-models -- --import` → updates `src/utils/ModelConstants.ts`
4. `npm run sync-models` → syncs `package.json` enums AND `schemas/prompt-schema.json` examples
5. `npm run generate-schema` → regenerates YAML schema from JSON
6. Commit all updated files

This flow ensures `ModelConstants.ts`, `package.json`, and `prompt-schema.json` remain a consistent single source of truth.
</modelUpdateWorkflow>

<conventions>
- **No production registration**: Never register dev commands outside the `IS_DEV_MODE` guard. They must not appear in the production command palette.
- **Only `devMenu` in package.json**: `flightpath.devMenu` is the sole dev command declared under `contributes.commands`. All other dev commands are registered at runtime only and never appear directly in the palette.
- **Output channel for results**: Use `Log.info()` / `Log.error()` for all diagnostic output so results appear in the FlightPath Output channel.
- **context.subscriptions**: Always push disposables to `context.subscriptions` in `registerDevCommands`.
- **Dynamic imports for test utilities**: Test-only modules are imported dynamically inside command handlers to avoid pulling them into the main bundle even when `IS_DEV_MODE = true`.
- **Self-contained file**: All dev command logic lives in `DevCommands.ts`. Do not split dev commands across multiple files or import dev utilities from production code paths.
</conventions>
