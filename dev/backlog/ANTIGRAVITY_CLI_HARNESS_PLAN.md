# Replace Gemini with Antigravity CLI (`agy`) in FlightPath

**Harness ID**: `antigravity-cli`
**Binary**: `agy` (v1.0.8 observed)
**Vendor**: Google DeepMind
**Last Updated**: June 2026
**Scope**: Add the `antigravity-cli` harness **and remove the `gemini-cli` harness entirely.**

---

## Background

Google has deprecated the Gemini CLI; `gemini` no longer works in FlightPath (it errors when invoked) and is being replaced by **Antigravity (`agy`)** as Google's primary AI coding CLI. Unlike the original plan (which kept Gemini alongside Antigravity), Nathan has decided to **remove Gemini support outright** — there is no reason to keep a broken harness. This document covers both halves:

- **Part A** — research findings from running `agy` locally (replaces the old speculative "Open Questions").
- **Part B** — add the `antigravity-cli` harness.
- **Part C** — remove the `gemini-cli` harness and all references.

This is the inverse-plus-add of [`ADDING_NEW_CLI_HARNESS.md`](../implemented/ADDING_NEW_CLI_HARNESS.md). Read that guide for the per-layer touchpoint rationale; this document records what is **specific** to Antigravity and to deleting Gemini.

---

## Part A — Research Findings (`agy` v1.0.8, run locally)

The original plan's open questions are now **answered** by running `agy` and inspecting its on-disk state. The headline result: **`agy` is a Gemini fork that proxies to Claude models, but it does NOT emit structured headless output and does NOT write parseable JSON session logs.** This invalidates two assumptions in the first draft (that it was "structurally near-identical to Claude" and that its parser could clone Gemini's stream-json/JSON-log approach).

### A.1 `agy --help` (verified)

```
--add-dir                       Add a directory to the workspace (repeatable)
-c / --continue                 Continue the most recent conversation
--conversation                  Resume a previous conversation by ID
--dangerously-skip-permissions  Auto-approve all tool permission requests
-i / --prompt-interactive       Run an initial prompt interactively and continue
--log-file                      Override CLI log file path
--model                         Model for the current CLI session
-p / --print / --prompt         Run a single prompt non-interactively and print the response
--print-timeout                 Timeout for print mode wait (default 5m0s)
--sandbox                       Run in a sandbox with terminal restrictions

Subcommands: changelog, help, install, models, plugin/plugins, update
```

**There is NO `--output-format`, NO `--stream-json`, NO `--session-id`, NO `--mcp-config` flag.** This is the critical departure from Gemini (which FlightPath drives with `--prompt ... --output-format stream-json --session-id <id>`).

### A.2 It's a Gemini fork that runs Claude models

`agy` stores everything under the **shared `~/.gemini/` tree**, not its own `~/.antigravity/` or `~/.agy/` (neither exists):

- `~/.gemini/antigravity-cli/` — agy's private data root (created on first run)
- `~/.gemini/config/` — shared config (incl. `mcp_config.json`; `/hooks` writes to `~/.gemini/config/hooks.json` per the 1.0.8 changelog)
- `~/.gemini/settings.json`, `~/.gemini/oauth_creds.json`, `~/.gemini/trusted_hooks.json` — shared auth/settings
- `agy plugin import` explicitly imports "from gemini or claude"

The CLI log confirms the backend routes Gemini-CLI-style requests to **Claude models**:

```
model_config_manager.go: Propagating selected model override to backend: label="Claude Sonnet 4.6 (Thinking)"
http_helpers.go: URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
```

**Implication for `--model`**: the model identifiers are **Claude-family labels** (observed default: `Claude Sonnet 4.6 (Thinking)`), surfaced via Google's CloudCode backend. Run `agy models` **in an authenticated TTY** to enumerate the full list (it returns empty in a piped/non-TTY context). The model dropdown should therefore list Claude-style models, not Gemini ones.

### A.3 Conversations are SQLite/protobuf — NOT JSON logs

This is the most important finding for the parser design. `agy` does **not** write the human-readable `~/.gemini/tmp/<project>/chats/session-*.json` files that `GeminiLogParser` reads. Instead, under `~/.gemini/antigravity-cli/`:

- `conversations/<uuid>.db` (SQLite) and `<uuid>.pb` (protobuf) — opaque, not parseable as JSON
- `brain/<uuid>`, `implicit/<uuid>.pb` — protobuf agent state
- `cache/last_conversations.json` — maps `workspace → most-recent conversationId`
- `history.jsonl` — appends `{display, timestamp, workspace, conversationId, type}` per input
- `log/cli-<datetime>.log` — verbose **glog text** (`I0618 17:00:37.265854 ... server.go:839] ...`)

**Consequence**: there is no way to extract a rich per-tool/diff/token timeline from agy the way `GeminiLogParser` does. The dashboard will show the **plain-text response** plus session/completion state — not the structured tool/diff/thinking event stream. Treat that as an accepted limitation, not a bug.

### A.4 Session ID = conversation UUID

The "session ID" is the conversation UUID (`8ab91287-cfd4-4e25-8405-8d48b9d8a8e3`). It is **not printed to stdout**. Best sources, in order of reliability:

1. `~/.gemini/antigravity-cli/log/cli-*.log` — regex `Print mode: conversation=<uuid>` / `Starting conversation update stream for <uuid>`.
2. `~/.gemini/antigravity-cli/cache/last_conversations.json` — keyed by absolute workspace path.

Resume with `--continue`/`-c` (most recent) or `--conversation <uuid>` (specific).

> ⚠️ **Pre-1.0.9 resume bug**: in `--conversation <id> -p` (headless resume), `agy` dumps the *entire* historical transcript instead of only the new response. Fixed in 1.0.9 (we observed 1.0.8). Either require `agy >= 1.0.9` or have the response parser keep only the final turn.

### A.5 Headless output format = plain text (and currently fragile)

With no `--output-format` flag, `agy --print "..."` is expected to print the model's response as **plain text** to stdout. In local testing under a piped (non-TTY) stdout, `--print` exited `0` with **zero bytes** even though the log showed a conversation was created and `streamGenerateContent` was called. Likely causes: print mode needs a TTY, or quota/`--print-timeout` interaction. **Action item before implementation**: confirm `agy -p "hello"` prints text in the exact spawn context FlightPath uses (`PtyProcessManager`, which provides a PTY — so this may already be fine). The parser must tolerate empty stdout gracefully.

### A.6 Completion detection

- **Headless (`--print`)**: blocks until the turn finishes, then the process exits → use **process-exit detection** (no hook needed). The cli log marks completion with `Stream completed for <uuid>, clearing ResponsePending` / `Language server shutting down`.
- **Interactive (`-i`)**: `agy` supports hooks via `/hooks` → `~/.gemini/config/hooks.json` (global/shared, NOT the workspace `.gemini/settings.json` mechanism Gemini's monitor uses). The hook event names and payload shape are **still unverified** — run `agy help` / inspect `~/.gemini/config/hooks.json` after configuring a hook in the TUI. If hooks prove unworkable, fall back to polling the cli log for the `clearing ResponsePending` marker.

### A.7 Permissions, MCP, dirs

- `--dangerously-skip-permissions` → maps directly to FlightPath's `dangerouslyAllowAll`. No `--allow-tools`/`--deny-tools` flags were found, so `allowAll`/`custom` modes have **no native CLI mapping** — they degrade to "prompt normally" (no flag) unless hook-based permission decisions are wired later.
- `--add-dir <dir>` (repeatable) for extra workspace roots.
- MCP: no `--mcp-config` flag; agy reads `~/.gemini/config/mcp_config.json`. Per-workflow MCP injection like Gemini's `--allowed-mcp-server-names` is **not available**. MCP support is therefore **out of scope for v1** of this harness (return `null`/`[]` from MCP methods).
- `--sandbox` available but not needed for FlightPath.

### A.8 Net architecture decision

Antigravity is a **hybrid**, not a Claude clone or a Gemini clone:

| Concern | Model it on | Notes |
| --- | --- | --- |
| CLI flags / invocation | **Claude** | `--print`, `-c`/`--conversation`, `--dangerously-skip-permissions`, `--add-dir`, `--model` |
| Headless completion | **Codex/Claude exit-based** | process-exit; plain-text stdout |
| Response parsing | **plain text** | clone the simplest text parser; NO stream-json, NO tool/diff events |
| Session ID + logs | **custom** | parse `~/.gemini/antigravity-cli/log/cli-*.log` + `cache/last_conversations.json`; NOT `GeminiLogParser` |
| Interactive hooks | **TBD** | `~/.gemini/config/hooks.json`; verify before relying on it |
| Tool/diff/token timeline | **none** | not exposed by agy; accept plain-text-only fidelity |

---

## Part B — Add the `antigravity-cli` Harness

Follow `ADDING_NEW_CLI_HARNESS.md` for the layer-by-layer mechanics. Below are only the Antigravity-specific decisions and deltas.

### B.1 Harness directory — `src/flightpath/harness/antigravity/`

#### [NEW] `AntigravityCliProvider.ts`  (model on `ClaudeCliProvider.ts`)

```ts
config = {
  name: "antigravity",
  harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
  displayName: "Antigravity CLI",
  terminalName: "Antigravity",
  installHint: "Install via: agy install (or from the Antigravity website)",
  shouldStreamHeadlessOutput: true,   // plain-text stream
  // NO usesInteractiveNotificationMonitor until hooks are verified (A.6)
};
```

- `buildHeadlessArgs(baseArgs, prompt)` → `["--print", prompt, ...baseArgs]` (no `--output-format`).
- `buildInteractiveArgs(baseArgs, text)` → `["--prompt-interactive", text, ...baseArgs]`.
- Model: `--model <claudeLabel>` when set and not `MODEL_NONE`.
- Resume: `--conversation <uuid>` when a sessionId exists and `resumeSession` is on; else omit (or `-c` for "continue most recent").
- `--add-dir` for extra workspace dirs if FlightPath passes any.
- `checkAvailability()` / `getVersion()` → `CliProviderUtils.checkCliAvailability("agy --version")`.
- `formatFileReference()` → same as Claude (no prefix) until proven otherwise.
- MCP methods → return `null`/`[]` (out of scope, A.7). Do **not** copy Gemini's `SettingsJsonMcpTracker`/`SettingsJsonHooksTracker` wiring.

#### [NEW] `AntigravityResponseParser.ts`  (plain-text)

Clone the **plain-text** parser shape, not Gemini's stream-json one.

- `parse(stdout, stderr, exitCode)` → `{ responseText: stdout-trimmed, success: exitCode === 0, sessionId? }`. Tolerate **empty stdout** (A.5).
- `extractSessionId(output)` → return `undefined` (UUID is not on stdout; the log parser supplies it).
- `processStreamingChunk(chunk)` → return `chunk` (plain passthrough).
- `parseTokenCounts(output)` → likely `undefined` (no token line in plain-text stdout; revisit if one appears).

#### [NEW] `AntigravityLogParser.ts`  (custom — extends `BaseLogParser`)

**Do not** reuse `GeminiLogParser`'s `chats/*.json` logic. Parse agy's glog text log:

- `getLogDirectory()` → `path.join(os.homedir(), ".gemini", "antigravity-cli", "log")`.
- `getLogFilePattern()` → `/^cli-\d{8}_\d{6}\.log$/`.
- `parseLogLine(line)` → regex-extract events of interest:
  - session start: `Print mode: conversation=(<uuid>)` or `Starting conversation update stream for (<uuid>)`
  - completion: `clearing ResponsePending` / `Language server shutting down`
- `extractSessionId(event)` → the captured UUID.
- `isCompletionEvent(event)` → the completion markers above.
- Primary fallback for session ID: read `~/.gemini/antigravity-cli/cache/last_conversations.json[workspaceAbsPath]`.

Because the rich event stream is unavailable (A.3), this parser only provides **session ID + completion**, not tool/diff/token events.

#### [NEW] `AntigravityNotificationMonitor.ts`

- **Headless**: exit-based (return promptly; `CliIntegration` detects process exit). Mirror Codex/Claude's exit path; no notification file required.
- **Interactive**: only wire hooks once `~/.gemini/config/hooks.json` event names are verified (A.6). Until then, `buildHookConfig()` returns `{ type: "none" }` and interactive completion relies on log polling.

#### [NEW] `AntigravityToolPermissionMapper.ts`

- `dangerouslyAllowAll` → `["--dangerously-skip-permissions"]`.
- `allowAll` / `custom` → `[]` (no native flags, A.7) — document the degradation.

#### Hook script

`src/scripts/flightpath-antigravity-hook.js` — **defer** until A.6 confirms hooks. Skip for v1 if completion is exit/log-based.

### B.2 Type, wiring, settings, UI, schema layers

Mechanical — follow `ADDING_NEW_CLI_HARNESS.md` exactly, substituting `antigravity`/`ANTIGRAVITY_CLI`/`AntigravityCli`. Specific values:

- **`DashboardConstants.ts`**: `HARNESS_IDS.ANTIGRAVITY_CLI = "antigravity-cli"`; `HARNESS_INFO`/`HARNESS_DISPLAY_NAMES` → `{ name: "Antigravity CLI", shortName: "Antigravity" }`; `HARNESS_DEFAULT_MODELS` → observed default (e.g. a Claude Sonnet label); `ANTIGRAVITY_CLI_MODELS` list (Claude-family, from `agy models`).
- **`FlightPathTypes.ts`**: `Harness.AntigravityCli = "antigravity-cli"`.
- **`IntegrationFactory.ts`** / **`WorkflowOrchestrator.ts`**: factory method, switch case, field, construction, registration, init, `getIntegrationForHarness`, `setWorkflowName`, display label `[Harness.AntigravityCli]: "Antigravity CLI"`.
- **`ConfigurationUtils.ts`**: `antigravityCliModel` / `antigravityCliAdditionalArgs` keys, `normalizeHarness`, `getAntigravityCliModel()`, `getModelForHarness` case.
- **`ModelConstants.ts`**: `ANTIGRAVITY_CLI_MODELS`, `ANTIGRAVITY_CLI_MODEL_LABELS`, type, `isAntigravityCliModel`, `getModelDisplayName` case, and a `getAntigravityModelName` / context-window helper if the provider needs one.
- **`FlightPathSettings.ts`**: default model in `FLIGHTPATH_SETTINGS_DEFAULTS.defaults.models["antigravity-cli"]`.
- **`SessionValidator.ts`**: add `case HARNESS_IDS.ANTIGRAVITY_CLI` (UUID v4 — same validation as Gemini used).
- **`HarnessDirectoryUtils.ts`**: agent/skill dirs. agy shares `~/.gemini`, so likely `~/.gemini/antigravity-cli/...` (verify the agents/skills subpaths; do **not** assume `.antigravity/`).
- **`cli.ts`**: add `antigravity-cli` to the `--harness` description string.
- **`package.json`**: harness enum + description, `flightpath.antigravityCliModel` (order 450), `flightpath.antigravityCliAdditionalArgs` (order 451).
- **UI**: `WebviewSettingsSync.ts`, `HarnessDropdown.tsx` (display name + `CLI_HARNESSES`), `settingsStore.ts`, `HarnessIcon.tsx` (add an Antigravity icon).
- **Schemas**: `prompt-schema.json` + `settings-schema.json` enums/properties, then `npm run generate-schema`.
- **`scripts/sync-models.mjs`**: add an `antigravityModels` block parallel to (replacing) the Gemini one.
- **Docs**: `.github/copilot-instructions.md` harness + debug-log table; `docs/harnesses/antigravity-cli.md` (+ index/installation/concepts/settings).
- **Tests**: `harnessRunner.ts` union + default model; `hooks.harness.test.ts` only if hooks land; **`AntigravityResponseParser.test.ts`** + **`AntigravityLogParser.test.ts`** (plain-text parse, empty-stdout tolerance, UUID extraction from glog lines, `last_conversations.json` fallback).

---

## Part C — Remove the `gemini-cli` Harness

Delete Gemini everywhere it was added (the inverse of `ADDING_NEW_CLI_HARNESS.md`), plus the extra touchpoints found via grep. ~110 code references across 20 `src` files, plus docs/tests/schemas.

### C.1 Delete files

- `src/flightpath/harness/gemini/` (whole dir: `GeminiCliProvider.ts`, `GeminiResponseParser.ts`, `GeminiNotificationMonitor.ts`, `GeminiToolPermissionMapper.ts`, `GeminiLogParser.ts`)
- `src/scripts/flightpath-gemini-hook.js`
- `docs/harnesses/gemini-cli.md`

### C.2 Type layer

- `FlightPathTypes.ts` — remove `Harness.GeminiCli`.
- `DashboardConstants.ts` — remove `HARNESS_IDS.GEMINI_CLI`, its `HARNESS_INFO`/`HARNESS_DISPLAY_NAMES`/`HARNESS_DEFAULT_MODELS` entries, and `GEMINI_CLI_MODELS` (13 refs).
- `FlightPathSettings.ts` — remove `"gemini-cli"` default model.

### C.3 Wiring layer

- `IntegrationFactory.ts` — remove import, `createGeminiCli()`, switch case (5 refs).
- `WorkflowOrchestrator.ts` — remove field, construction, registration, init, resolution case, `setWorkflowName`, display label (8 refs).

### C.4 Settings layer

- `ConfigurationUtils.ts` — remove model key, args key, `normalizeHarness` cases, `getGeminiCliModel()`, `getModelForHarness` case (6 refs).
- `ModelConstants.ts` — remove `GEMINI_CLI_MODELS`, `GEMINI_CLI_MODEL_LABELS`, `GeminiCliModel`, `isGeminiCliModel`, `getGeminiModelName`, `getGeminiContextWindowSize`, `getModelDisplayName` case (8 refs). **Check call sites** — `getGeminiModelName`/`getGeminiContextWindowSize` are referenced by `GeminiCliProvider`/`GeminiLogParser` (being deleted) but grep for any stragglers.
- `SessionValidator.ts` — remove `case HARNESS_IDS.GEMINI_CLI` + doc lines (2 refs).
- `HarnessDirectoryUtils.ts` — remove all 5 `GEMINI_CLI` agent/skill/extension entries; update the "Codex, Gemini, Qwen…" comment.
- `cli.ts` — drop `gemini-cli` from the `--harness` description.
- `package.json` — remove `gemini-cli` from harness enum/enumDescriptions/markdownDescription and delete `flightpath.geminiCliModel` + `flightpath.geminiCliAdditionalArgs`.

### C.5 UI layer

- `WebviewSettingsSync.ts` — remove import, initial availability, `VALID_CLI_HARNESSES` entry, model/args maps, model options (9 refs).
- `HarnessDropdown.tsx` — remove display name + `CLI_HARNESSES` entry.
- `settingsStore.ts` — remove import, model array, initial availability, `modelsByHarness` (4 refs).
- `permissionUtils.ts` — remove the Gemini ref (1).
- Also check: `PropertiesDrawer.tsx`, `WorkflowPropertiesPanel.tsx`, `HarnessesSection.tsx`, `AdvancedPermissionsSection.tsx`, `HarnessIcon.tsx` (icon mapping) — remove Gemini entries.

### C.6 Schemas

- `schemas/prompt-schema.json` — remove `"gemini-cli"` from harness enum.
- `schemas/settings-schema.json` — remove from `defaults.harness`, `models`, `additionalArgs`.
- Run `npm run generate-schema` to regenerate `schemas/prompt-schema.yaml`.

### C.7 Shared infra — comments only (no logic change)

These mention Gemini in comments/lists but the code is generic; just update the wording:
`CliIntegration.ts:1453`, `INotificationMonitor.ts` (49, 511), `CodexNotificationMonitor.ts` (21, 52), `CliProviderUtils.ts` (295, 299). The `SettingsJsonMcpTracker`/`SettingsJsonHooksTracker` `"gemini"` singleton instances live in `GeminiCliProvider` (deleted) — confirm no other harness instantiates `getInstance("gemini")`.

### C.8 Tests

Remove Gemini from: `harnessRunner.ts`, `hooks.harness.test.ts`, `ModelConstants.test.ts` (11 refs), `ToolPermissionMappers.test.ts`, `HarnessToolPermissionMappers.test.ts`, `FlightPathConfigService.test.ts` (6 refs), `SettingsJsonHooksTracker.test.ts`, `WorkflowInstance.test.ts`. Where a test needs a representative "settings.json hook" harness and Gemini was the example, switch it to Qwen (which uses the same mechanism).

### C.9 Docs / misc

`.github/copilot-instructions.md` (harness + debug-log table), `docs/harnesses/index.md`, `docs/guide/installation.md`, `docs/guide/concepts.md`, `docs/reference/settings.md`, `docs/.vitepress/config.mts`, `README.md`, `QUICK_START.md`, `CHANGELOG.md` (add a removal entry), `scripts/discovered-models.json` (drop Gemini models), `scripts/sync-models.mjs` (remove the `geminiModels` block — superseded by `antigravityModels`), `src/ui/webview-react/static/dictionaries/en_US/en_US.dic` (remove "gemini" if present), `dev/reference/old-vscode-flightpath-settings.json` (historical — leave or note).

> Leave historical planning docs under `dev/implemented/` and `dev/research/` (e.g. `GEMINI_INTEGRATION_PLAN.md`) **as-is** — they are a record of past work, not live config.

---

## Combined Checklist

### Research (do first, while authenticated in a TTY)

- [ ] `agy models` → capture full Claude-family model list and exact `--model` identifiers
- [ ] `agy -p "hello"` under FlightPath's PTY spawn → confirm plain-text stdout is non-empty (A.5)
- [ ] Configure a hook in the agy TUI (`/hooks`) → inspect `~/.gemini/config/hooks.json` event names/shape (A.6)
- [ ] Confirm `agy --version >= 1.0.9` or plan to keep only the final turn on resume (A.4)

### Add Antigravity

- [ ] `src/flightpath/harness/antigravity/` — `AntigravityCliProvider`, `AntigravityResponseParser` (plain-text), `AntigravityLogParser` (custom glog), `AntigravityNotificationMonitor` (exit-based), `AntigravityToolPermissionMapper`
- [ ] (deferred) `src/scripts/flightpath-antigravity-hook.js` — only if hooks verified
- [ ] Type/wiring/settings/UI/schema layers per Part B.2
- [ ] `npm run generate-schema`
- [ ] Tests: `AntigravityResponseParser.test.ts`, `AntigravityLogParser.test.ts`; update `harnessRunner.ts`
- [ ] Docs: `docs/harnesses/antigravity-cli.md`, copilot-instructions tables

### Remove Gemini (Part C)

- [ ] Delete harness dir, hook script, doc page (C.1)
- [ ] Type / wiring / settings / UI / schema removals (C.2–C.6)
- [ ] Comment cleanups (C.7)
- [ ] Test removals / re-point to Qwen (C.8)
- [ ] Docs / scripts / dictionary (C.9)

### Verification

- [ ] `npm run typecheck` — zero errors (catches every missed Gemini reference)
- [ ] `npm run compile`
- [ ] `npm test` — existing pass; new Antigravity parser/log tests pass
- [ ] Grep `gemini`/`Gemini`/`GEMINI` over `src/` → only generic/unrelated hits remain
- [ ] Manual: set harness to `antigravity-cli`, confirm "Available", run a 1-step headless workflow (response captured via plain-text stdout), run a 2-step `resumeSession` workflow (UUID resume via `--conversation`)

---

## Estimated Effort

**4–6 hours.** The plain-text parser and exit-based completion make Antigravity *simpler* than Gemini was (no stream-json, no settings.json hook plumbing, no MCP tracker). The Gemini removal is mechanical but touches ~20 `src` files — lean on `npm run typecheck` to find every site. The main risk is the unverified interactive-hook path (A.6); ship headless first, add interactive hooks in a follow-up if `~/.gemini/config/hooks.json` proves usable.
