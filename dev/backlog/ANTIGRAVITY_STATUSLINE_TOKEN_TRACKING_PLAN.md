# Antigravity Statusline Token/Context-Window Tracking Plan

**Status:** Researched and verified / ready for implementation
**Created:** July 30, 2026
**Related:** `HARNESS_USAGE_TRACKING_PLAN.md` (proposes the same status-line-as-collector
pattern for Claude Code; this plan is the Antigravity equivalent), `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`,
`dev/implemented/LIVE_CONTEXT_WINDOW_PLAN.md` (already-shipped live-context-bar
infrastructure for the other six harnesses; this plan is what makes Antigravity the
seventh — see "Live Context Window Integration" below)

---

## Problem

Antigravity (`agy`) is the only harness in `HARNESS_IDS` with no working context-window
signal. `AntigravityLogParser` already has the plumbing — `AntigravityLogEvent.contextWindowUsedTokens`/
`contextWindowSize`/`outputTokens` fields exist and are *consumed* (lines 358–366,
838–857) to build `TokenUsage` — but nothing in `src/core/harness/antigravity/` ever
*assigns* `contextWindowUsedTokens`. There is no log source it can be scraped from:
unlike Copilot's OTel exporter, Codex's `token_count` rollout events, or Claude's
transcript `message.usage`, agy's `transcript_full.jsonl`/`cli-*.log` carry no
per-turn token accounting today. Every agy run in ctrlyoke shows an empty/zero
context bar.

Google's CLI statusline feature (https://antigravity.google/docs/cli/statusline) is a
real, working side channel for exactly this data — confirmed empirically below, not
just from docs.

---

## Research Findings (empirically verified against installed agy 1.1.8)

### Configuration surface

- Global-only, at **`~/.gemini/antigravity-cli/settings.json`** (`AntigravitySettings`
  in Go) — **not** `~/.gemini/config/` where `hooks.json`/`mcp_config.json` already
  live (see `harness-cli-providers.instructions.md`). A new global file to manage.
- Shape:
  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "<path to executable>"
    }
  }
  ```
- No project/workspace-scoped variant was found. Binary string search for
  `.agents/settings`, "project settings.json", "workspace settings" found nothing tying
  those to statusline; the only project-scoped settings.json references in the binary
  are about *permission* persistence, unrelated to statusLine.

### Single value only — confirmed two ways

1. Docs describe one `statusLine` object, no array/list form.
2. Reverse-engineered from `agy.exe` (Go binary, no shell/JSON schema files shipped —
   there's nothing to read but the binary itself): the struct field is
   `StatusLine *types.StatusLineConfig json:"statusLine,omitempty"` (a single pointer,
   not a slice like the neighboring `[]store.deferredOutput`), the setter is
   `(*Manager).SetStatusLineConfig` (singular, not `Add`/plural), and the runtime holds
   exactly one `*store.StatusLineRunner` on the `Manager`. There is no ref-counted or
   keyed multi-entry mechanism anywhere in the binary.

**Conclusion: ctrlyoke must treat this exactly like a single shared global resource**,
the same shape of problem as Qwen's shared `.qwen/settings.json` state
(`harness-cli-providers.instructions.md`'s `<statefulProviders>` section) — register/
unregister per workflow through a ref-counted tracker, not a per-workflow value.

### Payload (stdin JSON → script; formatted string ← stdout)

Captured a real payload from a live `agy --prompt-interactive` run against
`gemini-3.6-flash-low`:

```json
{
  "cwd": "...", "session_id": "...", "conversation_id": "...",
  "transcript_path": "...\\brain\\<id>\\.system_generated\\logs\\transcript.jsonl",
  "model": { "id": "Gemini 3.6 Flash (Low)", "display_name": "...", "effort": "low" },
  "workspace": { "current_dir": "...", "project_dir": "..." },
  "version": "1.1.8",
  "context_window": {
    "total_input_tokens": 151,
    "total_output_tokens": 5,
    "context_window_size": 1048576,
    "used_percentage": 0.0144,
    "remaining_percentage": 99.986,
    "current_usage": {
      "input_tokens": 17826, "output_tokens": 1,
      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0
    }
  },
  "exceeds_200k_tokens": false,
  "product": "antigravity",
  "quota": {
    "3p-weekly": { "remaining_fraction": 0.991, "reset_time": "...", "reset_in_seconds": 283900 },
    "gemini-weekly": { "remaining_fraction": 1, "reset_time": "...", "reset_in_seconds": 604800 }
  },
  "agent_state": "initializing",
  "sandbox": { "enabled": false },
  "plan_tier": "Antigravity Starter Quota",
  "email": "...",
  "terminal_width": 120
}
```

Key points for the data model:

- `conversation_id` **is the same conversation/session ID** `AntigravityCliProvider`
  already tracks (`extractSessionIdFromLogs`, `readSessionIdFromLastConversations`).
  This is a much more reliable session-ID source than the existing
  `last_conversations.json`-cache-then-log-scrape fallback (see the
  `extractSessionIdFromLogs` gotcha in `harness-cli-providers.instructions.md`) and
  could retire that fragile path as a side benefit.
- `context_window.total_input_tokens`/`total_output_tokens`/`context_window_size`/
  `used_percentage` map directly onto the existing `contextWindowUsedTokens`/
  `contextWindowSize`/`outputTokens` fields the parser already expects.
- `context_window.current_usage` gives the **last-turn** granular breakdown (input/
  output/cache-creation/cache-read), directly comparable to what Copilot's OTel
  `gen_ai.usage.*` and Codex's `token_count` events already provide per-turn — this is
  the richer, more useful field for `TokenStats`, not the cumulative `total_*` pair.
- `agent_state` (`initializing`/`thinking`/`working`/`tool_use`/`idle`/...) is a live
  activity signal ctrlyoke doesn't have today for Antigravity at all — a secondary
  win, not just token counts.
- `quota.*` gives per-plan-tier reset windows, same category of data
  `HARNESS_USAGE_TRACKING_PLAN.md` wants for other harnesses' "last-known provider
  quota."

### Fires in both interactive and headless mode

Verified both `agy --prompt-interactive "..." --model gemini-3.6-flash-low` and
`agy --print "..." --model gemini-3.6-flash-low` invoke the statusline script — 10–11
payloads captured in each ~20s run. It is **polled on a fixed ~300ms cadence**, not
purely event-driven per turn/tool-call — confirmed by consecutive payload timestamps.
This means:

- No PTY/interactive-only wiring is required — headless runs (agy's primary ctrlyoke
  execution mode today) get live data too.
- A short headless run's **process can exit before `agent_state` ever reaches a
  terminal value** (`idle`/similar) — in one headless test the last captured payload
  still showed `agent_state: "initializing"` even though `current_usage` already held
  the real final turn numbers (9680 input / 8140 cache-read tokens). **Do not gate
  "final usage" on `agent_state`** — the collector should just always keep the most
  recently written snapshot as current/authoritative; there's no reliable end marker
  from the payload alone.
- **Confirmed genuinely live mid-turn, not just repeated identical polls**: in the
  headless capture, records 0–8 (the first ~2.4s) all read `total_input_tokens: 0`;
  records 9–10 jump to real numbers with `total_output_tokens` growing 1→4 between the
  last two polls, i.e. the payload changed twice in the final 600ms while the model's
  response was still being generated. This directly confirms agy updates the payload
  incrementally as a turn progresses, not just once per turn — exactly the
  "fires mid-stream" property `LIVE_CONTEXT_WINDOW_PLAN.md` requires of every other
  harness's context source (see its "Current State" table). Antigravity qualifies.

### Command execution has the same quoting bug as hooks

Setting `command` to a quoted path with a space
(`node "C:/.../dir with space/statusline-test.js"`) reproduced the exact
`Cannot find module '...\"C:\\...'` failure already documented for
`AntigravityNotificationMonitor`'s hook commands — `cli.log` logged
`statusline: command failed: exit status 1 (stderr: node:internal/modules/cjs/loader...)`.
agy's statusline command is parsed with the same naive whitespace-split, no-shell-quoting
convention as hook commands (confirmed via `statusline_runner.go` log line prefix,
different Go file than the hook caller, but same broken quoting behavior). **The
statusline script path must be unquoted, forward-slash, absolute, and contain no
spaces** — reuse the existing `buildNodeCommand(scriptPath, ..., /*quoted*/ false)`
convention `AntigravityNotificationMonitor` already established for hooks, do not
special-case this.

A broken/missing statusline command does **not** crash agy — it degrades silently
(TUI/headless output is unaffected, only the log line above appears). Safe to treat
registration failures as non-fatal.

### Settings file lifecycle risk

agy rewrites the entire `~/.gemini/antigravity-cli/settings.json` on its own (keys were
observed re-serialized in alphabetical order after a single launch, with no edits from
ctrlyoke in between). This file is **not** purely ctrlyoke-owned state the way
`.agents/mcp_config.json` effectively is — agy itself treats it as mutable and rewrites
it on every launch.

**Verified empirically (2026-07-30) that this is safe in practice:** started a
long-running headless `agy --print` call (a ~5.5s, 15-poll run), and while it was
confirmed still executing (background PID alive), rewrote `settings.json`'s
`statusLine.command` mid-flight to point at a second test script. All 15 payloads for
that run landed in the *original* script's log; the second script's log file was never
even created. **agy reads and caches `statusLine.command` once at process startup and
never re-reads it for that process's lifetime** — a second, concurrently-running agy
process rewriting the file does not affect an already-running process's already-loaded
statusline command. The only real race window is the ordinary one ctrlyoke already
controls: writing the desired value before spawning `agy`, serialized against other
ctrlyoke writers via the tracker's mutex (section 1). No irreducible race remains.

---

## Proposed Design

### 1. Ref-counted single-value tracker (new, modeled on `SettingsJsonMcpTracker`)

`SettingsJsonMcpTracker` already solves "shared mutable global JSON file, multiple
parallel workflows, baseline preservation, atomic writes, async mutex" — but its data
shape is a *named/keyed* collection (`mcpServers`), and `statusLine` is a single
un-keyed field. Add a small sibling, e.g. `SettingsJsonSingleValueTracker` (or extend
`SettingsJsonMcpTracker` with a second lease type alongside its existing
`registerPermissionPolicy`/`unregisterPermissionPolicy` pair, which already does
almost exactly this: capture baseline value, apply while ≥1 owner, restore when the
last owner releases, warn-and-preserve if the user hand-edited the value while
ctrlyoke held the lease). Reusing the permission-lease machinery directly (generalizing
it from `settings.permission` to an arbitrary top-level key) is probably less code than
a new class.

Lifecycle:

- `registerWorkflow(workflowKey)`: capture baseline `statusLine` value (once), write
  ctrlyoke's wrapper script path if not already the active value, increment owner set.
- `unregisterWorkflow(workflowKey)`: remove from owner set; when empty, restore the
  baseline value (or delete the key if none existed before), matching
  `restorePermissionLease`'s "warn and preserve if user changed it meanwhile" behavior.
- Needs a **process-level liveness fallback**, not just in-memory refcounts: if the
  extension host crashes/reloads mid-workflow, an in-memory Map singleton loses the
  registration and never restores the user's setting. `hooks.json` avoids this because
  each workflow's hook group is independently keyed and simply becomes orphaned/inert
  garbage if cleanup never runs; `statusLine` is a single value so an orphaned
  registration would **permanently leave ctrlyoke's script installed** even after every
  workflow ends. Mitigate with either (a) an extension-activation-time sweep that
  restores/clears the value if no ctrlyoke workflows are currently tracked as running,
  or (b) writing a small marker file (PID + timestamp) alongside the baseline snapshot
  that a startup check can use to detect a stale registration from a dead process.

### 2. Correlation token, not `conversation_id`, for the snapshot filename

The snapshot file can't be keyed by `conversation_id` because ctrlyoke doesn't know
that value until the *first* statusline payload arrives — which is exactly the value
we want to bootstrap session-ID discovery from (see "Session ID Discovery
Replacement" below). And keying by `workspace.current_dir`/`cwd` alone is ambiguous
when two ctrlyoke workflows launch `agy` concurrently in the same workspace root
(a real case ctrlyoke already supports for other harnesses).

Instead, generate a random per-invocation token (e.g. a UUID) in
`AntigravityCliProvider.buildCliArgs`/spawn setup, before the `agy` process is
launched, and set it as an env var on the spawned process
(`CTRLYOKE_AGY_STATUSLINE_TOKEN=<uuid>`) — the same spawn-env mechanism already used
for `getInteractiveSpawnEnv()`/`buildOtelSpawnEnv()` elsewhere in the harness layer.
**Verified empirically (2026-07-30):** ran `agy --print` with `CTRLYOKE_TEST_TOKEN=hello-env-inheritance-12345`
set on the parent process; the statusline child process's `process.env.CTRLYOKE_TEST_TOKEN`
was present and correct in all 10 captured payloads for the run. agy's `os/exec.Command`
does inherit the parent environment into the statusline child unmodified — the
correlation-token design is safe to build on directly, no fallback to the
`conversation_id`-after-first-payload scheme needed.

The wrapper script reads its own token from `process.env.CTRLYOKE_AGY_STATUSLINE_TOKEN`
and writes to `.ctrlyoke/temp/agy-statusline-<token>.json` — a filename ctrlyoke knows
*before* spawning, so it can watch for that exact path (`fs.watch` on the directory, or
a short poll loop) instead of discovering it after the fact.

### 3. ctrlyoke's own statusline script as a wrap-and-forward proxy

To handle "user already has their own statusline configured" without needing Google to
support multiple values:

- On first registration, if a baseline `command` existed, save it (already required for
  restore-on-cleanup above).
- ctrlyoke's installed script:
  1. Reads stdin JSON once.
  2. Writes the parsed payload to `.ctrlyoke/temp/agy-statusline-<token>.json` (token
     from its own env, see above) — atomically (write to a temp path + rename, matching
     `writeFileAtomic` already used elsewhere) so the sidecar watcher never reads a
     half-written file mid-poll.
  3. If a baseline user command was captured, spawns it, forwards the same stdin bytes
     to it unmodified, and relays its stdout back to agy verbatim — the user's visual
     statusline is unaffected. **Timeout the forward at ~200ms** (comfortably under the
     observed ~300ms poll cadence): if the user's script hasn't responded by then, skip
     forwarding for that poll and let step 4's fallback render instead. ctrlyoke's own
     snapshot write (step 2) happens unconditionally and is never blocked by the
     forward — a slow/hung user script degrades agy's visible statusline, never
     ctrlyoke's own data collection.
  4. If there was no baseline command, or the forward timed out, emit ctrlyoke's own
     branded status string (see "Custom Branded Statusline" below) instead of leaving
     agy's line blank.
- This mirrors the merge approach the user suggested, and avoids needing Google to add
  multi-statusline support.

### 4. Collector on the ctrlyoke side

- Both interactive and headless execution use one unified sidecar (not two separate
  paths): after spawning `agy` with the token env var set, watch
  `.ctrlyoke/temp/agy-statusline-<token>.json` for creation/changes (`fs.watch`,
  matching the watcher pattern `LIVE_CONTEXT_WINDOW_PLAN.md`'s headless "context
  sidecar" already established for other harnesses — but here it's watching
  ctrlyoke's own small JSON file instead of scanning the CLI's multi-MB log, so no
  `discoverSessionLog`-style retry-and-scan loop is needed at all).
- Populate `AntigravityLogEvent.contextWindowUsedTokens`/`contextWindowSize`/
  `outputTokens` from `context_window.total_input_tokens` (+ output) /
  `context_window.context_window_size`, and separately surface
  `context_window.current_usage` as the per-turn `TokenStats` breakdown (input/output/
  cache-creation/cache-read) — don't conflate the cumulative and last-turn numbers.
- Because polling is ~300ms and not turn-aligned, treat "most recent snapshot at the
  time ctrlyoke reads it" as good enough — no need to correlate specific payloads to
  specific turns beyond what `current_usage` already gives per-poll.
- Snapshot files need the same cleanup treatment as other workflow artifacts
  (`getAdditionalCleanupFilePaths()`/`cleanupWorkspaceArtifacts()`).

### 5. Settings surface

Expose an opt-out (default-on once implemented, given it's a real regression-free
capability gain) similar to other harness-specific toggles, in case a user's own
statusline script is fragile enough that wrap-and-forward causes problems, or they
simply don't want ctrlyoke touching this global file at all.

---

## Session ID Discovery Replacement

`AntigravityCliProvider.extractSessionIdFromLogs` today does a cache lookup
(`readSessionIdFromLastConversations`, keyed off `last_conversations.json`, known to
miss under parallel workflows or before it flushes) then falls back to scraping the
newest `cli-*.log` for `Print mode: conversation=` / `Starting conversation update
stream for` markers — both documented as fragile in
`harness-cli-providers.instructions.md`. The statusline snapshot makes both
unnecessary when the feature is enabled:

- The sidecar (section 4 above) is already watching
  `.ctrlyoke/temp/agy-statusline-<token>.json` from the moment `agy` is spawned.
  `conversation_id` is present in **every** payload including the very first one
  (observed present even while `agent_state` was still `authenticating`), so the
  first snapshot write gives ctrlyoke the session ID directly — typically within
  the first ~300ms poll tick, i.e. faster than either existing method.
- Make this the **primary** source: have `extractSessionIdFromLogs` check for a fresh
  snapshot file first (when the statusline feature is registered/enabled for this
  workflow) before falling through to the existing cache-then-log-scrape path. Keep
  the old path as the fallback for when the user has opted the statusline feature
  out, or for any window before the sidecar's first snapshot write lands — don't
  delete it, but it stops being the common case.
- This directly addresses wanting session-ID retrieval to be less fragile: it
  replaces "poll a cache file that's known to race, then regex-scrape a
  multi-megabyte log" with "read one small JSON file ctrlyoke wrote the schema for."

---

## Live Context Window Integration

`LIVE_CONTEXT_WINDOW_PLAN.md` already shipped the full pipeline for six harnesses:
`ILogParser.extractLiveContextWindow(event) → CliLogMonitor.processEvent →
onContextWindowUpdate → webview message → workflowStore.liveContextWindow →
WorkflowStepItem`'s vertical fill bar, plus a headless "context sidecar" pattern for
harnesses whose live signal only flows through log files.

Confirmed above: agy's statusline payload **is** a live, mid-turn-updating signal
(records changed twice within the final 600ms of a short headless run), so Antigravity
qualifies for the same live bar the other six harnesses already have. The integration
is simpler than a typical headless sidecar, because there's no `discoverSessionLog`
scan-and-retry step — the sidecar in section 4 above already knows its exact file path
before the process even starts:

- **Interactive and headless use the identical sidecar** (unlike the other six
  harnesses, which needed a separate `startContextWindowSidecar` workaround
  specifically for headless mode because their live signal only exists in the same
  log files interactive mode already watches). For Antigravity, statusline fires
  identically in both modes, so one code path covers both — no headless-specific
  branch needed at all.
- `AntigravityLogParser.extractLiveContextWindow` reads from the watched snapshot file
  (via the sidecar's `fs.watch` callback) rather than from `agy`'s own log/transcript
  events, unlike every other harness's implementation of that method. Returns
  `{ used: context_window.total_input_tokens + total_output_tokens, size:
  context_window.context_window_size }` on each snapshot change — reuses
  `LIVE_CONTEXT_WINDOW_PLAN.md` Layers 3–7 (`CliLogMonitor` wiring, webview message,
  store, `WorkflowStepItem` bar) completely unchanged.
- Add a row for Antigravity to that plan's "Current State" harness table once
  implemented: `Antigravity | ctrlyoke statusline snapshot (own sidecar, not agy's log) | YES — every ~300ms poll, both interactive & headless`.

---

## Custom Branded Statusline (Discoverability)

Confirmed from the docs: statusline output supports **full ANSI color codes**, and
Google's own example script "renders state badges, handles active branches, and
formats context window progress bars dynamically" — this is a real, arbitrarily
stylable line in agy's own TUI chrome, not just a plain-text hook.

When ctrlyoke owns the statusline (no baseline user script to forward to, or the
forward times out), render a real ctrlyoke-branded line instead of a placeholder —
e.g. something in the shape of:

```
ctrlyoke ⚡ gemini-3.6-flash-low · 12.4k/1.0M ctx (1.2%) · quota 98% · idle
```

using the same color-threshold logic already established for the webview's context
bar (neutral / warning / danger bands) via ANSI SGR codes, plus `agent_state` as a
short icon/word. This turns the feature into its own advertisement: a user who has
never touched ctrlyoke's Antigravity settings sees agy's status line change the moment
ctrlyoke starts managing it, notices it's clearly ctrlyoke-branded, and has a concrete
reason to go find the (otherwise easy-to-miss) global toggle mentioned in section 5 —
much better discoverability than a silent background feature. Low priority relative to
the data-collection path, but cheap to add once the wrapper script exists since it's
just a stdout format choice, and worth keeping in scope rather than deferring
indefinitely.

---

## Open Questions

None blocking. Every question raised during research has been verified empirically or
resolved by a product decision:

- ~~Does agy re-read `statusLine.command` live, or only at startup?~~ — **verified
  2026-07-30**: read once at startup and cached for the process's lifetime; a
  concurrent rewrite mid-flight does not affect an already-running process. See
  "Settings file lifecycle risk" above.
- ~~Env inheritance for the correlation token~~ — **verified 2026-07-30**: see
  section 2 above.
- ~~Settings file creation when absent~~ — resolved: assumed create-on-write like
  agy's other config files, consistent with how it already behaves for hooks/MCP
  config.
- ~~Wrap-and-forward timeout~~ — resolved: ~200ms (section 3).
- ~~Session-ID source~~ — resolved: statusline snapshot becomes primary, existing
  cache/log-scrape path retained only as fallback (see "Session ID Discovery
  Replacement").

One thing worth a sanity-check during implementation rather than pre-verifying further:
the create-on-write assumption for a brand-new `~/.gemini/antigravity-cli/settings.json`
(no prior agy run on the machine) — low-risk, standard pattern already used for every
other ctrlyoke-managed config file, not worth spending more research time on.

---

## Implementation Sketch (rough sizing, not a committed plan)

1. Generalize `SettingsJsonMcpTracker`'s permission-lease pattern (or add a sibling) for
   a single arbitrary top-level key, targeting `~/.gemini/antigravity-cli/settings.json`.
2. Add `ctrlyoke-antigravity-statusline.js` under the same `out/scripts/` location as
   `ctrlyoke-antigravity-hook.js`, implementing wrap-and-forward (with the ~200ms
   timeout) + atomic snapshot-file writing + the ctrlyoke-branded ANSI fallback output.
3. Generate the per-invocation correlation token and set
   `CTRLYOKE_AGY_STATUSLINE_TOKEN` in the spawn env in `AntigravityCliProvider`
   (env inheritance into the statusline child process already verified).
4. Wire tracker registration into `AntigravityCliProvider` alongside the existing
   `buildNotificationHookArgs`/`buildHeadlessUserHookArgs` calls, and unregistration
   into `cleanupWorkspaceArtifacts`.
5. Add the startup sweep for orphaned registrations (extension activation).
6. Build the unified sidecar (interactive + headless, one code path) that watches
   `.ctrlyoke/temp/agy-statusline-<token>.json` from spawn time.
7. Wire the sidecar into `extractSessionIdFromLogs` as the primary session-ID source,
   ahead of the existing cache/log-scrape fallback.
8. Implement `AntigravityLogParser.extractLiveContextWindow` reading from the sidecar,
   and extend `LIVE_CONTEXT_WINDOW_PLAN.md`'s harness table — reuses that plan's
   Layers 3–7 unchanged.
9. Populate the existing `contextWindowUsedTokens`/`contextWindowSize`/`outputTokens`
   fields for the final/completed-response path too (not just the live bar), plus a
   per-turn `TokenStats` breakdown from `current_usage`.
10. Settings toggle to disable the whole feature.
