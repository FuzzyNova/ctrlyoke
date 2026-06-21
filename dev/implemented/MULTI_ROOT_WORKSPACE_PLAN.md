# Multi-Root Workspace Support

> **Status:** ✅ Implemented.
>
> - Native `flightpath.workspaceDirectory` setting added (`package.json`, window scope).
> - Pure `WorkspaceRootResolver` (`src/platform/WorkspaceRootResolver.ts`) implements the
>   resolution order; `VsCodeWorkspaceRoot.ts` binds it to live `vscode.workspace` state and
>   exposes `getVsCodeWorkspaceRoot()` / `getVsCodeWorkspaceFolder()`.
> - Every production `workspaceFolders[0]` read now routes through the resolver
>   (`extension.ts`, `WorkflowOrchestrator`, `WorkflowSerializer`, `WebviewSettingsSync`,
>   `WebviewMessageRouter`, `ScmCommitCommand`, completions, `AttachmentBuilders`, `Log`,
>   `DevCommands`, `CopilotChatIntegration`, `TemplateManager`).
> - `onDidChangeWorkspaceFolders` listener offers a "Reload Window" prompt when the resolved
>   root changes; no-ops otherwise.
> - Resolver unit tests in `src/test/unit/WorkspaceRootResolver.test.ts`.
>
> **Pre-release note:** No backward-compatibility constraints. We can change defaults,
> add settings, and refactor path resolution freely without migration shims.

---

## Is This Worth Building?

**Yes.** Today FlightPath silently assumes a single workspace folder. Every place that
needs the workspace root reads `vscode.workspace.workspaceFolders?.[0]` (~12 call sites)
and the `.flightpath` directory is always rooted at folder `[0]`. In a multi-root
workspace (a `.code-workspace` file with several folders) this means:

- `.flightpath` lands in whichever folder happens to be first — often surprising.
- Settings, history, queue, temp, and capabilities all live under folder `[0]` regardless
  of where the user thinks "the project" is.
- There is **no** `onDidChangeWorkspaceFolders` listener, so adding/removing a folder at
  runtime leaves stale state.

The fix is small and self-contained: make the `.flightpath` location a single, explicitly
resolved, window-stable path, configurable for `.code-workspace` users, and route every
consumer through one resolver.

---

## Core Model: One Shared `.flightpath` Per Workspace

FlightPath is a **single-orchestrator, multi-instance** extension:

- It runs **multiple workflows in parallel** — `WorkflowOrchestrator` holds an
  `instances: Map<string, WorkflowInstance>` and `executeWorkflow()` does not block
  concurrent runs (it only warns when starting a second Copilot **Chat** workflow).
- Each `WorkflowInstance` owns its **own** `PromptQueue` and working file
  (`<name>.flightpath.json`).

What is **shared** across all parallel instances is the **`.flightpath` directory**, not a
queue. A single instance each of `OutputHistoryManager`, the settings backend,
`WorkspaceSessionManager`, `TempFileManager`, the search index, and `capabilities.json`
all point at one root. Parallel workflows are namespaced by **filename** inside the shared
`.flightpath/.queue/`, not by separate directories.

**Decision: one shared `.flightpath` per workspace.** Active-file scoping is explicitly
rejected (see below). Per-workflow `.flightpath` locations are a deliberate **non-goal**
for this plan (see "Out of Scope").

### Why not active-file scoping?

Scoping the `.flightpath` location to the active editor breaks down immediately:

- **Init prompt thrash** — `WorkspaceInitializer.isInitialized()` would flip true/false as
  the user clicks between tabs in different roots, firing the "Initialize FlightPath"
  prompt (`extension.ts:319-363`) repeatedly.
- **Split editors are ambiguous** — with two files visible there is no single "active"
  editor; `window.activeTextEditor` is just whichever was last focused.
- **Mid-session teardown** — the location feeds a single `OutputHistoryManager`, settings
  backend, and session scanner. Changing it mid-session would mean tearing down and
  rebuilding that stack while workflows are running.

The location must be **stable for the whole window session**. Active-file scoping may later
be used only for resolving `@file` references *inside* a prompt (via
`workspace.getWorkspaceFolder(uri)`), never for the `.flightpath` location.

---

## Resolution Order

The `.flightpath` root resolves once per window, in this order:

```
1. flightpath.workspaceDirectory   (native VS Code setting, if set)
       → absolute path used as-is; relative path resolved against the
         .code-workspace file dir (if any), else workspaceFolders[0]
2. dirname(workspace.workspaceFile)  when workspaceFile?.scheme === "file"
3. workspaceFolders[0].uri.fsPath    single-folder case (today's behavior)
4. process.cwd()                     CLI / no folder open (today's fallback)
```

This matches the agreed fallback: **`.code-workspace` file dir when one exists, else
`workspaceFolders[0]`**, with an explicit override on top.

### `.code-workspace` gotchas (verified against the VS Code API)

- **`workspace.workspaceFile`** is `undefined` for a single open folder and has an
  **`untitled:` scheme** for an unsaved multi-root workspace (folders added but never saved
  to a `.code-workspace` file). Only `scheme === "file"` yields an on-disk directory — guard
  step 2 accordingly and fall through to step 3 otherwise.
- **Setting scope must be `window`** (the default), **not** `resource`. A window-scoped
  setting is what a `.code-workspace` file's `settings` block can define for the whole
  workspace. A resource-scoped setting reintroduces per-folder overrides — the exact
  ambiguity we are eliminating.
- **No automatic `${workspaceFolder}` expansion.** VS Code only expands variables in
  `launch.json`/`tasks.json`, not arbitrary string settings. Either expand `${workspaceFolder}`
  ourselves or document that the setting takes an absolute path or a path relative to the
  workspace file. Recommendation: support `${workspaceFolder}` and `${workspaceFolder:Name}`
  expansion ourselves for ergonomics, otherwise treat as a path.

---

## Why the Setting Must Be Native (Not in `FlightPathSettings.ts`)

There is a **chicken-and-egg** constraint: the location of `.flightpath` cannot live inside
`.flightpath/settings.json`, because we need the location to find that file.
`extension.ts:297-305` wires up the file-config backend *using* the workspace root.

So the location setting is **bootstrap config** and must be a genuine VS Code setting read
via `vscode.workspace.getConfiguration("flightpath")` — **re-introducing** a
`contributes.configuration` block (currently `package.json` has none; everything was moved
to the file-based config). The layering becomes:

| Layer | Stores | Read via |
| --- | --- | --- |
| Native VS Code setting | **where** `.flightpath` lives | `vscode.workspace.getConfiguration` |
| `.flightpath/settings.json` (`FlightPathSettings.ts`) | **behavior** once located | `FlightPathConfigService` (unchanged) |

The CLI binary does **not** need the VS Code setting — it already has the equivalent escape
hatch via `ResolvedCliConfig.cwd` (`--cwd`), so `CliAdapter.getWorkspaceRoot()` stays
`config.cwd ?? process.cwd()`.

### CLI / VS Code separation (must hold)

Multi-root is a VS Code-only concept — the CLI always runs in a single directory. So the
resolution layers split cleanly:

- **`WorkspaceRootResolver.ts`** is a **pure** function with **no `vscode` import** — safe to
  bundle anywhere.
- **`VsCodeWorkspaceRoot.ts`** (`getVsCodeWorkspaceRoot` / `getVsCodeWorkspaceFolder`) is the
  **VS Code-only** binding. It must only be imported by VS Code-only modules. Verified: it
  appears in `out/extension.js` but is **absent from `out/cli.js`**.
- **The CLI never calls the resolver or the binding.** CLI code paths get the workspace root
  exclusively from `CliAdapter.getWorkspaceRoot()` (`config.cwd ?? process.cwd()`), honoring
  `--cwd`.

Two shared modules that *are* bundled into the CLI (`Log`, `AttachmentBuilders`) therefore do
**not** import the binding. Instead they receive the root from their caller:

- `Log.initialize(context, workspaceRoot?)` — the extension entry point passes the resolved
  root; the CLI uses the separate `Log.initializeCli(workingDir)` path.
- `resolveSymbol(symbolRef, workspaceRoot)` — callers pass the root they already hold
  (`ContextExpander.workspaceRoot`, which is `config.cwd` under the CLI and the resolved root
  under VS Code). This also makes the helper purely a function of its inputs.

This guarantees a shared module can never accidentally pull VS Code workspace resolution onto
a CLI code path (which would silently ignore `--cwd` and use `process.cwd()`).

---

## Implementation

### 1. Add the native setting (`package.json`)

Add a `contributes.configuration` block:

```jsonc
"contributes": {
  "configuration": {
    "title": "FlightPath",
    "properties": {
      "flightpath.workspaceDirectory": {
        "type": "string",
        "default": "",
        "scope": "window",
        "markdownDescription": "Directory that contains the `.flightpath` folder for this workspace. Leave empty to auto-detect: the folder of the `.code-workspace` file when one is open, otherwise the first workspace folder. Accepts an absolute path or a path relative to the workspace file. Supports `${workspaceFolder}` and `${workspaceFolder:Name}`."
      }
    }
  }
}
```

> Note: the value is the directory that *contains* `.flightpath` (the workspace root), not
> the `.flightpath` folder itself — consistent with how `workspaceRoot` is used everywhere
> today (`path.join(workspaceRoot, PATH_CONSTANTS.FLIGHTPATH_DIR)`).

### 2. Single-source the resolver (`src/platform/`)

The root must be computed in exactly one place (per the project's DRY / single-source
principle). Today `VsCodeAdapter.getWorkspaceRoot()` (`VsCodeAdapter.ts:13`) hardcodes
`[0]`.

- Add a `WorkspaceRootResolver` helper (new file under `src/platform/` or `src/utils/`)
  implementing the resolution order. Pure function of `{ setting, workspaceFile,
  workspaceFolders }` so it is unit-testable without the `vscode` module.
- `VsCodeAdapter.getWorkspaceRoot()` delegates to it.
- `CliAdapter.getWorkspaceRoot()` unchanged (`config.cwd ?? process.cwd()`).
- Keep the `PlatformAdapter.getWorkspaceRoot()` contract; update its doc comment
  (`PlatformAdapter.ts:9-14`) to describe the new resolution order.

### 3. Migrate the direct `workspaceFolders[0]` call sites

Route every consumer through the resolver / `platform.getWorkspaceRoot()` instead of
reading `vscode.workspace.workspaceFolders?.[0]` directly. Known sites:

- `src/extension.ts` — config backend init (`:298`), workspace init + temp cleanup
  (`:321`, `:350`), `pickWorkflowFile` (`:713`), `openGitChange` fallback (`:854`),
  hosted server root (`:1069`), `initWorkspace` command (`:1049`).
- `src/flightpath/WorkflowOrchestrator.ts` — `currentWorkspaceFolder` (`:134`, `:213`).
- `src/platform/VsCodeAdapter.ts:13`.
- `src/ui/WorkflowSerializer.ts`, `src/ui/WebviewSettingsSync.ts`,
  `src/scm/ScmCommitCommand.ts`, `src/completions/PromptLinkProvider.ts`,
  `src/utils/AttachmentBuilders.ts`, `src/utils/Log.ts`, `src/dev/DevCommands.ts`.

Verification step: grep for `workspaceFolders?.[0]` / `workspaceFolders[0]` and confirm only
the resolver remains.

### 4. React to runtime workspace changes (`extension.ts`)

Add an `onDidChangeWorkspaceFolders` subscription. Because the location is window-stable and
the **first** folder change restarts the extension host (VS Code does not fire the event in
that case), the handler is mostly about non-first folders:

- Re-evaluate the resolved root. If it changed (e.g. the resolver was falling back to
  `[0]` and `[0]` was removed), surface a notification offering **"Reload Window"** rather
  than hot-swapping the orchestrator stack mid-session.
- If the root is unchanged (the common case — a sibling folder was added/removed), no-op.

### 5. Idempotent init unchanged, location-aware

`WorkspaceInitializer` already takes a `workspaceRoot` argument and is location-agnostic —
no change to the class itself. The only change is that its **callers** pass the resolved
root. Initialization remains a single `.flightpath` at the resolved root; no per-folder
init, no per-tab prompts.

### 6. Align with the worktree plan's `FLIGHTPATH_WORKSPACE` concept

`WORKTREE_SUPPORT_PLAN.md` already anticipates a centralized `.flightpath` via a
`FLIGHTPATH_WORKSPACE` env var so working files/logs/history "stay centralized" when a
harness runs in a worktree `cwd`. The resolver introduced here is the natural single source
for that value — when worktree support lands, `FLIGHTPATH_WORKSPACE` should be set from the
resolved root, not from the harness `cwd`.

---

## Files Touched

| File | Change |
| --- | --- |
| `package.json` | Add `contributes.configuration` with `flightpath.workspaceDirectory` (window scope) |
| `src/platform/WorkspaceRootResolver.ts` *(new)* | Pure resolver implementing the order above |
| `src/platform/VsCodeAdapter.ts` | `getWorkspaceRoot()` delegates to resolver |
| `src/platform/PlatformAdapter.ts` | Update `getWorkspaceRoot()` doc comment |
| `src/extension.ts` | Use resolver at all `[0]` sites; add `onDidChangeWorkspaceFolders` |
| `src/flightpath/WorkflowOrchestrator.ts` | Resolve `currentWorkspaceFolder` via resolver |
| `src/ui/WorkflowSerializer.ts`, `src/ui/WebviewSettingsSync.ts`, `src/scm/ScmCommitCommand.ts`, `src/completions/PromptLinkProvider.ts`, `src/utils/AttachmentBuilders.ts`, `src/utils/Log.ts`, `src/dev/DevCommands.ts` | Replace direct `workspaceFolders[0]` reads |
| `src/test/**` | Unit tests for the resolver; orchestration tests for changed call sites |

---

## Testing

- **Resolver unit tests** (no `vscode` dependency): setting set (absolute), setting set
  (relative + `${workspaceFolder}` expansion), `workspaceFile` is `file:`, `workspaceFile`
  is `untitled:`, single folder, no folder (CLI `process.cwd()`).
- **Single-folder regression**: existing behavior unchanged when no setting and no
  `.code-workspace` file — `.flightpath` stays at `workspaceFolders[0]`.
- **Multi-root**: open a `.code-workspace` with 3 folders; confirm one `.flightpath` at the
  workspace-file dir, parallel workflows from different roots all write to that one
  `.flightpath/.queue/`, and history/settings/temp are shared.
- **Runtime change**: add/remove a non-first folder → no disruption; remove the folder the
  resolver was falling back to → "Reload Window" prompt.

---

## Out of Scope (Deliberate Non-Goals)

- **Per-workflow / per-folder `.flightpath` directories.** Theoretically possible — you
  asked about "workflow A under one directory, workflow B under another." Today this would
  require multiplexing the currently-singleton `OutputHistoryManager`, settings backend,
  `WorkspaceSessionManager`, search index, and `capabilities.json` per root. That is a
  separate, much larger effort. If desired later, the natural seam is a per-`WorkflowInstance`
  root passed down from the resolver instead of a single shared root. Flagged here so it is
  a conscious future decision, not an accident of this plan.
- **Active-file scoping for the `.flightpath` location** (rejected above).
- **Migration of existing users' settings** (pre-release — not applicable).
