# Codex Inline Hooks Migration Plan

> **Status:** Proposed
>
> **Priority:** P1 — companion to
> [`OPENCODE_INLINE_CONFIG_PLAN.md`](OPENCODE_INLINE_CONFIG_PLAN.md); same class
> of problem (ctrlyoke writing config into the user's repo), independent
> mechanism (Codex `-c` overrides rather than an env var).

Move Codex off workspace `.codex/hooks.json` entirely and deliver every
ctrlyoke-owned hook through repeated `-c hooks.<Event>=[…]` CLI overrides at
spawn time, trusted through the `-c hooks.state=…` override ctrlyoke already
emits. ctrlyoke then writes **zero files into the user's repository** for a
Codex run.

---

## Problem

`CodexCliProvider` writes `{workspaceRoot}/.codex/hooks.json` for both
interactive notification hooks (`CodexCliProvider.ts:441`, via
`writeCodexHooks`) and headless user hooks (`:348`), through
`SettingsJsonHooksTracker`. Four consequences:

1. **ctrlyoke mutates a file the user is expected to commit.** Unlike
   OpenCode's `opencode.json` — which lands untracked — `.codex/hooks.json` is
   a _documented project-level config file_ that repos are meant to check in,
   alongside `.codex/config.toml`. When the file already exists,
   `rebuildAndWriteSettings` (`SettingsJsonHooksTracker.ts:251`) rewrites it in
   place for the duration of the run and `restoreBaseline` (`:314`) puts it
   back afterwards. A crash, a kill, or a lost lock between those two points
   leaves ctrlyoke's generated hooks sitting in the user's tracked file. The
   `hookBaselinePolicy.discardHookGroup` machinery
   (`CodexCliProvider.ts:62-89`) exists _only_ to detect and discard exactly
   that leftover state on the next run — it is a scar from this failure mode,
   not a feature.

2. **A shared mutable file demands a lock and a ref-counted baseline.**
   `SettingsJsonMcpTracker.getInstance("codex")` is instantiated purely as a
   mutex (`CodexCliProvider.ts:110-111`; the comment at `:102-107` says so
   outright — Codex writes no MCP config to settings files). Every
   register/unregister is wrapped in `withLock`, and the tracker carries
   baseline capture, per-workflow layering, merge-on-write, and
   restore-on-last-unregister. None of it is inherent to the feature; all of it
   exists because two workflows can race on one file.

3. **Merging into the user's file renumbers the user's own hooks.** Codex keys
   hook trust positionally (`key_source:event:groupIndex:handlerIndex` —
   `codex-rs/hooks/src/lib.rs:105`). Splicing ctrlyoke's groups into the same
   file shifts the user's groups, invalidating their persisted trust hashes.
   `buildCodexMergedState` (`SettingsJsonHooksTracker.ts:467`) and
   `remapCodexBaselineState` (`:579`) exist solely to recompute the user's
   trust entries at their new indices and re-emit them inline. That entire
   remapping problem disappears when ctrlyoke stops touching the file.

4. **Project-level hooks are silently disabled in untrusted projects.**
   Verified below: when the workspace is not a trusted Codex project,
   `.codex/hooks.json` is **not loaded at all** — Codex logs "Project-local
   config, hooks, and exec policies are disabled … until the project is
   trusted" and moves on. ctrlyoke's completion detection depends on those
   hooks. Inline `-c` hooks are unaffected by project trust, so this migration
   fixes a real correctness gap rather than merely tidying the filesystem.

## Verified findings

All verified against **codex-cli 0.146.0** on Windows 11, this session, using
real `codex exec` runs against `gpt-5.4-mini` and the app-server `hooks/list`
method, then corroborated against the **codex source at `c:\dev\codex`**
(commit `d97cb0dca`). Nothing below is taken from documentation alone; where
the docs are incomplete, that is called out.

### Hooks can be declared inline, and `-c` is a first-class hook source

The [hooks docs](https://learn.chatgpt.com/docs/hooks) document
`[[hooks.EventName]]` tables in `config.toml` as equivalent to `hooks.json`.
They do **not** mention that `-c` overrides count as a config layer for this
purpose — but they do. Codex models session `-c` flags as a
`ConfigLayerSource::SessionFlags` layer, and `load_toml_hooks_from_layer`
(`discovery.rs:350`) reads `hooks` from _every_ layer including that one.

Confirmed by real run: a single
`-c 'hooks.Stop=[{hooks=[{type="command", command="node …"}]}]'` fired the hook
and wrote the notification file, with **no `.codex/` directory anywhere in the
workspace**.

### Each config layer is a separate hook source — no merge, no clobbering

This is the crucial structural difference from OpenCode, and it removes the
entire class of hazard that `OPENCODE_INLINE_CONFIG_PLAN.md` has to mitigate
with collision-safe key rewriting.

Hooks are **not** deep-merged across layers. `discovery.rs:120-160` iterates
layers and calls `append_hook_events` once per `(layer, file)`, each with its
own `key_source`. Every source contributes its handlers independently and keeps
its own index space. Verified with a workspace carrying a user-global
`hooks.json`, a project `.codex/hooks.json`, and ctrlyoke's inline hooks
simultaneously — `hooks/list` returned all three sets, side by side:

```
untrusted  | user           | …\codexhome\hooks.json:stop:0:0
untrusted  | project        | …\codextest\.codex\hooks.json:session_start:0:0
untrusted  | project        | …\codextest\.codex\hooks.json:stop:0:0
trusted    | sessionFlags   | C:\<session-flags>\config.toml:pre_tool_use:0:0
trusted    | sessionFlags   | C:\<session-flags>\config.toml:session_start:0:0
trusted    | sessionFlags   | C:\<session-flags>\config.toml:stop:0:0
trusted    | sessionFlags   | C:\<session-flags>\config.toml:stop:0:1
trusted    | sessionFlags   | C:\<session-flags>\config.toml:stop:1:0
```

So ctrlyoke's hook indices depend only on what ctrlyoke itself emits. The
user's hooks keep their original indices and their persisted trust. There is
no ordering hazard, no last-match-wins subtlety, and nothing to rewrite.

### The trust key source for inline hooks is a synthetic path

`config_toml_source_path` maps the session-flags layer to
`synthetic_layer_path("<session-flags>/config.toml")` (`discovery.rs:388`),
and `synthetic_layer_path` (`:392`) resolves it against `C:\` on Windows and
`/` elsewhere. So the `key_source` component is **platform-dependent**:

| Platform      | `key_source`                     |
| ------------- | -------------------------------- |
| Windows       | `C:\<session-flags>\config.toml` |
| macOS / Linux | `/<session-flags>/config.toml`   |

Full key remains `{key_source}:{event_label}:{groupIndex}:{handlerIndex}`
(`lib.rs:105`), e.g. `C:\<session-flags>\config.toml:stop:0:0`. Confirmed
against `hooks/list` output. The Windows form is verified by run; the POSIX
form is read from the `#[cfg(not(windows))]` branch and must be confirmed on a
Mac or Linux box before shipping.

### ctrlyoke's existing trust-hash algorithm is already correct

`SettingsJsonHooksTracker.computeCodexTrustedHash` (`:667`) reproduces Codex's
`command_hook_hash` (`discovery.rs:636`) exactly. Verified by brute-forcing
identity shapes against a `currentHash` read from `hooks/list`: the matching
shape is precisely what ctrlyoke builds today —

```json
{
  "event_name": "stop",
  "hooks": [
    { "async": false, "command": "…", "timeout": 600, "type": "command" }
  ]
}
```

canonicalized with sorted keys, `JSON.stringify`d, SHA-256, `sha256:`-prefixed.
Codex arrives at the same bytes via TOML → `serde_json` → `canonical_json` →
SHA-256 (`config/src/fingerprint.rs:44`). Two details that already match and
must be preserved:

- `event_name` is the **snake_case label** (`stop`, `session_start`,
  `pre_tool_use`), not the TOML event key — `getCodexEventKeyLabel` (`:755`)
  handles this;
- `matcher` is **omitted from the identity** for events that do not support
  matchers. `matcher_pattern_for_event` (`hooks/src/events/common.rs:110`)
  returns `None` for `UserPromptSubmit` and `Stop`, and the identity carries
  whatever it returns — not what was emitted in the config.
  `normalizeCodexHookMatcher` (`CodexHookUtils.ts:10`) already mirrors this.

One latent divergence worth fixing while touching this code:
`canonicalizeJson` (`:697`) sorts with `localeCompare`, whereas Rust's
`canonical_json` sorts by byte order. The two agree for every key ctrlyoke
currently emits (`async`, `command`, `timeout`, `type`, `statusMessage`,
`event_name`, `hooks`, `matcher`), so this is not a live bug — but
`localeCompare` is locale-sensitive and the equivalence is accidental. Switch
to a plain byte comparison.

`ctrlyoke`'s omission of `SessionEnd`, `SubagentStart`, and `SubagentStop` from
`CODEX_EVENTS_WITH_MATCHERS` (`CodexHookUtils.ts:1-8`) is a divergence from
Codex's list, but harmless today because ctrlyoke never emits those events. If
any of them is ever added, that set must be updated in the same commit.

### Untrusted hooks fail silently

With a correct key but a stale hash, `hooks/list` reports
`trustStatus: "modified"` and the hook **does not run**. Under `codex exec
--json` there is **no warning, no error item, and no stderr output** — the run
looks completely normal and the notification file simply never appears. This is
the single sharpest operational edge in this migration: a hash mismatch is
indistinguishable from a harness that never completed.

`--dangerously-bypass-hook-trust` does run the hooks, but emits
`"`--dangerously-bypass-hook-trust` is enabled…"` as an `item.completed` of
type **`error`**, once per hook source, into the JSON event stream. That would
pollute ctrlyoke's output history and be surfaced to users as an error. It is
usable as a **fallback**, not as the primary path.

### Trust state is only read from user and session-flags layers

`hook_states_from_stack` (`hooks/src/config_rules.rs:16`) deliberately reads
`hooks.state` from **only** `ConfigLayerSource::User` and
`ConfigLayerSource::SessionFlags`, skipping project, managed, and plugin
layers — "Project, managed, and plugin layers can discover hooks, but they do
not get to write user hook state."

So `-c hooks.state=…` is not merely _a_ way to pass trust, it is the **only**
way ctrlyoke can assert trust without writing to the user's `~/.codex/config.toml`.
ctrlyoke already does this (`serializeCodexInlineTrustOverride`, `:399`) and
that mechanism carries over unchanged.

### Inline hooks are not gated on project trust

In an untrusted project, Codex logs:

> Project-local config, hooks, and exec policies are disabled in the following
> folders until the project is trusted, but skills still load.

and the project `.codex/hooks.json` hooks are **absent from `hooks/list`
entirely**. ctrlyoke's inline session-flags hooks appeared and were `trusted`
in the same run. Project trust is read from the persisted user `config.toml`
only — it cannot be granted via `-c`.

This means the current file-based implementation silently loses completion
detection in any workspace the user has not explicitly trusted in Codex.
Migrating to inline hooks fixes that.

### Multi-event, multi-group, multi-handler emission works

Verified in one real run with three events, four groups, five handlers,
including a matcher-bearing `PreToolUse` (`matcher = "^Bash$"`): all five hooks
were `trusted` and all five fired. Payloads are byte-identical in shape to the
file-based path — `session_id`, `turn_id`, `cwd`, `hook_event_name`,
`last_assistant_message`, `tool_name`/`tool_input` — so
`ctrlyoke-codex-notify.js` and `CodexNotificationMonitor` need no changes.

Each event must be its own `-c` override (`-c hooks.Stop=[…] -c
hooks.SessionStart=[…]`); dotted paths merge, so a single `-c hooks={…}` would
also work but is harder to read in logs.

### `<` and `>` in the trust key are shell metacharacters

The synthetic key contains `<session-flags>`. Routing the argument through
`cmd.exe` — `spawn(…, {shell: true})`, `cmd /c`, or any `.cmd` shim —
makes cmd interpret `<` and `>` as redirection and the invocation fails with
"The system cannot find the file specified." This bit during research.

ctrlyoke is safe today and must stay that way: the headless path passes
`shell: false` explicitly (`CliTransportCoordinator.ts:584`) and the
interactive path uses `node-pty`, which calls `CreateProcess` directly
(`PtyProcessManager.ts:465`). **Never route Codex args through a shell**, and
add a regression test asserting `shell: false` on the Codex spawn path.

### Command-line length is the real budget constraint

Unlike OpenCode's environment variable, this rides on the Windows command line,
capped at 32 767 characters for `CreateProcess`. Measured: three events / five
handlers with long absolute paths cost **1 676 bytes** of hook definitions plus
**741 bytes** of trust state — roughly **480 bytes per handler**, of which
~148 is the trust entry.

A realistic ctrlyoke config (2–8 handlers) lands at 1–4 KB, comfortably clear,
but it shares the budget with MCP `-c` overrides, `--add-dir` entries, and the
prompt. Add a defensive guard well below the limit and degrade to a diagnostic
rather than a truncated command line.

## Design

One method builds the whole ctrlyoke-owned hook payload per step, returning the
`-c` argument pairs:

```
-c hooks.SessionStart=[{ hooks = [{ type = "command", command = "…" }] }]
-c hooks.Stop=[{ hooks = [{ type = "command", command = "…" }] }]
-c hooks.state={ "<keySource>:session_start:0:0" = { trusted_hash = "sha256:…" }, … }
```

`CODEX_HOOK_ARGS` (`--enable hooks`) is still required and unchanged.
Events ctrlyoke does not own are simply absent, so the user's global, project,
and plugin hooks still apply — and now genuinely untouched.

The hook _content_ is already built in the right shape:
`CodexNotificationMonitor.buildHookConfig` (`CodexNotificationMonitor.ts:54`)
returns `{ type: "json", config: { hooks } }` whose `hooks` section is exactly
the `Record<event, MatcherGroup[]>` this needs. Stage 1 is therefore mostly a
serializer plus a trust-key builder — no reshaping of hook construction.

Because ctrlyoke's inline hooks live in their own index space, group and
handler indices are simply the emission order of ctrlyoke's own arrays. The
trust map can be built in the same loop that renders the TOML, which is what
makes this materially simpler than the file-based path.

## What this deletes

From `CodexCliProvider.ts`:

- `hookBaselinePolicy` (`:62-89`) — leftover-detection for a file no longer
  written;
- the `hooksTracker` and `lockProvider` statics (`:108-111`) and every
  `withLock` / `registerWorkflow` / `unregisterWorkflow` call;
- the file-writing half of `writeCodexHooks` (`:441`), which becomes pure
  argument construction;
- `cleanupWorkspaceArtifacts` (`:502`) entirely — there is nothing left to
  clean up.

From `SettingsJsonHooksTracker.ts`, the whole Codex half:
`getCodexTrustState` (`:386`), `buildCodexMergedState` (`:467`),
`getCodexHookSourcePathVariants` (`:533`), `logCodexTrustState` (`:563`),
`remapCodexBaselineState` (`:579`), `addCodexTrustedState` (`:433`),
`parseHookStateEntry` (`:409`), `parseCodexCommandHook` (`:630`), and the
`toolName === "codex"` branch of the constructor (`:58-67`).

**The tracker itself stays** — `QwenCliProvider` (`:64-65`, `:379`, `:501`)
still uses it for `.qwen/settings.json`. This is a Codex-only extraction.

`computeCodexTrustedHash` (`:667`), `canonicalizeJson` (`:697`),
`toInlineTomlValue` (`:715`), `buildCodexHookKey` (`:746`),
`getCodexEventKeyLabel` (`:755`), and `serializeCodexInlineTrustOverride`
(`:399`) all **survive** but move into a new Codex-specific module — they are
the correct, verified core of this migration, not casualties of it.

`getCodexHookSourcePathVariants` is worth calling out as a deliberate deletion.
It emits every trust entry under two path spellings because Codex "appears
sensitive to the exact path string used in hook discovery" (`:556-559`) — a
workaround for real-filesystem case and `\\?\` prefix ambiguity. The synthetic
`<session-flags>` path is a constant, so the ambiguity it guards against cannot
arise.

## Stages

**Stage 1 — inline builder, no behavior change.** Add a
`CodexInlineHooksBuilder` (new module under `src/core/harness/codex/`) that
takes the `hooks` section `buildHookConfig` already produces and returns
`{ hookArgs: string[]; trustArgs: string[] }`. Move the surviving hash/TOML
helpers here from `SettingsJsonHooksTracker`. Unit tests only; nothing consumes
it yet. Include the byte-order-sort fix for `canonicalizeJson`.

**Stage 2 — deliver via `-c`, cut the file writes.** Rewrite
`buildNotificationHookArgs` (`:313`) and `buildHeadlessUserHookArgs` (`:348`)
to return `[...CODEX_HOOK_ARGS, ...hookArgs, ...trustArgs]` from the Stage 1
builder. Delete the tracker calls, `hookBaselinePolicy`, and
`cleanupWorkspaceArtifacts`. `CodexCliProvider.test.ts:213` and `:266` assert
on a `.codex` directory that will no longer exist — replace them with
inline-argument assertions rather than adapting them.

**Stage 3 — length guard and diagnostics.** Add the command-line budget check,
and — because untrusted hooks fail _silently_ — a startup assertion that the
number of emitted trust keys equals the number of emitted handlers. Consider
logging the computed keys at `trace` (as `logCodexTrustState` does today) so a
future mismatch is diagnosable from a session log alone.

**Stage 4 — POSIX key source.** Confirm `/<session-flags>/config.toml` on macOS
or Linux and make the key-source constant platform-aware. Until confirmed,
Codex inline hooks should stay behind the existing file path on non-Windows.

**Stage 5 — real-harness regression coverage.** Written against the inline
path: interactive completion detection, headless user hooks, and the
untrusted-project case that the file path cannot satisfy at all.

## Testing

Unit:

- one `-c` per event, correct TOML rendering, correct emission order;
- trust key shape per platform, including the `event_label` mapping for every
  event ctrlyoke emits;
- matcher omitted from the identity for `Stop` / `UserPromptSubmit` and present
  for `PreToolUse` / `SessionStart`, matching `normalizeCodexHookMatcher`;
- hash stability — pin the known-good vector
  `{"event_name":"stop","hooks":[{"async":false,"command":…,"timeout":600,"type":"command"}]}`
  against a fixture hash so a refactor cannot silently change it;
- byte-order vs `localeCompare` canonicalization on a key set that
  distinguishes them;
- trust-key count equals handler count;
- the command-line size guard;
- user hooks and ctrlyoke hooks both present in the emitted args without index
  interference;
- no file or directory is created under the workspace root for any Codex run —
  assert on a fixture workspace's directory listing, which is the actual
  regression this plan exists to prevent.

Real-harness (`npm run test:harness`, on request only — it costs money):

- interactive completion detection fires from inline hooks with no
  `.codex/hooks.json` present;
- the same, in a workspace **not** trusted as a Codex project — expected to
  pass on inline and fail on the current file path;
- a pre-existing user `.codex/hooks.json` is byte-identical before and after a
  ctrlyoke run, and the user's own hooks still fire;
- `PreToolUse` with a matcher fires for a shell tool call.

## Risks

- **Silent failure on hash mismatch.** The highest-severity risk here. A wrong
  hash produces no diagnostic whatsoever under `codex exec --json`; ctrlyoke
  would simply hang waiting for a completion notification. The hash is
  version-coupled to Codex's `NormalizedHookIdentity` — a new field with no
  `skip_serializing_if` would change every hash. Mitigate with the pinned hash
  vector above, a trace log of emitted keys, and treating "no SessionStart
  notification within N seconds" as a distinct, actionable error rather than a
  generic timeout.
- **Interactive/PTY path unproven.** All behavioral tests ran through
  `codex exec` and `codex app-server`. Arguments are arguments and
  `buildCliSuffix` (`CodexCliProvider.ts:284`) already orders global flags
  before the `resume` subcommand, so risk is low — but confirm once under a
  real `node-pty` spawn before Stage 2 ships, since that is the path ctrlyoke
  actually uses for interactive runs.
- **Shell metacharacters in the trust key.** See findings. Any future change
  that introduces `shell: true` or a `.cmd` shim on the Codex spawn path breaks
  hooks with a confusing error. Guard with a test.
- **Undocumented layer semantics.** That `-c` participates in hook discovery,
  and that layers do not merge, are both read from 0.146.0 source and confirmed
  by run, but neither is in the docs. Pin the version in the real-harness
  fixture and re-verify on upgrade.
- **`--dangerously-bypass-hook-trust` is a poor fallback.** It works, but emits
  `error`-typed items into the JSON stream. If used as a fallback, filter those
  specific messages out of output history rather than surfacing them.
- **Command-line budget is shared.** Unlike OpenCode's env var, hook args
  compete with MCP overrides and the prompt for 32 767 characters. Realistic
  configs are far below, but the guard is not optional.

## Non-goals

- Changing behavior for any harness other than Codex.
- Removing `SettingsJsonHooksTracker` — Qwen still writes
  `.qwen/settings.json` through it. Only the Codex-specific half is extracted.
- Changing `ctrlyoke-codex-notify.js`, `CodexNotificationMonitor`, or the
  notification-file contract. Hook payloads are unchanged.
- Migrating Codex **MCP** config. That already uses inline `-c` TOML
  (`getMcpConfigArgs`, `CodexCliProvider.ts:648`) and writes no files — it is
  the precedent this plan follows, not work this plan creates.
- Granting Codex project trust on the user's behalf. It is only readable from
  the persisted user `config.toml`; inline hooks make it unnecessary.
