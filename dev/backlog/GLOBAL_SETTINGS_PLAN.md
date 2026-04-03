# Global Settings Plan

Create a first-class **global settings surface** for FlightPath so global configuration is no longer tied to the legacy `SettingsDrawer` footer or to VS Code settings alone. This plan should land before final server-button placement, because the hosted/standalone server controls belong to the global settings architecture, not to the workflow-properties surface.

---

## Background

Today the UI mixes two different concepts:

- `SettingsDrawer` is effectively a **workflow properties** panel
- its footer still exposes **global settings** and a VS Code-only "Settings..." entrypoint

That split is manageable inside VS Code, but it becomes awkward for the standalone server:

- there is no VS Code settings window to open
- server settings such as port, URL, theme behavior, and future TLS options are global/app-level concerns
- `src/utils/ConfigurationUtils.ts` centralizes dozens of global settings, but its backing store is still `vscode.workspace.getConfiguration("flightpath")`

The right long-term direction is to:

1. treat workflow properties and global settings as separate UX surfaces,
2. introduce a dedicated FlightPath global settings UI,
3. put header-level global actions (Settings, Start/Stop Server) in a stable place,
4. abstract the configuration backend so the same settings model works in VS Code and standalone mode.

---

## Why this should happen before the server button

The hosted-server button placement question is really a settings-architecture question.

- If the server control lives in the `SettingsDrawer` footer, it stays coupled to a workflow-properties component that is already carrying legacy naming and mixed responsibilities.
- If detailed server configuration will eventually live in a global settings page/modal, the Start/Stop Server control should be designed alongside that surface rather than added to the footer and moved again immediately after.
- The header has room for **two global icons** beside Save / Undo / Redo:
  - **Global Settings**
  - **Server Start/Stop**

That keeps workflow-local actions and app-global actions visually separate while still making both highly discoverable.

---

## Current Settings Inventory (`ConfigurationUtils.ts`)

`src/utils/ConfigurationUtils.ts` is the current source-of-truth inventory for FlightPath global settings. The new settings system must cover these categories:

### 1. General dashboard / editor behavior

- `showCliCommand`
- `showCliOutput`
- `logRawCliOutput`
- `enableDiagnosticLogs`
- `openPromptsInSecondGroup`
- `respectGitignoreForCompletions`
- `confirmDeleteOperations`
- `confirmResetOperations`

### 2. Workflow defaults

- default harness
- default workflow format
- default workflow template
- dynamic queue defaults
- script timeout
- default retry settings
- prior context default
- resume existing session default
- auto-load recent session

### 3. Harness and model defaults

- Copilot CLI model
- Copilot Chat model
- Claude CLI model
- Codex CLI model
- OpenCode CLI model
- Qwen CLI model
- Gemini CLI model
- per-harness additional args

### 4. Execution and permissions

- execution mode
- close terminal on completion
- max prompt execution time
- Copilot/Codex allowed dirs
- allow-all-paths
- CLI tool permission mode
- allowed / denied tools
- Codex sandbox mode
- Codex approval policy

### 5. Chat / agent behavior

- chat window location
- chat inactivity timeout
- treat chat timeout as success
- default agent
- default skills
- force agent mode for chat
- use native attachments
- omit agents/skills on resume

### 6. MCP / hooks / history

- default MCP servers
- default hooks
- save output history
- max history runs

### 7. Missing global settings that this plan should add

- hosted server enabled/disabled state
- hosted server port
- hosted server URL display metadata
- standalone server port
- standalone theme preference / theme mode behavior
- future HTTPS/TLS settings if supported later

---

## Goals

- Replace the legacy "footer settings button opens VS Code settings" path with a real FlightPath settings experience.
- Rename the mental model: `SettingsDrawer` should become **WorkflowProperties** over time.
- Introduce a dedicated **Global Settings** surface that works in both VS Code and standalone/server contexts.
- Separate **configuration model** from **configuration backend** so the UI does not care whether settings come from VS Code or a config file.
- Make server controls a natural part of global settings rather than a one-off button placement hack.
- Keep workflow-level overrides and global defaults clearly distinct.

## Non-Goals

- Rebuilding all workflow-properties UI in the same change
- Eliminating `ConfigurationUtils` immediately in one pass
- Designing multi-user/team-shared config for standalone mode
- Implementing HTTPS/TLS now (only reserve configuration space for it)

---

## Architecture Direction

### 1. Split "workflow properties" from "global settings"

Treat these as separate surfaces:

- **Workflow Properties**: per-workflow and per-prompt behavior
- **Global Settings**: app-wide defaults and environment/server settings

This means:

- the current `SettingsDrawer` should be conceptually renamed to `WorkflowProperties`
- global toggles should gradually move out of its footer
- the existing footer should eventually become workflow-only or disappear entirely

### 2. Add a dedicated global settings UI shell

Introduce a new top-level FlightPath settings surface opened from the header.

Recommended UX:

- add a **Global Settings** icon button beside Save / Undo / Redo in `Header.tsx`
- open a large drawer or modal with section/page navigation
- support the same shell in VS Code and standalone mode

Recommended sections:

1. **General**
2. **Workflow Defaults**
3. **Harnesses & Models**
4. **Permissions**
5. **Chat**
6. **MCP & Hooks**
7. **History & Safety**
8. **Server**

### 3. Introduce a backend-agnostic config service

Create an abstraction layer between UI/business logic and the actual config store.

Example shape:

```ts
interface FlightPathConfigStore {
  get<T>(key: string, defaultValue?: T): T | undefined;
  set<T>(key: string, value: T | undefined): Promise<void>;
  getAll(): FlightPathGlobalSettings;
  subscribe(listener: () => void): () => void;
}
```

Backends:

- **VS Code config backend**: wraps `vscode.workspace.getConfiguration("flightpath")`
- **Standalone config backend**: wraps a real FlightPath config file

`ConfigurationUtils` can then become:

- a compatibility layer over the new config service, or
- a narrower adapter used only in VS Code-specific code until migration finishes

### 4. Add a real standalone config file

For standalone mode, use a dedicated FlightPath-owned config file rather than depending on VS Code settings.

Recommended direction:

- global config file in a user-scoped location
- JSON first for simplicity
- optional future export/import from VS Code settings

The exact path can be finalized during implementation, but the architecture should assume:

- one primary global config file for standalone mode
- the same logical keys as the global settings UI

### 5. Make server controls part of the global settings model

The server feature should use two layers:

- **Quick action in header**: Start/Stop Server
- **Detailed configuration in Global Settings > Server**:
  - port
  - open-in-browser / copy URL affordances
  - theme behavior
  - future HTTPS/TLS options

This avoids overloading the header button while still making the feature easy to start.

---

## Proposed UI Decision

### Short-term decision

Do **not** finalize the hosted-server button in the `SettingsDrawer` footer.

### Target state

- `Header.tsx`
  - keep Save / Undo / Redo
  - add **Global Settings**
  - add **Start/Stop Server**
- workflow run controls remain on the right side
- detailed server configuration lives inside Global Settings, not next to workflow properties

### Naming cleanup

As follow-up work, rename the legacy settings UI so the code matches the product language:

- `SettingsDrawer` -> `WorkflowPropertiesDrawer` (or similar)
- visible UI label: **Workflow Properties**

This rename does not need to block the new global settings UI, but the plan should assume it will happen.

---

## Implementation Plan

### Phase 1 — Define the shared global settings model

1. Inventory every setting currently surfaced by `ConfigurationUtils.ts`.
2. Normalize those keys into a typed `FlightPathGlobalSettings` model.
3. Separate:
   - global/app settings,
   - workflow-default settings,
   - server settings,
   - backend-specific implementation details.
4. Decide which legacy keys remain as-is for backward compatibility and which need aliasing/migration.

### Phase 2 — Add a config backend abstraction

1. Introduce a config service/store interface shared by VS Code and standalone.
2. Implement a VS Code-backed adapter using current settings storage.
3. Refactor the webview/settings sync layer to read from that abstraction instead of reaching into `vscode.workspace` directly where possible.
4. Keep `ConfigurationUtils` as a transition adapter until all callers are migrated.

### Phase 3 — Build the Global Settings UI

1. Add a new header button to open Global Settings.
2. Create a dedicated large settings drawer/modal/page shell.
3. Build sections from the typed settings model.
4. Reuse existing controls where possible (`CustomSelect`, toggles, editors, MCP/hook editors).
5. Show clearly which values are global defaults vs workflow overrides.

### Phase 4 — Detangle the current footer

1. Remove or relocate the global toggles from the workflow-properties footer.
2. Decide whether small global quick toggles remain anywhere outside Global Settings.
3. Keep the workflow-properties surface focused on workflow-scoped concerns only.
4. Rename the component/files from `SettingsDrawer` to `WorkflowProperties*`.

### Phase 5 — Add the Server section

1. Add server settings to the typed global settings model.
2. Add **Server** page/section in Global Settings.
3. Put detailed fields there:
   - enabled/running status
   - port
   - displayed URL
   - browser-launch action
   - future HTTPS/TLS placeholders if needed
4. Add the header Start/Stop Server button only after this settings architecture is in place.

### Phase 6 — Standalone backend

1. Implement the standalone config-file backend.
2. Reuse the same settings model and UI.
3. Ensure standalone server reads/writes the same logical settings without any VS Code dependency.

---

## Relationship to Existing Work

### Unblocks / clarifies

- `STANDALONE_SERVER_PLAN.md`
- hosted server button placement
- standalone server configuration model
- `WebviewSettingsSync` cleanup
- eventual removal of direct `vscode.workspace` assumptions from settings-related code

### Depends on

- the shared hosted-router foundation that is already in place

### Should happen before

- finalizing server button placement in the footer
- building a dedicated standalone settings page ad hoc

---

## Recommended Follow-Up Order

1. Land this global settings architecture plan.
2. Implement the typed global settings model + backend abstraction.
3. Build the new Global Settings UI shell.
4. Move server configuration into that surface.
5. Add header-level Start/Stop Server and circle back to the hosted server implementation.

---

## Notes

- `ConfigurationUtils.ts` should be treated as the migration inventory, not the final architecture.
- The current footer settings button is a temporary VS Code convenience, not the long-term product shape.
- Server controls are global application controls, not workflow controls, so they should evolve with the global settings UX rather than with the workflow-properties drawer.
