# Status Line Codex Support Plan

> **Status:** Not started. Research done 2026-11-23 from the Codex source (`c:\dev\codex` at
> `964fdd565`, 2026-11-23) and the installed `codex-cli 0.171.0`. **No live probe yet.** Phase 0
> must confirm the unverified mechanics below before any extractor or launch work starts.

**Related:** [`STATUS_LINE_COPILOT_QWEN_PLAN.md`](../implemented/STATUS_LINE_COPILOT_QWEN_PLAN.md)
(implemented; covers the four stdin-command providers and the provider tables this plan extends),
[`STATUSLINE_USER_CONTROLS_PLAN.md`](../implemented/STATUSLINE_USER_CONTROLS_PLAN.md),
[`STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md`](../implemented/STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md).

## Goal

Show ctrlyoke's status line in Codex sessions too. Codex is the only harness with a native footer
that ctrlyoke doesn't drive yet (opencode has no equivalent). Codex added a custom status line on
2026-10-29 (upstream #57970). It works very differently from the other four providers, so it
needs its own transport adapter, not just a fifth entry in the existing provider tables.

## Research

### Mechanism: an MCP server, not a stdin command

Sources: `codex-rs/skills/src/assets/samples/create-statusline/` (`SKILL.md`, the Python starter
`assets/statusline.py`, and the ts-rs-generated `references/statusline.d.ts`),
`codex-rs/tui/src/statusline_provider.rs`, `codex-rs/tui/src/chatwidget/statusline_reader.rs`,
`codex-rs/config/src/config_layer_source.rs`, `codex-rs/config/src/types.rs`.

- **Feature flag:** `tui_extensions_statusline`, stage `Experimental` (shown in `/experimental` as
  "Custom status line"), `default_enabled: false`. `codex features list` on 0.171.0 prints
  `tui_extensions_statusline experimental false`. The TUI reads the flag from the app server's
  `config/read` (`features.tui_extensions_statusline`) at startup (`app/startup.rs`
  `statusline_enabled`).
- **Provider:** a stdio MCP server, registered like any other (`mcp_servers.<name>`). In
  `tools/list` it advertises exactly one tool whose
  `_meta["openai/ui"].entrypoints` contains `{"type":"statusline","resourceUri":"ui://…"}`.
  The tool's `title` is the label in the `/statusline` picker.
- **Read loop:** the TUI calls `resources/read` on that URI. The thread state arrives in
  `params._meta["com.openai/codex-statusline-state"]`. The reply must be exactly one text resource
  at that URI, MIME type `application/json`, whose text is a JSON-encoded UI tree.
- **Cadence:** each read has **1 second** to finish. After a successful read Codex waits 1 s, then
  reads again. **An error or timeout stops polling** until the user reselects the provider in
  `/statusline` (a warning is logged and F2 shows the failure). Provider lookup itself has a 5 s
  budget (`LOOKUP_TIMEOUT`).
- **Selection** is stored in `[tui] status_line_provider = { server = "...", tool = "..." }`, or
  `"default"` for the built-in items. `allows_status_line_provider()` drops the key from
  `PackagedDefaults` and `Project` layers, and accepts it from `User`, `SessionFlags` (`-c`,
  precedence 30), system and managed layers. An invalid value in an allowed layer is treated as
  `"default"`, so it still overrides lower layers.
- **Ownership checks** (`ResolvedStatuslineProvider::resolve`): the provider is ignored if any
  enabled **project** layer defines `mcp_servers.<server>`, or the owning plugin or marketplace.
  The server must appear in the app server's global MCP inventory (`mcpServerStatus/list` with no
  thread) and in the thread's inventory with the same plugin owner, and be `Connected`.

### UI tree output

The output is a UI tree instead of ANSI text (`UiTree = Element | null`):

- Elements: `text` (props `color`, `weight`, `italic`, `underline`), `link` (`href`, `title`),
  `row` (`gap` required, `background`, `wrap`, `justify`), `bold`, `italic`, `underline`, or a bare
  string. `null` clears the footer.
- Colors: theme names (`primary`, `surface`, `accent`), ANSI names (`black`, `red`, `green`,
  `yellow`, `blue`, `magenta`, `cyan`, `white`), status names (`status-model`, `status-path`,
  `status-branch`, `status-usage`, `status-limit`, …) or `#RRGGBB`.
- Limits: 64 KiB of JSON, 16 KiB of UTF-8 leaf text, 256 non-null nodes, depth 16.

ctrlyoke's curated color vocabulary (`StatuslineFormat.ts`, the ANSI prefix map near line 117:
`red`, `yellow`, `green`, `cyan`, `blue`, `magenta`, `white`) is a subset of Codex's ANSI color
names, so segment colors map one to one.

### State payload (`StatuslineState`)

From `statusline.d.ts` (generated from the Rust types; not yet captured live):

```ts
type StatuslineState = { account: Account; app: App; config: Config; thread: Thread };
type Account = { rate_limits: RateLimitSnapshot[]; workspace?: { headline: string } };
type RateLimitSnapshot = {
  limit_id: string; limit_name: string | null;
  primary_limit: RateLimitWindow | null; secondary_limit: RateLimitWindow | null;
};
type RateLimitWindow = { used_percent: number; window_minutes: number | null; resets_at: number | null };
type App = { cli_version: string; display_mode: "standard" | "raw" };
type Thread = {
  id: string; name: string | null; agent: { state: RunState };
  model: { display_name: string; id?: string; provider: string; reasoning_level?: string; ... };
  workspace: { cwd: string };
  usage: { context: { context_window_size?: number; used_tokens?: number; used_percentage?: number };
           total?: TokenUsage; cost?: { total_cost_usd?: number; total_credits?: number } };
  approval?: ...; permissions?: ...;
};
```

Field availability for ctrlyoke's registry:

| id                        | codex source                                                               | note                                                           |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `model`                   | `thread.model.id` → `thread.model.display_name`                            | `id` is optional                                               |
| `context`                 | `thread.usage.context.used_tokens` / `context_window_size`                 | all optional; native `used_percentage` also present            |
| `usage`/`usage1`/`usage2` | `account.rate_limits[].primary_limit` / `secondary_limit` (`used_percent`) | **real data**, unlike Copilot/Qwen (5-hour and weekly windows) |
| `version`                 | `app.cli_version`                                                          |                                                                |
| `cwd`                     | `thread.workspace.cwd`                                                     | nested, like Qwen's `workspace.current_dir`                    |
| `sessionId`               | `thread.id`                                                                |                                                                |
| `branch`                  | none in payload                                                            | keep the shared `.git/HEAD` read, resolved from `cwd`          |
| `date`/`time`             | local                                                                      | no change                                                      |

`account.rate_limits` can hold several snapshots (`limit_id`). Phase 0 must record which one
matches the `codex` bucket that `CodexUsageNormalization.ts` already treats as primary, so the
status line and `UsageCard` agree.

### How ctrlyoke launches Codex today

Interactive Codex runs in `PtyProcessManager`'s pseudo-terminal with `--enable hooks` and inline
`-c` overrides (`CODEX_HOOK_ARGS` and the hook-config builders in
`src/core/harness/codex/CodexHarnessAdapter.ts`). Headless runs use `codex app-server` (or
`exec`), which has no footer, so the status line can only ever appear in interactive sessions,
just like every other harness.

## Decisions

1. **Turn it on per launch with session flags, not with a persistent install.** Add these to
   interactive Codex launches, next to the hook flags:

   ```
   --enable tui_extensions_statusline
   -c mcp_servers.ctrlyoke-statusline.command=<node>
   -c mcp_servers.ctrlyoke-statusline.args=[<wrapper path>]
   -c tui.status_line_provider={server="ctrlyoke-statusline",tool="statusline"}
   ```

   Reasons:
   - `~/.codex/config.toml` is TOML. `SettingsJsonMcpTracker` only edits JSON, so a persistent
     install would need a new TOML editor that preserves the user's comments and layout.
   - No install/uninstall lifecycle, no capture/restore, and no risk of leaving a stale entry in
     the user's config if ctrlyoke is removed.
   - Session flags are an allowed layer for `status_line_provider`. Project layers are not, so
     writing `.codex/config.toml` in the workspace would not work anyway.

   Trade-off: Codex sessions the user starts outside ctrlyoke don't get the line. That matters less
   for Codex than for the others, because `CodexUsageProvider` already gets quota through
   `CodexAppServerClient`, not through the status line snapshot. Note this under **Changed** in
   `CHANGELOG.md` when it ships.

2. **Add `codex` as a fifth provider** in `STATUS_LINE_TRACKING_PROVIDERS`,
   `STATUS_LINE_FORMAT_PROVIDERS` and the wrapper's `STATUSLINE_PROVIDERS`, and add
   `HARNESS_IDS.CODEX_CLI` to `StatusLineTrackingHarnessId`. Settings use the existing
   `statusLineTrackingSettings` shape (`enabled`, `customCommand`, `useCtrlyokeStyle`, `format`).
   `enabled: false` simply leaves the four launch arguments out. `StatuslineManager.getDefinition`
   needs no `SettingsJsonMcpTracker` definition for Codex. Its install/uninstall paths must treat
   Codex as launch-time only, not file-backed. Keep that branch in one place rather than scattering
   `provider !== CODEX` checks.

3. **New wrapper entry: `src/scripts/ctrlyoke-codex-statusline.js`, a long-lived MCP stdio
   server.** Node built-ins only, like the existing wrappers. It handles newline-delimited JSON-RPC:
   `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
   `resources/templates/list` and `resources/read`. It must answer every `resources/read` within
   the 1 s budget and **never return an error for a malformed or partial state**. An error stops
   Codex's polling for the rest of the session. On any internal failure, return a minimal tree (or
   `null`) instead. It reuses the shared wrapper module for settings resolution, formatting and
   `writeSnapshotAtomic`. Settings stay cached and are re-read when the settings file's mtime
   changes, since the process now lives for the whole session instead of one tick.

4. **Add a UI-tree renderer next to the ANSI renderer in `StatuslineFormat.ts`.** Format the
   segments once, then render them to ANSI text for the four stdin providers or to a root
   `row` (`gap: 1`, `wrap: "wrap"`) of `text` elements for Codex. Do not build two formatters.
   Segment colors pass through as Codex color names. Cap output well below Codex's node and size
   limits.

5. **Codex extractors** in `StatuslineFormat.ts`: a `context` branch using
   `used_tokens`/`context_window_size` (falling back to `used_percentage`), a `cwd` fallback that
   includes `thread.workspace.cwd`, and `quotaPercentage`/`usageWindows` cases reading
   `account.rate_limits` windows (`window_minutes` gives the window label). Because the state is
   nested under `thread`/`app`/`account`, add one Codex normalizer that maps it onto the fields the
   extractors read, instead of adding a Codex branch to every extractor.

6. **`customCommand` and `useCtrlyokeStyle`.** A user's own Codex status line is either built-in
   items (`tui.status_line`) or another MCP provider. Neither can be forwarded the way a stdin
   command can. Decide in Phase 0 between two options:
   - (a) hide `customCommand` for Codex in the UI;
   - (b) keep it and pipe the raw Codex state JSON to it, rendering its stdout as a plain string.

   Leaning toward (a). If the user's effective config already selects a different MCP provider,
   ctrlyoke's session flag silently overrides it for ctrlyoke sessions. That is harmless but
   surprising. Decide whether to skip ctrlyoke's line in that case, like the Qwen preset rule
   (Decision 8 of the Copilot/Qwen plan). Detecting it needs a `config/read`, which
   `CodexAppServerHeadlessControlChannel` already performs.

7. **Version gating.** Older Codex releases reject unknown `--enable` keys at startup. Gate the
   four arguments on a minimum Codex version, the same way the hooks flag is gated, and pin the
   minimum after Phase 0. Because the feature is `Experimental`, add a contract test against a
   checked-in copy of `statusline.d.ts`'s state shape so an upstream change shows up as a test
   failure, not a blank footer.

## Non-Goals

- Editing `~/.codex/config.toml` or installing a persistent provider for sessions outside
  ctrlyoke.
- Translating ctrlyoke's format into Codex's built-in `tui.status_line` item IDs.
- Using `link`, `justify`, `background` or the Codex status-* colors beyond the existing color
  vocabulary.
- Changing `CodexUsageProvider` quota plumbing.

## Phases

0. **Live probe** (required before anything else). With `node-pty` (see "Probing a harness CLI's
   interactive log format" in `.github/copilot-instructions.md`), launch interactive Codex from a
   scratch directory with the four arguments from Decision 1, pointing at a probe MCP server that
   logs every request. Confirm:
   - `--enable tui_extensions_statusline` turns the feature on through `config/read`;
   - the inline-table `-c tui.status_line_provider={…}` parses;
   - a `-c`-defined MCP server shows up in the global inventory with no `plugin_id`, so the
     ownership check passes;
   - `resources/read` fires about once a second in a real TTY;
   - the real `com.openai/codex-statusline-state` JSON is captured (record it here, as the
     Copilot/Qwen plan did), including which `rate_limits` entry is the primary bucket;
   - what happens on the first ticks before the first turn;
   - the minimum Codex version that accepts the flag.
1. **Provider enums, settings schema and defaults** for `codex` (Decision 2). Expect
   `settingsSchemaUiParity` to stay red until Phase 5.
2. **`StatuslineFormat.ts`:** the Codex state normalizer, extractors and UI-tree renderer
   (Decisions 4 and 5), with wrapper fixture tests built from the Phase 0 capture.
3. **`ctrlyoke-codex-statusline.js` MCP server** (Decision 3), registered in the `copy-scripts`
   esbuild plugin. Tests cover the JSON-RPC handshake, malformed input, a slow settings read, and
   never returning an error from `resources/read`.
4. **Launch wiring** in `CodexHarnessAdapter.ts` (Decisions 1, 6 and 7), interactive only and
   version-gated, with argument-builder tests for enabled, disabled and old-version cases.
5. **UI:** add Codex to `STATUS_LINE_HARNESS_IDS`, the `StatusLineTrackingControls.tsx` maps, a
   Codex sample payload in `StatusLinePreview.tsx`, and hide unsupported controls per Decision 6.
   Update the status line docs page and `CHANGELOG.md`.

## Open Questions

- Does `-c mcp_servers.<name>` from session flags survive into the app server the TUI connects to
  when Codex uses a local daemon or remote app server, rather than the embedded one? If the
  daemon's global inventory comes from its own config, per-launch injection may fail there.
  Phase 0 should test the default (embedded) target and note what happens with others.
- Should the snapshot written by the Codex wrapper feed `UsageCard` at all, given
  `CodexUsageProvider` already has an authoritative source? Probably write it for consistency
  ("last observed") but keep the app-server data as the primary source.
