# Status Line Copilot & Qwen Support Plan

> **Status:** Not implemented. Research completed 2026-08-21, including a live, empirical probe
> of GitHub Copilot CLI's real statusline payload on this machine (not just documentation).

**Related:** [`STATUSLINE_USER_CONTROLS_PLAN.md`](../implemented/STATUSLINE_USER_CONTROLS_PLAN.md)
(implemented — enable/disable, custom forward command, `useCtrlyokeStyle`, install/uninstall
lifecycle for Claude/Antigravity), [`STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md`](../implemented/STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md)
(implemented — segment-based format editor, field registry, both explicitly named this
follow-up as out of scope), [`STATUS_LINE_SHARED_FORMAT_TOGGLE_PLAN.md`](STATUS_LINE_SHARED_FORMAT_TOGGLE_PLAN.md)
(not implemented — builds the shared/per-harness format toggle "to already scale cleanly to N
providers"; explicitly does not add Copilot/Qwen itself, i.e. this plan is the companion it's
waiting on).

## Goal

`STATUS_LINE_TRACKING_PROVIDERS` (`src/types/DashboardConstants.ts:36-39`) currently has exactly
two entries — `claude`, `antigravity` — matching the two harnesses whose native CLI supports a
custom statusline command. Both `STATUSLINE_USER_CONTROLS_PLAN.md` and
`STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md` flagged extending this to Copilot CLI and Qwen Code as
a named, deliberately out-of-scope follow-up, "needs its own pass to confirm, per provider: the
statusline config mechanism... and the payload schema." This plan is that pass.

Both target harnesses do support a configurable, command-based statusline in their native CLI —
confirmed below, not assumed. But the two mechanisms differ from each other, and from
Claude/Antigravity's, in ways that are not cosmetic: a nested settings key instead of a flat one
(Qwen), a payload with no rate-limit/quota concept at all (both), and — the one finding that
could only come from actually running the CLI rather than reading its docs — a context-usage
field in Copilot's real payload that is silently wrong if reused via the existing generic
extractor. See Research below.

## Research

### GitHub Copilot CLI

**Not gated behind `--experimental`.** The GitHub issue cited in the original ask
([github/copilot-cli#1311](https://github.com/github/copilot-cli/issues/1311)) is the original
Feb-2026 feature request; it carries no confirmation either way about an experimental gate. What
does confirm it: `copilot help config`'s own `statusLine` entry (verified live, CLI version
`1.0.80`, 2026-08-21) documents it as a normal, non-experimental setting — no `--experimental`
flag, no mention in that entry's caveats, unlike other entries in the same help output that
explicitly do call out an experimental requirement (e.g. `inlineImages`: "Requires the
experimental `INLINE_IMAGES` feature"). The live probe below also worked with no `--experimental`
flag passed anywhere. Closed: no experimental gate needed.

**Settings shape** — flat, top-level, same family as Claude/Antigravity. In
`~/.copilot/settings.json`:
```json
"statusLine": {
  "type": "command",
  "command": "<path or shell command>",
  "padding": 0,
  "refreshInterval": 1
}
```
- `type`: must be `"command"` when set.
- `command`: path to an executable or shell command; receives session JSON on stdin, prints
  status text to stdout. Runs under the platform shell (`cmd.exe` on Windows, `/bin/sh`
  elsewhere) — same execution model `forwardToCommand`/`spawn(..., {shell:true})` already assumes.
- `padding`: left-padding spaces (optional, no ctrlyoke use).
- `refreshInterval`: integer seconds, **minimum `1`**, maximum `2147483`; omitted = refresh only
  on session-state-change events, not on a timer.

**The statusline command only fires inside a genuine interactive TTY session — confirmed by
elimination, not assumed.** Three escalating live attempts against a probe script wired into
`~/.copilot/settings.json`:
1. `copilot -p "..." --allow-all-tools` (headless, `-p`) — exits after one reply; probe never
   invoked.
2. `copilot -i "..." --allow-all-tools` with stdout/stderr piped/redirected (including via
   PowerShell `Start-Process -RedirectStandardOutput`, which still allocates a console but
   replaces its stdout handle with a pipe) — same result, prints the reply and a stats footer
   once, exits; probe never invoked.
3. `copilot -i "..." --allow-all-tools` via `Start-Process` with **no** output redirection (a
   real, un-piped console) — the probe fired repeatedly on the configured 1-second
   `refreshInterval`, capturing real payloads (below) until the process was killed.
   Bare `copilot` with no prompt and no TTY refuses outright: *"No prompt provided. Run in an
   interactive terminal or provide a prompt with -p or via standard in."*

This is a real constraint, not a probing inconvenience: Copilot's statusline is a footer UI
element, and it plainly does not exist as a concept outside a rendered interactive session, the
same way Claude/Antigravity's statuslines don't. **It is not a new risk for ctrlyoke**, though:
`copilot-cli` is already one of the six harnesses ctrlyoke drives through `PtyProcessManager`'s
real pseudo-terminal — the same mechanism that already makes Claude/Antigravity's statuslines work
today. Confirmed as a non-issue for ctrlyoke-orchestrated sessions; only relevant if anyone tries
to reproduce this probe again by piping Copilot's output through a plain (non-pty) subprocess.

**Real captured payload** (from the live probe above, `gpt-5.6-luna`, first turn after model
selection resolved — full shape, not paraphrased):
```json
{
  "cwd": "C:\\dev\\ctrlyoke",
  "session_id": "fadbffd9-fb8e-4a6d-9048-2fcbbd09858b",
  "session_name": "Implement Pong Response",
  "transcript_path": "C:\\Users\\natha\\.copilot\\session-state\\<session_id>",
  "model": { "id": "gpt-5.6-luna", "display_name": "gpt-5.6-luna · high" },
  "workspace": { "current_dir": "C:\\dev\\ctrlyoke" },
  "username": null,
  "remote": { "connected": false },
  "version": "1.0.80",
  "cost": {
    "total_api_duration_ms": 2070,
    "total_lines_added": 0,
    "total_lines_removed": 0,
    "total_duration_ms": 12246,
    "total_premium_requests": 0
  },
  "context_window": {
    "total_input_tokens": 25953,
    "total_output_tokens": 17,
    "total_cache_read_tokens": 0,
    "total_cache_write_tokens": 25950,
    "total_reasoning_tokens": 10,
    "total_tokens": 25970,
    "context_window_size": 1050000,
    "used_percentage": 0,
    "remaining_percentage": 100,
    "remaining_tokens": 1050000,
    "last_call_input_tokens": 0,
    "last_call_output_tokens": 0,
    "current_context_tokens": 26159,
    "displayed_context_limit": 328000,
    "current_context_used_percentage": 8,
    "current_usage": {
      "input_tokens": 25953, "output_tokens": 17,
      "cache_creation_input_tokens": 25950, "cache_read_input_tokens": 0
    }
  },
  "ai_used": { "total_nano_aiu": 650850000, "formatted": "0.65" },
  "allow_all_enabled": false
}
```
Before the first API call completes, `model.id`/`model.display_name` are both `null` — genuinely
observed on the very first tick, not a hypothetical. Any Copilot extractor for `model` must
tolerate this the same way `safeLabel(..., "unknown-model")` already does for other providers.

**No `rate_limits`/`quota` field anywhere in the payload.** Unlike Claude and Antigravity, whose
payloads carry an in-band percentage-of-window quota concept the existing wrapper already parses,
Copilot's statusline payload has nothing structurally equivalent — only `ai_used` (a cumulative
"AI credits used" counter, `total_nano_aiu`/`formatted`) and `cost.total_premium_requests`, neither
of which is a "percent of a window" the way `usage`/`usage1`/`usage2` are defined. **This is not
simply "Copilot's quota data hasn't been found yet"** — real, precise Copilot quota data already
exists in this codebase, just architecturally out of reach here: `CopilotQuotaClient`
(`src/core/harness/copilot/CopilotQuotaClient.ts`) already gets exact bucketed quota
(`premium_interactions`/`chat`/`completions`, used/entitlement/remaining%) via a JSON-RPC call to
a **spawned headless `copilot --headless --stdio` server process**, with a 5-second timeout budget
(`COPILOT_QUOTA_PROBE_TIMEOUT_MS`) — already wired into `CopilotUsageProvider` for `UsageCard.tsx`.
That mechanism cannot be reused inside the statusline wrapper: the wrapper is a **standalone,
Node-builtins-only, sub-second-latency script** (per its own header comment) invoked on every
statusline refresh tick — spawning and RPC-handshaking a second full Copilot process per tick
would be far too slow and expensive for a UI element refreshing every ~1s. **Conclusion: `usage`,
`usage1`, `usage2` have no data source available to the statusline wrapper for Copilot.** See
Decisions below for how the existing tolerance rules already handle this without new code.

**Two different "context usage" numbers exist in the payload, and the existing generic extractor
picks the wrong one.** `contextValues()` (`src/utils/StatuslineFormat.ts:295-317`, shared by
Claude/Antigravity today) computes `used = total_input_tokens + total_output_tokens`,
`size = context_window_size`, i.e. exactly the first triad in the payload above:
`25953 + 17 = 25970` tokens against `context_window_size: 1050000` → **0%** (rounds down from
~2.5%) — which is also literally what the payload's own `used_percentage`/`remaining_percentage`
report (`0`/`100`). But the payload separately carries `current_context_tokens: 26159`,
`displayed_context_limit: 328000`, `current_context_used_percentage: 8` — **8%**, an order of
magnitude different, and it's this second figure (not `used_percentage`) that matches what
Copilot's own native footer displays to the user (the field name literally says "displayed"; the
user's own `~/.copilot/settings.json` on this machine has `footer.showContextWindow: true`).
`context_window_size` (1,050,000, the model's raw max) is not the number a Copilot user thinks of
as "my context window" — `displayed_context_limit` (328,000, evidently a tiered-pricing threshold
for this model) is. Reusing the shared `contextValues()` extractor unchanged for Copilot would
silently show a technically-real but practically-misleading number that diverges from what the
CLI's own UI shows for the same session. **This can only be caught by running the CLI — it is not
visible from documentation or from the schema shape alone**, which is exactly why the probe was
worth doing. See Decisions below.

### Qwen Code

Sourced from official docs (`https://qwenlm.github.io/qwen-code-docs/en/users/features/status-line/`)
plus inspection of a **real, already-configured** `~/.qwen/settings.json` on this machine — not
independently probed live the way Copilot was (out of this plan's research scope as asked;
flagged as residual risk in Open Questions).

**Settings shape — nested, and dual-mode.** In `~/.qwen/settings.json`, under `ui.statusLine`
(**not** a top-level key, unlike Claude/Antigravity/Copilot):
```json
"ui": {
  "statusLine": {
    "type": "preset" | "command",
    // preset mode:
    "items": ["model-with-reasoning", "git-branch", "context-remaining", "..."],
    "useThemeColors": true,
    "hideContextIndicator": false,
    // command mode:
    "command": "<shell command, JSON piped to stdin>",
    "refreshInterval": 1,
    "respectUserColors": false
  }
}
```
Qwen's statusline has **two mutually exclusive modes**: a built-in `"preset"` mode (curated
display items joined with `|`, no external process at all) and a `"command"` mode structurally
equivalent to the other three providers' mechanism. ctrlyoke only ever cares about `"command"`
mode — that's the hook point. `refreshInterval` has the same **minimum-1-second** floor as
Copilot's; command-mode invocations time out after 5 seconds (Qwen-side, not ctrlyoke's own
200ms forward timeout, which still applies to whatever `customCommand` ctrlyoke forwards to).

**A real machine already has `type: "preset"` configured — this is not a hypothetical edge
case.** This exact machine's `~/.qwen/settings.json` currently has:
```json
"ui": { "statusLine": { "type": "preset", "useThemeColors": true,
  "items": ["project-name", "git-branch", "model-with-reasoning", "context-used"] } }
```
`StatuslineManager.extractCommand` (`src/core/harness/shared/StatuslineManager.ts:175-188`)
already returns `undefined` for a value with no string `command` field, which a `type: "preset"`
object never has — so today's install logic already tolerates this shape mechanically, treating
it as "nothing to capture." But per `STATUSLINE_USER_CONTROLS_PLAN.md` Decision 6, "nothing to
capture" also means `useCtrlyokeStyle` defaults to `true` — i.e. ctrlyoke's first install would
**silently replace this user's already-working, hand-configured preset statusline** with
ctrlyoke's branded line, with no distinct signal beyond the generic "showing its own statusline
now" install notification that a brand-new, never-configured user also gets. That's a materially
different situation (an existing, working, non-forwardable configuration being overwritten,
rather than empty space being filled) — decided not to auto-replace it at all; see Decision 8.

**JSON payload structure** (per docs, not independently reproduced):
- `session_id`, `version`, `model.display_name` (**no `model.id`** documented for Qwen — the
  existing `MODEL` field already tries `id` before falling back to `display_name`
  (`StatuslineFormat.ts:532-538`), so this needs no code change, just confirmation it degrades
  correctly).
- `context_window.{context_window_size, used_percentage, remaining_percentage, current_usage,
  total_input_tokens, total_output_tokens}` — **same key names as Claude/Antigravity's existing
  shape**, per the docs summary. Unlike Copilot, this suggests Qwen's `context` field can likely
  reuse the existing generic `contextValues()` extractor unchanged — flagged as an assumption to
  verify with a live probe before shipping, precisely because Copilot's version of "matches the
  existing shape" turned out to be misleading once actually run.
- `workspace.current_dir` — **no top-level `cwd`** documented for Qwen, unlike the other three
  providers (Copilot confirmed live; Claude/Antigravity confirmed by the original plan's own
  research). The `CWD` field extractor needs a fallback chain (`cwd ?? workspace.current_dir`)
  rather than a Qwen-specific branch — see Decisions.
- `git.branch` — Qwen's payload **already includes the current git branch directly**, unlike the
  other three providers, where ctrlyoke's `branch` field is computed by reading `.git/HEAD` off
  disk itself (Decision 15, `STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md`). For Qwen this is strictly
  cheaper to read straight from the payload than to duplicate a filesystem git read the CLI has
  already done — see Decisions.
- No rate-limit/quota field of any kind — only `metrics.models.<id>` (per-model API/token stats)
  and `metrics.files` (lines added/removed). Same conclusion as Copilot: `usage`/`usage1`/`usage2`
  have no payload-provided data source for Qwen either.
- Qwen-only, no cross-provider equivalent, **not added to the registry** (same exclusion rule as
  the original plan applied to Claude's `cost`/`prompt_id`/etc.): `worktree`, `vim.mode`,
  `metrics.files`, `metrics.models.<id>` detail.

### Field availability across all four providers (updated)

The original plan's registry (`STATUS_LINE_FIELD_REGISTRY`, `StatuslineFormat.ts:20-81`) is a
single global vocabulary with no per-provider gating — a deliberate simplification that held
because both existing providers (Claude, Antigravity) happened to support every field. That
invariant does not survive adding Copilot/Qwen unchanged; three fields need either a corrected
extractor or an accepted "structurally always empty for these two" outcome:

| id | claude | antigravity | copilot | qwen | note |
| --- | --- | --- | --- | --- | --- |
| `model` | ✓ | ✓ | ✓ (nullable pre-first-turn) | ✓ (`display_name` only, no `id`) | existing fallback chain already handles both gaps |
| `context` | ✓ | ✓ | ✓ **but needs a Copilot-specific extractor** (`current_context_tokens`/`displayed_context_limit`, not the generic pair) | ✓ assumed (same key names per docs — needs live verification) | see Research above |
| `usage`/`usage1`/`usage2` | ✓ | ✓ | **no data** (renders `—` / drops silently, existing tolerance) | **no data** (same) | real Copilot quota exists but is architecturally unreachable here — see Research |
| `version` | ✓ | ✓ | ✓ | ✓ | no change |
| `cwd` | ✓ (`payload.cwd`) | ✓ (`payload.cwd`) | ✓ (`payload.cwd`, confirmed live) | **`payload.workspace.current_dir` only** | needs a fallback chain, not a new field |
| `sessionId` | ✓ | ✓ | ✓ | ✓ | no change |
| `branch` (locally computed) | computed via `.git/HEAD` | computed via `.git/HEAD` | computed via `.git/HEAD` | **could read `payload.git.branch` directly instead** | see Decisions — optional optimization, not required |
| `date`/`time` (locally computed) | ✓ | ✓ | ✓ | ✓ | provider-agnostic, no change |

## Decisions

1. **Extend `STATUS_LINE_TRACKING_PROVIDERS` and `STATUS_LINE_FORMAT_PROVIDERS` to four entries
   each**, adding `COPILOT: "copilot"` and `QWEN: "qwen"` (short ids, matching the existing
   `claude`/`antigravity` convention of dropping the `-cli` suffix from `HARNESS_IDS`). These are
   two separate closed unions today (`DashboardConstants.ts:36-39` vs `StatuslineFormat.ts:227-233`)
   for settings/tracking vs. formatting concerns respectively — keep that separation, just grow
   both in lockstep, same as the existing two entries already are.
2. **Extend `StatusLineTrackingHarnessId`** (`DashboardConstants.ts:674-684`) to include
   `HARNESS_IDS.COPILOT_CLI` and `HARNESS_IDS.QWEN_CLI`, and `isStatusLineTrackingHarnessId`'s
   check accordingly. Extend `StatuslineManager.providerForHarness`'s switch
   (`StatuslineManager.ts:53-62`) with the two new cases.
3. **Generalize `SettingsJsonMcpTracker`'s persistent-value key from a flat top-level property to
   a dotted path**, to support Qwen's `ui.statusLine` nesting without a bespoke Qwen-only code
   path. `STATUS_LINE_SETTING_KEY` stays `"statusLine"` for Claude/Antigravity/Copilot (a
   single-segment "path"); Qwen's definition uses `"ui.statusLine"`. Scope the change narrowly:
   `installPersistentValue`/`uninstallPersistentValue` (`SettingsJsonMcpTracker.ts:540-611`) are
   the only two methods statusline tracking uses on this class — add small `getAtPath`/
   `setAtPath`/`deleteAtPath` helpers used only by those two methods (creating intermediate
   objects like `ui: {}` on write if absent), and leave every other flat-key user of this class
   (MCP server leases, the `permission` key) untouched. `SettingsJsonPersistentValueKey`'s type
   widens from a literal union to `string`, since it's now a path expression, not a fixed key
   name — the two-provider case became a four-provider case with one of the four genuinely
   different in shape, and a generalized path is cheaper and safer than special-casing.
4. **Copilot's `context` field needs its own extractor, not the shared `contextValues()`.** Per
   the Research finding above, reusing the generic extractor would silently show
   `context_window_size`/`used_percentage` (the raw model max, ~0% in the captured example)
   instead of `displayed_context_limit`/`current_context_used_percentage` (the CLI's own
   user-facing figure, 8% in the same example) — a materially misleading number, not a rounding
   nuance. Add a Copilot-specific branch: `used = current_context_tokens`,
   `size = displayed_context_limit`, falling back to the generic pair only if either is absent
   from a given payload (keeps the same "never crash on a malformed/partial payload" posture the
   rest of this module already has).
5. **`cwd` (and the `branch` field's repo-root lookup) gain a fallback chain: `payload.cwd ??
   payload.workspace?.current_dir`**, rather than a Qwen-specific branch. This is strictly a
   generalization of the existing single-key read at `StatuslineFormat.ts:564-570` and mirrors
   the fallback-chaining style the `model` field extractor already uses
   (`safeLabel(model.id, safeLabel(model.display_name, ...))`). Both the `CWD` field renderer and
   the locally-computed `branch` field's on-disk `.git/HEAD` lookup must resolve "the workspace
   directory" through this same one helper — implementing it twice (once per call site) would
   silently drift the moment either one changes.
6. **`usage`/`usage1`/`usage2` need no new code to handle Copilot/Qwen's missing data — the
   existing absence-tolerance already covers it.** `quotaPercentage`/`usageWindows`
   (`StatuslineFormat.ts:338-414`) already branch on `provider` and already return
   `undefined`/`[]` when the expected source key (`rate_limits`/`quota`) isn't present — extending
   their `provider === CLAUDE ? ... : ...` binary branches to a `switch` over all four providers,
   with `copilot`/`qwen` falling through to "no source key, return undefined/[]," is the entire
   change needed. `USAGE` already renders `"— "` when `quotaPercentage()` is `undefined`
   (`StatuslineFormat.ts:543-550`); `USAGE_1`/`USAGE_2` already drop silently when their window is
   `undefined` (Decision 4, `STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md`). No schema change, no new
   "field unavailable for this provider" concept — the registry stays provider-agnostic by
   design (Decision 2 of the format plan explicitly rejected a per-provider availability column),
   and this is exactly the kind of gap that design was already built to absorb gracefully.
7. **Keep one shared `DEFAULT_STATUS_LINE_FORMAT` for all four providers — do not fork a
   Copilot/Qwen-specific default.** The tempting alternative (drop `usage` from the default for
   the two providers that can never populate it) would recreate exactly the kind of per-provider
   default-format branching `STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md`'s Decision 3 was proud to
   have eliminated ("both providers now share one identical default array... a further
   simplification the 'shared fields only' constraint buys for free"). Accept, explicitly, that a
   brand-new Copilot/Qwen user's default line will always show `usage —` until they edit the
   format — a one-time, discoverable rough edge (the format editor's own live preview will show
   it immediately), not a hidden one. This is the same class of deliberate, called-out trade-off
   the original plan made repeatedly rather than adding a special case; revisit only if real user
   feedback says the dash reads as broken rather than "nothing to show here."
8. **Qwen's `type: "preset"` collision: don't auto-replace it — skip the write, disable tracking
   for that harness, and let re-enabling be the opt-in.** Considered and rejected a general
   pre-install consent dialog (would need new synchronous confirm plumbing, and would only cover
   the VS Code host — CLI/MCP-server/hosted-webview would still write first regardless). This is a
   narrower, purely mechanical fix that needs none of that:
   - **Detection**: `hadKey === true` and `extractCommand(preexistingValue, hadKey) === undefined`
     and the existing value isn't already ctrlyoke's own command (`isCtrlyokeStatuslineCommand`,
     `StatuslineManager.ts:190-203`) — i.e. *something* is configured, but it isn't a forwardable
     command and isn't ctrlyoke's own. Reachable in practice only via Qwen's `type: "preset"` mode
     today, but the check itself isn't Qwen-specific.
   - **Behavior on detection**: skip the write entirely (the preset config is left byte-for-byte
     untouched) and, in the same locked capture step, set `enabled: false` for that harness's
     `permissions.statusLineTracking.<provider>` — reusing the exact gate that already exists:
     every provider's registration path already checks `getStatusLineTrackingSettings(...).enabled`
     before calling `install()` at all (confirmed at `ClaudeCliProvider.ts:408-414`, same pattern
     for Antigravity), so setting it `false` here is sufficient on its own to stop ctrlyoke from
     retrying — and re-notifying — on every subsequent run. No new "already asked" flag needed.
   - **Notification** (fires once, at the moment `enabled` flips to `false` this way): _"Qwen
     already has a status line configured (a "preset" set up outside ctrlyoke) — ctrlyoke won't
     replace it automatically, and has turned off its own Qwen status line tracking. Enable it
     again in Settings → Status Line whenever you'd like ctrlyoke's branded line instead."_
   - **The opt-in is the existing `enabled` toggle itself, not a new button.** If the user later
     flips `enabled` back to `true` in Settings, that's a real, explicit action distinct from
     ctrlyoke's own automatic first-run attempt — the very next registration attempt proceeds and
     overwrites the preset normally, no separate "force" flag or confirmation UI required. This
     works because the disable was ctrlyoke's own doing for a legible, stated reason; re-enabling
     it is the user knowingly reversing that specific decision.
   - **Plumbing**: `SettingsJsonMcpTracker.installPersistentValue`'s `capture` callback
     (`SettingsJsonMcpTracker.ts:544`, currently `Promise<void>`) needs to be able to veto the
     write that unconditionally follows it today (`settings[key] = value`, line 568) — widen its
     return type to `Promise<{ proceed?: boolean }>` (default `true`/unset, so the existing
     Claude/Antigravity/Copilot capture usage — which never needs to veto — is unaffected) and have
     `installPersistentValue` skip the write and return a new `kind: "declined"` result when it
     resolves `{ proceed: false }`. This is the one piece of shared machinery that needs new
     capability; everything else in this decision is composed from behavior that already exists.
9. **Wrapper scripts and refresh cadence**: add `ctrlyoke-copilot-statusline.js` and
   `ctrlyoke-qwen-statusline.js`, structurally identical to `ctrlyoke-claude-statusline.js`
   (`src/scripts/ctrlyoke-claude-statusline.js` — a ~60-line pass-through into the shared
   `ctrlyoke-statusline-wrapper.js`), each parameterizing `STATUSLINE_PROVIDERS.COPILOT`/`.QWEN`.
   Install both providers with `refreshInterval: 1` (the shared minimum both CLIs enforce) rather
   than omitting it (event-only refresh) — matching Antigravity's existing rationale for polling
   rather than waiting purely on session-state-change events, so `writeSnapshotAtomic`'s on-disk
   snapshot (which feeds `UsageCard`/settings UI freshness, not just the visible line) doesn't go
   stale during an idle session. Document explicitly that this is **coarser** than Antigravity's
   native ~300ms cadence — neither CLI supports sub-second refresh — so "last observed" data for
   these two providers can lag up to ~1s longer than Antigravity's, which is expected, not a bug
   to chase.
10. **Reuse the shared 200ms `forwardToCommand` timeout unchanged** (`STATUSLINE_USER_CONTROLS_PLAN.md`'s
   Wrapper Script Consolidation) for both new providers — no evidence either CLI's own poll
   cadence needs a different bound, and per that plan's own reasoning, matching Antigravity's
   already-justified value is the safe default when nothing provider-specific argues otherwise.

## Settings / Schema Plumbing

- `schemas/settings-schema.json`'s `permissions.statusLineTracking` object gains `copilot` and
  `qwen` keys, each the existing `statusLineTrackingSettings` `$ref` (enabled/customCommand/
  useCtrlyokeStyle/format) — no new shape, just two more instances of what Claude/Antigravity
  already use.
- `CtrlYokeSettings.ts`'s `DEFAULT_GLOBAL_SETTINGS.permissions.statusLineTracking`
  (`CtrlYokeSettings.ts:384-397`) gains matching default entries: `enabled: true`,
  `customCommand: ""`, `useCtrlyokeStyle: true`, `format: DEFAULT_STATUS_LINE_FORMAT.map(...)` —
  same static defaults as the existing two, subject to the same Decision-6-of-the-user-controls-plan
  computed-default override on first install.
- `DashboardConstants.ts`'s `SETTING_PATHS` gains eight new dotted paths (four leaves ×
  copilot/qwen), mirroring `PERMISSIONS_STATUS_LINE_TRACKING_CLAUDE_*`/`_ANTIGRAVITY_*`
  (`DashboardConstants.ts:1075-1090`).
- `StatuslineManager.getDefinition` (`StatuslineManager.ts:68-96`) gains two new
  `SettingsJsonMcpTracker.getInstance(...)` branches:
  ```ts
  provider === STATUS_LINE_TRACKING_PROVIDERS.COPILOT
    ? SettingsJsonMcpTracker.getInstance("copilot-cli-settings", {
        projectConfigPath: () => path.join(os.homedir(), ".copilot", "settings.json"),
        userConfigPath: () => path.join(os.homedir(), ".copilot", "settings.json"),
      })
    : provider === STATUS_LINE_TRACKING_PROVIDERS.QWEN
      ? SettingsJsonMcpTracker.getInstance("qwen-cli-settings", {
          projectConfigPath: () => path.join(os.homedir(), ".qwen", "settings.json"),
          userConfigPath: () => path.join(os.homedir(), ".qwen", "settings.json"),
        })
      : /* existing claude/antigravity branches */
  ```
  Qwen's install call sites pass `"ui.statusLine"` as the persistent-value key (Decision 3);
  everyone else keeps passing `STATUS_LINE_SETTING_KEY`.
- `STATUS_LINE_HARNESS_IDS` (`StatsUsageSection.tsx` / `StatusLineSection.tsx`) grows to four
  entries — this is the exact growth `STATUS_LINE_SHARED_FORMAT_TOGGLE_PLAN.md` was written in
  anticipation of; no changes needed to that plan's own design, it already treats provider count
  as unbounded.
- No `usageTracking`/quota-plumbing schema changes — this plan deliberately does not attempt the
  Copilot RPC-quota or Qwen `metrics.models` integration into `HarnessQuotaSnapshot`/`UsageCard`;
  see Non-Goals.

## UI Placement

No new UI mechanism needed. `StatusLineSection.tsx` already renders one
`StatusLineTrackingControls` + `StatusLineFormatEditor` block per entry in
`STATUS_LINE_HARNESS_IDS` (Decision 12, `STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md`) — adding
Copilot/Qwen to that list is the only UI-layer change, producing two more provider blocks on the
existing "Status Line" tab automatically. The live preview's fixture/cached-snapshot fallback
should include a representative Copilot and Qwen payload (using the real captured shape above for
Copilot) so a new user previewing the default format sees accurate output, including the `usage —`
gap called out in Decision 7, rather than a stale two-provider fixture.

## Wrapper Test Coverage

`src/test/unit/StatuslineWrapper.test.ts` gains Copilot/Qwen fixtures mirroring the existing
Claude/Antigravity cases: settings resolution, malformed-input tolerance, the `context` extractor
divergence (Decision 4 — a dedicated test asserting Copilot's `context` field reads
`current_context_used_percentage`-equivalent data and *not* the generic pair, since this is the
one finding a naive "just add a provider" implementation would most easily get wrong silently),
the `cwd` fallback chain (Decision 5), and `usage`/`usage1`/`usage2` rendering as absent for both
new providers.

## Non-Goals

- **Copilot RPC-based quota plumbing into `HarnessQuotaSnapshot`.** `CopilotUsageProvider`
  already exists and already works via `CopilotQuotaClient`, independent of statusline tracking.
  Nothing here changes it.
- **Qwen quota/usage-window plumbing.** `QwenUsageProvider` is currently a bare
  `ObservedOnlyUsageProvider`; Qwen's `metrics.models.<id>` statusline field could plausibly seed
  a richer provider later (mirroring how `STATUSLINE_USER_CONTROLS_PLAN.md` finished Antigravity's
  quota plumbing alongside its statusline work), but that is materially more work than "add
  statusline tracking" and is left as its own future plan, not bundled here.
- **Qwen `type: "preset"` mode support.** ctrlyoke only ever installs/manages `type: "command"`.
  No attempt to translate ctrlyoke's segment format into Qwen's native preset `items` vocabulary.
- **Copilot's `padding` option.** No ctrlyoke use case identified; left unset (CLI default).

## Phases

1. **Settings & schema**: extend the two provider enums (Decision 1), `StatusLineTrackingHarnessId`
   (Decision 2), schema/defaults/`SETTING_PATHS` for `copilot`/`qwen` (Settings/Schema Plumbing
   above).
2. **`SettingsJsonMcpTracker` path generalization** (Decision 3) — the one piece of shared
   machinery that needs real new capability, not just new entries in existing maps. Land this
   before Phase 3 since Qwen's provider install/uninstall depends on it.
3. **`StatuslineManager` provider definitions** (Settings/Schema Plumbing) for both new providers,
   using the Phase 2 path support for Qwen.
4. **`StatuslineFormat.ts` extractor updates**: extend `STATUS_LINE_FORMAT_PROVIDERS`,
   Copilot's dedicated `context` extractor (Decision 4), the `cwd` fallback chain (Decision 5),
   and the `quotaPercentage`/`usageWindows` provider switch extension (Decision 6) — all pure,
   already-isomorphic-module changes per the existing Decision 11 build (no new build-dependency
   work needed, that spike already shipped).
5. **New wrapper entry scripts**: `ctrlyoke-copilot-statusline.js`, `ctrlyoke-qwen-statusline.js`
   (Decision 9), verified against the `copy-scripts` esbuild plugin the same way the original two
   were.
6. **Preset-collision skip-and-disable behavior** (Decision 8): the `capture` callback veto in
   `SettingsJsonMcpTracker.installPersistentValue`, `StatuslineManager`'s detection/`enabled:false`
   write, and its one-time notification wording; plus the Copilot/Qwen provider entries in
   `CliIntegration`'s install-result → notification wiring for the normal (non-collision) path,
   mirroring the existing Claude/Antigravity wiring.
7. **UI**: add `copilot`/`qwen` to `STATUS_LINE_HARNESS_IDS`; extend the live-preview fixture set.
8. **Tests**: wrapper fixtures (Wrapper Test Coverage above), `StatuslineManager` install/uninstall
   coverage for the new path-generalized Qwen case, UI component coverage for the two new provider
   blocks, and dedicated coverage for Decision 8's collision path — asserting the preset value is
   left byte-for-byte unchanged, `enabled` flips to `false`, the notification fires exactly once,
   and a subsequent run with `enabled` manually restored to `true` proceeds to install normally.

## Open Questions

- **Qwen's payload shape above is doc-sourced, not independently probed** (this plan's ask
  specifically scoped the live-probe requirement to Copilot). Given how materially the Copilot
  probe's `context` finding diverged from what a docs-only read would have assumed, a live Qwen
  probe should happen before or during Phase 4, not skipped on the assumption the docs are
  complete — mirroring exactly the caution this plan's own Copilot research vindicated.
- **Should the `branch` field read `payload.git.branch` directly for Qwen** instead of doing its
  own `.git/HEAD` disk read (Research/Decision 5's optional optimization)? Both are correct;
  reading the payload is cheaper and avoids a second git-detection code path running per tick, but
  keeping one implementation for all four providers is simpler to reason about and test. Leaning
  toward "keep the shared disk-read implementation for all four, ignore Qwen's free `git.branch`"
  for uniformity, but not pre-decided.
- **Does Copilot's statusline ever get invoked mid-`copilot -p` (non-interactive) execution when
  ctrlyoke drives it as an orchestrated workflow step**, or only in ctrlyoke's own
  interactive-PTY-backed sessions? The probe above only tested a manually-launched interactive
  session outside ctrlyoke; worth a quick confirmation against `CopilotCliProvider`'s actual PTY
  launch path before shipping, even though the reasoning above (PTY ⇒ real TTY ⇒ statusline fires)
  should already hold.
