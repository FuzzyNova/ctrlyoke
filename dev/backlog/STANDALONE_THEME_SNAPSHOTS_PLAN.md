# Standalone Theme Snapshots Plan

**Status (2026-10-06):** Backlog. Not started. Follow-up to
[`STANDALONE_SERVER_PLAN.md`](../implemented/STANDALONE_SERVER_PLAN.md) Phase 4
(staging Stage 7b), which bundles only Dark 2026 and Light 2026.

## Goal

Let a VS Code user who moves to `ctrlyoke server` keep using their own VS Code
theme, including Marketplace themes, without ctrlyoke parsing theme files.
Every theme the user has had active while the ctrlyoke panel was open is saved
as a snapshot of its computed `--vscode-*` values. The standalone server then
offers those snapshots next to the two bundled themes, and `auto` mode can pick
the user's preferred light and dark theme per client.

## Why snapshots, not theme files

We considered reading VS Code theme JSON directly (pointing a setting at a
theme file, or defaulting a picker to VS Code's built-in theme folder) and
rejected it:

- **A theme file is incomplete.** `2026-dark.json` defines 291 colors and
  `include`s `dark_modern.json`. VS Code's color registry derives the rest in
  code, and the dashboard needs the computed result (955 variables in the
  Stage 7b dumps). Translating a theme file means re-implementing that
  registry, and the result would still be an approximation.
- **The install path is unstable.** A Windows user install keeps built-in
  themes under
  `%LOCALAPPDATA%\Programs\Microsoft VS Code\<commit prefix>\resources\app\extensions\theme-defaults\themes\`,
  and the `<commit prefix>` folder (`07f806f999` for 1.140) changes with every
  update. Marketplace themes live elsewhere, under
  `~/.vscode/extensions/<publisher.name-version>/`, listed in each extension's
  `package.json`.
- **A snapshot is exact.** The panel already captures the computed values for
  the hosted server. Persisting them costs one file write and covers any theme.

## Current state (verified 2026-10-06)

- **Production capture already exists, but is thrown away unless the hosted
  server is running.**
  - `captureAndSendThemeVars` (`src/ui/webview-react/hooks/useMessageHandler.ts`)
    reads the `--vscode-*` properties from `<html>`'s inline style and `:root`
    rules, adds the synthetic `--cy-color-theme-kind`, and posts
    `THEME_VARS_CAPTURED`.
  - `extension.ts` posts `CAPTURE_THEME_VARS` on
    `onDidChangeActiveColorTheme`, and again when the hosted server starts.
  - `WebviewMessageRouter` accepts `THEME_VARS_CAPTURED` only from
    `PANEL_CLIENT_ID` and forwards it to `themeVarsCapturedCallback`.
  - That callback is installed only when the hosted server starts
    (`setThemeVarsCapturedCallback` → `hostedServer.updateThemeVars`). Without
    a running server, every capture is dropped.
- **The dev dump is a separate implementation.** `ctrlyoke.dumpCssVars`
  (`src/dev/DevCommands.ts`) opens a scratch webview with its own inline
  script, enumerates every computed property, and writes
  `dev/reference/vscode-css-vars.json`. `DevCommands.ts` is dead-code-eliminated
  from production builds, so none of it can run for users.
- **Nothing records which theme a capture came from.** The payload has values
  and a kind, but no theme ID or label. `vscode.window.activeColorTheme` only
  exposes `kind`.

## Design

### 1. One capture implementation, always on

- Move persistence into a production, host-neutral `ThemeSnapshotStore`
  (proposed `src/server/ThemeSnapshotStore.ts`, no `vscode` import, so the
  standalone server can read what the extension wrote).
- `extension.ts` composes a theme-capture listener at activation that is
  independent of the hosted server: every panel `THEME_VARS_CAPTURED` goes to
  the store, and is also forwarded to the hosted server when one is running.
  Replace the single `setThemeVarsCapturedCallback` slot with a listener list,
  or have the store notify the server.
- Capture triggers: panel ready (first load), `onDidChangeActiveColorTheme`,
  and hosted-server start (existing). Debounce theme-change bursts, and skip
  the write when the snapshot's content hash is unchanged.
- **Retire the dev dump's private script.** `ctrlyoke.dumpCssVars` becomes a
  thin dev wrapper: ask the panel for a capture (or read the store's snapshot
  of the active theme) and write it to `dev/reference/`. The two capture
  methods enumerate differently today (inline style plus `:root` rules versus
  every computed property). Before retiring the dev script, compare one capture
  from each on Dark 2026 and confirm the production method returns the same
  955 variables. If it doesn't, fix the production method, since it is also
  what the hosted server serves.

### 2. Identify the theme

The snapshot needs a stable ID and a display label. Options, in order of
preference:

1. **Webview `<body>` attributes.** VS Code is believed to set
   `data-vscode-theme-id` and `data-vscode-theme-name` on webview bodies.
   Verify on 1.140. If present, add `themeId` and `themeLabel` to the
   `THEME_VARS_CAPTURED` payload, read in `captureAndSendThemeVars`.
2. **Extension-host configuration.** Read `workbench.colorTheme`, or
   `workbench.preferredDarkColorTheme`/`preferredLightColorTheme` when
   `window.autoDetectColorScheme` is on, at capture time. This is fragile
   (auto-detect, high-contrast auto-switching, profile overrides), so use it
   only if option 1 doesn't exist. It is a `workbench.*` read, not a
   `ctrlyoke.*` one, so it doesn't conflict with the single
   `getConfiguration('ctrlyoke')` rule, but it must live in a VS Code-only
   adapter.

Snapshots without an identifiable theme are not persisted.

### 3. Storage

- One file per theme at `<ctrlyokeStateHome>/themes/<slug>.json` (user scope:
  a theme is a user preference, not a project one). It syncs with the rest of
  the state home, and can be copied to a machine that has no VS Code.
- Shape: `{ storageVersion, themeId, label, kind, vscodeVersion, capturedAt,
vars }`. `kind` comes from `--cy-color-theme-kind`, so high-contrast themes
  are included and classified.
- Run `sanitizeThemeVars` on write **and** on load. Snapshot values are
  spliced into server-rendered `<style>` blocks, and a file in the user's home
  can be hand-edited.
- Write with `writeFileAtomic`. The bundled Dark 2026/Light 2026 themes are
  not written here; they ship in `src/server/themes/`.
- A settings action to forget a snapshot. No automatic cap: users have few
  themes, and each file is roughly 40 KB.

### 4. Settings and selection

- Keep `server.theme: "auto" | "light" | "dark"` (schema unchanged).
- Add `server.themeLight` and `server.themeDark` (theme IDs, defaulting to the
  bundled Light 2026 and Dark 2026), mirroring VS Code's preferred light/dark
  theme settings.
  - `auto` serves the light and dark choices under
    `@media (prefers-color-scheme: …)`, so each client still follows its own
    OS.
  - `light`/`dark` force the corresponding choice.
  - `?theme=light|dark` still overrides per client.
  - A missing or unreadable snapshot falls back to the bundled theme of the
    same kind, with a log line.
- The settings UI renders both as dropdowns listing the bundled pair plus every
  stored snapshot of a compatible kind. The server provides the list (a typed
  message or `/api/themes`); the browser never reads the state home.
- Schema change: add both properties to `schemas/settings-schema.json`, then
  `npm run schema:update`.

### 5. Hosted mode

The VS Code-hosted server keeps serving the live capture, because the browser
should match the VS Code window it is attached to. The new settings apply to
standalone, and to the hosted server only as its fallback before the first
capture arrives (replacing Stage 7b's fixed defaults).

## Tests

- `ThemeSnapshotStore`: round-trip, sanitization on load of a tampered file,
  unchanged-hash skip, `storageVersion` mismatch starts clean.
- Router/extension wiring: a panel capture persists with no hosted server
  running; a non-panel `THEME_VARS_CAPTURED` never persists (extend the
  existing `WebviewSettingsSync.test.ts` scoping test).
- Server: `auto` emits both media blocks from the chosen snapshots; a missing
  snapshot falls back to the bundled theme of the same kind.
- Capture parity check from Design 1 (one-off, recorded in the commit that
  retires the dev script).

## Open questions

1. Should the hosted server also honor `server.themeLight`/`themeDark`, so a
   phone can use a different theme than the VS Code window? Default answer:
   no, live capture wins (Design 5).
2. Should a snapshot be refreshed when VS Code updates a theme without the user
   switching to it? Default answer: no; it refreshes the next time that theme
   is active with the panel open.
