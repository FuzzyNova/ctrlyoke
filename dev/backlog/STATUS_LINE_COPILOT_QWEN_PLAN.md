# Status Line Copilot & Qwen Support Plan

> **Status:** Not implemented. Research completed 2026-08-22, including live, empirical probes
> of GitHub Copilot CLI's and Qwen Code's real statusline payloads on this machine (not just
> documentation).
> Re-verified against the codebase 2026-08-22 after `STATUS_LINE_SHARED_FORMAT_TOGGLE_PLAN.md`
> landed — see "Plan currency note" below the Research section for what changed.

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

Sourced from the official docs (`https://qwenlm.github.io/qwen-code-docs/en/users/features/status-line/`),
inspection of a **real, already-configured** `~/.qwen/settings.json` on this machine, and a live
probe of Qwen Code `0.21.15` on 2026-08-22. The probe temporarily changed only `ui.statusLine`
to command mode, ran a genuine interactive TTY session in this repository, captured repeated
stdin payloads, and restored the original settings file byte-for-byte (SHA-256 verified).

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

**Real captured payload** (from the live probe, after the first API call; full shape, not
paraphrased):
```json
{
  "session_id": "43a8bb4c-f013-447e-9e23-c70e071fc16e",
  "version": "0.21.15",
  "model": {
    "display_name": "[ModelStudio Standard] qwen3.5-plus"
  },
  "context_window": {
    "context_window_size": 1000000,
    "used_percentage": 4.3,
    "remaining_percentage": 95.7,
    "current_usage": 42735,
    "total_input_tokens": 77327,
    "total_output_tokens": 691
  },
  "workspace": {
    "current_dir": "C:\\dev\\ctrlyoke.worktrees\\small-feature"
  },
  "git": {
    "branch": "small-feature"
  },
  "metrics": {
    "models": {
      "qwen3.5-plus": {
        "api": {
          "total_requests": 4,
          "total_errors": 0,
          "total_latency_ms": 20189
        },
        "tokens": {
          "prompt": 77327,
          "completion": 691,
          "total": 78018,
          "cached": 16634,
          "thoughts": 433
        }
      }
    },
    "files": {
      "total_lines_added": 0,
      "total_lines_removed": 0
    }
  }
}
```

The live payload confirms the documented `context_window` key names and values, but it also
confirms a semantic detail the generic extractor must not ignore: `current_usage` is a **number**
(the current context size), not an object. It differs from the cumulative
`total_input_tokens + total_output_tokens` in the captured turn (`42735` versus `78018`), so a
Qwen context extractor should prefer `current_usage`/`context_window_size` and fall back to the
shared cumulative-token calculation only for partial or older payloads. The native
`used_percentage`/`remaining_percentage` values are also present.

The first startup payloads had `context_window` totals at zero and omitted `git` entirely; `git`
appeared on subsequent refreshes once session state initialized. Therefore `git.branch` is really
provided directly in normal repository payloads, but it is not guaranteed on every tick. There is
still no top-level `cwd` — only `workspace.current_dir` — and no `model.id`; `model.display_name`
is the only model identifier observed. The payload also has no `rate_limits`, `quota`, `cost`, or
`transcript_path` field. Its additional structures are `metrics.models.<id>` and `metrics.files`;
the documented optional `worktree` and `vim` structures were absent in this ordinary session.

The settings and invocation claims are also confirmed live: `ui.statusLine` is nested, `type:
"command"` receives JSON on stdin, and `refreshInterval: 1` caused repeated command invocations
inside the interactive TTY. No Qwen-specific quota source is available to the wrapper, so
`usage`/`usage1`/`usage2` remain empty as planned. Qwen-only fields remain excluded from the
registry: `worktree`, `vim.mode`, `metrics.files`, and `metrics.models.<id>` detail.

### Field availability across all four providers (updated)

The original plan's registry (`STATUS_LINE_FIELD_REGISTRY`, `StatuslineFormat.ts:20-81`) is a
single global vocabulary with no per-provider gating — a deliberate simplification that held
because both existing providers (Claude, Antigravity) happened to support every field. That
invariant does not survive adding Copilot/Qwen unchanged; three fields need either a corrected
extractor or an accepted "structurally always empty for these two" outcome:

| id | claude | antigravity | copilot | qwen | note |
| --- | --- | --- | --- | --- | --- |
| `model` | ✓ | ✓ | ✓ (nullable pre-first-turn) | ✓ (`display_name` only, no `id`) | existing fallback chain already handles both gaps |
| `context` | ✓ | ✓ | ✓ **but needs a Copilot-specific extractor** (`current_context_tokens`/`displayed_context_limit`, not the generic pair) | ✓ **but needs a Qwen-specific preference for numeric `current_usage`/`context_window_size`; startup payloads can be partial** | see Research above |
| `usage`/`usage1`/`usage2` | ✓ | ✓ | **no data** (renders `—` / drops silently, existing tolerance) | **no data** (same) | real Copilot quota exists but is architecturally unreachable here — see Research |
| `version` | ✓ | ✓ | ✓ | ✓ | no change |
| `cwd` | ✓ (`payload.cwd`) | ✓ (`payload.cwd`) | ✓ (`payload.cwd`, confirmed live) | **`payload.workspace.current_dir` only, confirmed live** | needs a fallback chain, not a new field |
| `sessionId` | ✓ | ✓ | ✓ | ✓ | no change |
| `branch` (locally computed) | computed via `.git/HEAD` | computed via `.git/HEAD` | computed via `.git/HEAD` | **`payload.git.branch` observed after startup; absent on initial ticks** | see Decisions — optional optimization, not required |
| `date`/`time` (locally computed) | ✓ | ✓ | ✓ | ✓ | provider-agnostic, no change |

## Plan currency note (2026-08-22 pre-implementation review)

Re-verified against the codebase after `STATUS_LINE_SHARED_FORMAT_TOGGLE_PLAN.md` fully landed.
The toggle plan's `useDifferentFormatPerHarness`/`sharedFormat` fields landed exactly as that
plan described (no deviation), and this plan's own premises (no dotted-path support in
`SettingsJsonMcpTracker`, no capture veto, no copilot/qwen branches anywhere) all still hold
unchanged — nothing here has been implemented out from under it. Two corrections from that
re-verification:

- **`StatuslineFormat.ts` line citations below are stale by +33 lines** (something unrelated
  shifted the file since this plan was last touched): `contextValues()` is now at
  `StatuslineFormat.ts:328-350` (not 295-317), `STATUS_LINE_FORMAT_PROVIDERS` is now at
  `StatuslineFormat.ts:260-266` (not 227-233), `quotaPercentage`/`usageWindows` are now at
  `StatuslineFormat.ts:371-447` (not 338-414), and the `cwd` read in the format switch is now at
  `StatuslineFormat.ts:597-604` (not 564-570). `DashboardConstants.ts`, `StatuslineManager.ts`,
  `SettingsJsonMcpTracker.ts`, and `ClaudeCliProvider.ts` citations are all still exact.
- **There is a third closed 2-entry provider union**, not accounted for by Decision 1's "two
  separate closed unions" framing: `STATUSLINE_PROVIDERS = {CLAUDE, ANTIGRAVITY}` in
  `src/scripts/ctrlyoke-statusline-wrapper.js:26-29` (plain CommonJS, no TS enforcement). It grows
  to four in Phase 5 alongside the new wrapper entry scripts — see that phase.
- **The UI surface is wider than "grow `STATUS_LINE_HARNESS_IDS`."**
  `StatusLineTrackingControls.tsx` has three more provider-keyed switches/maps that each need a
  copilot/qwen case: `STATUS_LINE_SETTING_PATHS` (~lines 41-61), a private `providerForHarness`
  switch (~65-74), and `getDisableWarning` (~76-83). `StatusLinePreview.tsx` (new since this plan
  was last touched) has its own `previewPayload()` provider ternary (~36-102) that needs
  copilot/qwen fixture payloads for the live preview — this is the concrete place the "UI
  Placement" section's fixture requirement lands, not just a general note. See Phase 7.

## Decisions

0. **Complete the live Qwen Code payload probe before building its extractor logic.** The
   2026-08-22 probe of Qwen Code `0.21.15` confirmed the documented `context_window.*` names,
   nested `workspace.current_dir`, direct `git.branch` after startup, and the absence of both a
   top-level `cwd` and `model.id`. It corrected one implementation assumption: numeric
   `context_window.current_usage` is the current context size and must be preferred over the
   cumulative input/output totals. It also found that `git` and token totals can be absent/zero on
   initial refreshes. The Research section now contains the captured JSON; Phase 0 is complete,
   and Phase 4 must include the Qwen context branch below.

1. **Extend `STATUS_LINE_TRACKING_PROVIDERS` and `STATUS_LINE_FORMAT_PROVIDERS` to four entries
   each**, adding `COPILOT: "copilot"` and `QWEN: "qwen"` (short ids, matching the existing
   `claude`/`antigravity` convention of dropping the `-cli` suffix from `HARNESS_IDS`). These are
   two separate closed unions today (`DashboardConstants.ts:36-39` vs `StatuslineFormat.ts:260-266`)
   for settings/tracking vs. formatting concerns respectively — keep that separation, just grow
   both in lockstep, same as the existing two entries already are. (A third, `STATUSLINE_PROVIDERS`
   in the standalone wrapper script, also grows to four — see Plan currency note above and Phase 5.)
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
4a. **Qwen's `context` field also needs a provider-specific preference, though not a new size
    field.** The live Qwen payload uses the documented generic key names, but its numeric
    `context_window.current_usage` is the current context size and can differ from cumulative
    `total_input_tokens + total_output_tokens`; the existing generic `contextValues()` treats
    numeric `current_usage` as `{}` and silently ignores it. Add a Qwen branch that uses
    `used = current_usage` and `size = context_window_size`, falling back to the generic
    cumulative-token pair when either value is absent or invalid. As with Copilot, tolerate the
    partial zero/omitted fields observed during startup.
5. **`cwd` gains an evidence-based fallback chain: `payload.cwd ??
   payload.workspace?.current_dir`**, rather than a Qwen-specific branch. The live Qwen payload
   has no top-level `cwd` at all, while Copilot's probe confirmed that key and the existing
   Claude/Antigravity research uses it, so the fallback is required for the four-provider
   extractor. This is strictly a generalization of the existing single-key read at
   `StatuslineFormat.ts:597-604` and mirrors the fallback-chaining style the `model` field
   extractor already uses (`safeLabel(model.id, safeLabel(model.display_name, ...))`). Do not
   infer cwd from Qwen's `git.branch`: the branch is a separate field, and the live probe omitted
   `git` on initial refreshes. The locally-computed `branch` field's on-disk `.git/HEAD` lookup
   should resolve the workspace directory through this same helper; optionally preferring
   `payload.git.branch` for Qwen remains a separate optimization decision.
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

No new UI *mechanism* needed, but the change is not limited to growing one array. Since the
shared/per-harness toggle work landed, `StatusLineSection.tsx` renders one
`StatusLineTrackingControls` block per entry in `STATUS_LINE_HARNESS_IDS` (shared mode renders a
`StatusLinePreview` inside each block instead of a full editor) — adding Copilot/Qwen to that
list is necessary but not sufficient. `StatusLineTrackingControls.tsx` has three more
provider-keyed switches/maps that each need a `copilot`/`qwen` case: `STATUS_LINE_SETTING_PATHS`
(~lines 41-61, the per-provider `SETTING_PATHS` lookup used by both the toggle and format-editor
paths), a private `providerForHarness` switch (~65-74), and `getDisableWarning` (~76-83). And
`StatusLinePreview.tsx`'s `previewPayload()` (~36-102) — the function that fabricates a
representative fixture payload per provider for the live preview in both per-harness and shared
mode — needs Copilot and Qwen cases added, using the real captured shape from the Research section
above for Copilot (and the Phase 0 live-probed shape for Qwen) so a new user previewing the
default format sees accurate output, including the `usage —` gap called out in Decision 7, rather
than a stale two-provider fixture or a runtime fallback to an unrelated provider's shape.

## Wrapper Test Coverage

`src/test/unit/StatuslineWrapper.test.ts` gains Copilot/Qwen fixtures mirroring the existing
Claude/Antigravity cases: settings resolution, malformed-input tolerance, the `context` extractor
divergences (Decision 4's Copilot-specific displayed limit and Decision 4a's Qwen numeric
`current_usage`, both *not* the generic pair), the `cwd` fallback chain (Decision 5), and
`usage`/`usage1`/`usage2` rendering as absent for both new providers.

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

0. **Complete — live-probe Qwen Code CLI's statusline payload** (Decision 0). The probe ran on
   2026-08-22 against Qwen Code `0.21.15`, captured real interactive payloads, and restored the
   original `~/.qwen/settings.json`. Phase 4 now depends on the documented shape plus the
   Qwen-specific numeric-`current_usage` context preference recorded in Decision 4a.
1. **Complete — settings & schema**: extend the two provider enums (Decision 1), `StatusLineTrackingHarnessId`
   (Decision 2), schema/defaults/`SETTING_PATHS` for `copilot`/`qwen` (Settings/Schema Plumbing
   above). Does not touch `STATUS_LINE_HARNESS_IDS` (webview) — that's Phase 7, so no UI is
   exposed for a provider with no backend yet. Expect `settingsSchemaUiParity` to go red for the
   two new leaf paths until Phase 7 lands; that's expected, not a regression to chase early.
2. **`SettingsJsonMcpTracker` path + veto generalization** (Decision 3, plus Decision 8's
   `capture`-callback veto plumbing bundled in since both are one-time signature changes to the
   same two methods) — the one piece of shared machinery that needs real new capability, not just
   new entries in existing maps. Land this before Phase 3 since Qwen's provider install/uninstall
   depends on the path support.
3. **`StatuslineManager` provider definitions** (Settings/Schema Plumbing) for both new providers,
   using the Phase 2 path support for Qwen. Include `StatuslineManager` install/uninstall test
   coverage for the new path-generalized Qwen case here, alongside the behavior it covers.
4. **`StatuslineFormat.ts` extractor updates**: extend `STATUS_LINE_FORMAT_PROVIDERS`,
   Copilot's dedicated `context` extractor (Decision 4), Qwen's numeric `current_usage` context
   preference (Decision 4a), the `cwd` fallback chain (Decision 5),
   and the `quotaPercentage`/`usageWindows` provider switch extension (Decision 6) — all pure,
   already-isomorphic-module changes per the existing Decision 11 build (no new build-dependency
   work needed, that spike already shipped). Include the wrapper fixture tests for these
   extractors (Wrapper Test Coverage above) in this same phase, alongside the behavior they cover.
5. **New wrapper entry scripts**: `ctrlyoke-copilot-statusline.js`, `ctrlyoke-qwen-statusline.js`
   (Decision 9), extending the third `STATUSLINE_PROVIDERS` union (Plan currency note) to four,
   verified against the `copy-scripts` esbuild plugin the same way the original two were. Include
   the remaining wrapper fixture tests (settings resolution, malformed-input tolerance) here.
6. **Preset-collision skip-and-disable behavior** (Decision 8): use the Phase 2 `capture` callback
   veto in `SettingsJsonMcpTracker.installPersistentValue`, `StatuslineManager`'s detection/
   `enabled:false` write, and its one-time notification wording; plus the Copilot/Qwen provider
   entries in `CliIntegration`'s install-result → notification wiring for the normal
   (non-collision) path, mirroring the existing Claude/Antigravity wiring. Include dedicated
   coverage for the collision path — asserting the preset value is left byte-for-byte unchanged,
   `enabled` flips to `false`, the notification fires exactly once, and a subsequent run with
   `enabled` manually restored to `true` proceeds to install normally.
7. **UI**: add `copilot`/`qwen` to `STATUS_LINE_HARNESS_IDS`; add cases to
   `StatusLineTrackingControls.tsx`'s `STATUS_LINE_SETTING_PATHS`/`providerForHarness`/
   `getDisableWarning`; add Copilot/Qwen fixture payloads to `StatusLinePreview.tsx`'s
   `previewPayload()` (UI Placement above); UI component coverage for the two new provider blocks.
   This is what turns `settingsSchemaUiParity` green again.

## Open Questions

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
