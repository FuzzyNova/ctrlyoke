# Replace Gemini with Antigravity CLI (`agy`) in ctrlyoke

**Harness ID**: `antigravity-cli`
**Binary**: `agy` (**v1.0.16** re-verified 2026-07-05; previously v1.0.14 on 2026-06-30; original research was v1.0.8)
**Vendor**: Google DeepMind
**Last Updated**: 2026-07-05
**Scope**: Add the `antigravity-cli` harness **and remove the `gemini-cli` harness entirely.**

**Decision confirmed 2026-07-05**: Google's official transition post confirms consumer Gemini CLI access stopped 2026-06-18 (already past, matching Nathan's own broken consumer access) and that enterprise Code Assist Standard/Enterprise licensees are **not** left without a path — they "can use [Antigravity CLI] now with your Google Cloud projects" alongside continued Gemini CLI support. So removing Gemini does not strand enterprise users; it just means they'd use `agy` like everyone else. Proceeding with full removal per Part C.

---

## Background

Google has deprecated the Gemini CLI; `gemini` no longer works in ctrlyoke (it errors when invoked) and is being replaced by **Antigravity (`agy`)** as Google's primary AI coding CLI. Unlike the original plan (which kept Gemini alongside Antigravity), Nathan has decided to **remove Gemini support outright** — there is no reason to keep a broken harness. This document covers both halves:

- **Part A** — research findings from running `agy` locally (replaces the old speculative "Open Questions").
- **Part B** — add the `antigravity-cli` harness.
- **Part C** — remove the `gemini-cli` harness and all references.

This is the inverse-plus-add of [`ADDING_NEW_CLI_HARNESS.md`](../implemented/ADDING_NEW_CLI_HARNESS.md). Read that guide for the per-layer touchpoint rationale; this document records what is **specific** to Antigravity and to deleting Gemini.

---

## Re-verification Delta — 2026-06-30 (`agy` 1.0.14)

Re-ran `agy` locally (now **1.0.14**, up from 1.0.8) and re-checked the docs/changelog. The architecture in Part A still holds; the deltas that change implementation decisions:

1. **Headless resume bug is FIXED (1.0.9).** The 1.0.9 changelog explicitly fixes "headless print mode resumption (`--conversation`/`-c` `-p ...`) … dump[ing] the entire historical conversation transcript instead of only printing the newly generated response." Since we ship against ≥1.0.14, the A.4 "keep only the final turn" workaround is **no longer required** — require `agy >= 1.0.9` instead. (Still worth a defensive guard, but not the primary path.)

2. **Headless `-p` still emits ZERO bytes in a non-TTY pipe — re-confirmed on 1.0.14.** `echo … | agy -p "…"` exits `0` with empty stdout/stderr; the process tears down (`Language server shutting down`) without running the turn. This is now the **single biggest implementation risk**. ctrlyoke spawns via `PtyProcessManager` (a real pty), which is a _different_ context than a plain pipe, so it may work — but this MUST be verified empirically inside ctrlyoke's pty spawn before building on `--print`. If `-p` proves pty-dependent and unreliable, the fallback is interactive (`-i`) + `Stop` hook for _all_ runs, not just interactive ones. **Do this verification first.**

3. **New flags: `--project` / `--new-project` (1.0.12).** `agy` now has an explicit project concept. Project-scoped permission config in `~/.gemini/config/projects/<id>.json` **takes precedence** over global `~/.gemini/antigravity-cli/settings.json` (1.0.12). Default is `default-cli-project`. ctrlyoke can ignore these for v1 (let agy default), but be aware permission/MCP resolution is now project-aware.

4. **MCP workspace path is genuinely unsettled — do NOT hard-assume `.agents/mcp_config.json` loads.** Open issue [#60](https://github.com/google-antigravity/antigravity-cli/issues/60) reports a project-local `mcp_config.json` is _discovered but silently ignored_ (only HOME-level config spawns servers); the 1.0.14 changelog says it "Fixed an MCP configuration path mismatch in the CLI and permission manager." Community guides say workspace `.agents/mcp_config.json` works; the issue used `.antigravitycli/` (a different/wrong path). **Net: verify on 1.0.14 that `.agents/mcp_config.json` actually spawns a server before relying on it; if not, fall back to the global `~/.gemini/config/mcp_config.json`** (this file exists locally and is the confirmed global path). MCP is the area most likely to need a global-file fallback that breaks per-workflow isolation.

5. **Hook payload carries `conversationId` AND `transcriptPath` AND `artifactDirectoryPath`.** Per the docs, `PreToolUse`/`Stop` deliver tool-call details, **step index, conversation ID, workspace paths, transcript path, and artifact directory path** on stdin. Consequence: **in interactive mode the session ID comes straight from the hook payload — no glog parsing needed.** The `AntigravityLogParser` glog scrape is only needed for the **headless** path (where no hook fires). This narrows the log parser's job; consider deferring it if headless session-ID can come from `cache/last_conversations.json` alone.

6. **Model list adds `GPT-OSS 120B (Medium)`** alongside the Gemini/Claude families (A.2). Default remains `Claude Sonnet 4.6 (Thinking)` (confirmed in local `~/.gemini/antigravity-cli/settings.json`).

7. **Permission engine hardened (1.0.9–1.0.13).** Default `toolPermission=request-review`; "Always Approve" rules are now **strict (non-regex) match by default**, opt into regex with a `regex:` prefix. Relevant when designing `custom` permission gating via a `PreToolUse` hook (A.8) — the hook-decision route is cleaner than trying to pre-seed allow-rules.

The rest of Part A below is unchanged from the 1.0.8 research and remains accurate; inline notes flag where 1.0.14 supersedes a specific claim.

---

## Re-verification Delta — 2026-07-05 (`agy` 1.0.16) — **#1 blocker RESOLVED, better than hoped**

Re-ran the actual research blockers locally against **1.0.16** (up from 1.0.14), this time spawning `agy` exactly the way ctrlyoke's code does instead of via a shell pipe. This surfaced one wrong assumption in the plan and resolved the single biggest open risk:

1. **Correction to the plan's premise: ctrlyoke's headless path never uses a PTY.** A.5/A.9 assumed "ctrlyoke spawns via `PtyProcessManager` (a real pty)" for all execution. That's only true for **interactive** mode. `CliTransportCoordinator.executeHeadless()` (`src/core/harness/shared/CliTransportCoordinator.ts:306-368`) calls `this.spawnProcess()` (line 339), which calls `CliProcessManager.spawn()` (`src/utils/CliProcessManager.ts:55-140`) — a plain `child_process.spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] })`. **No node-pty, no real terminal, ever, for headless.** Interactive mode (VS Code PTY session via `PtyProcessManager.spawnPty`, or the standalone CLI's `spawnInteractive` with `stdio: "inherit"`) is the only path that touches a terminal.

2. **The real headless spawn shape now works cleanly — no pty needed.** Reproduced `CliProcessManager.spawn()`'s exact shape (`child_process.spawn`, `stdio: ["ignore","pipe","pipe"]`, `shell: false`) against `agy -p "..."` locally: **exit 0, clean plain-text stdout (`"PONG\n"`), zero stderr, no ANSI escape codes.** This is a materially better result than testing under node-pty (which also works, but wraps the response in ANSI clear-screen/cursor/title-set sequences that would need stripping — irrelevant now since headless doesn't use pty at all).

3. **Root cause of the "empty stdout" finding: fixed upstream in 1.0.15, not a pty issue.** The `agy changelog` for 1.0.15 states verbatim: _"Fixed a bug on Windows where print mode and other non-TUI command outputs were silently discarded when run in non-TTY environments (such as pipes or subprocesses)."_ This is exactly the A.5 symptom (re-confirmed empty on 1.0.14). It's fixed in 1.0.15; we're shipping against ≥1.0.16. **Action: require `agy >= 1.0.15`** (not just `>= 1.0.9`) as the minimum version gate.

4. **Consequence for the design: drop the `-i` + `Stop`-hook-for-all-runs fallback.** A.5/A.9/the effort estimate treated "headless doesn't work, fall back to interactive-always" as a real contingency to plan for. It is not needed — `--print` is viable as the primary headless path exactly as originally hoped, via ctrlyoke's existing plain-pipe headless spawn. Interactive `-i` + `Stop` hook is still needed, but only for interactive mode (as normal), not as an emergency headless substitute.

5. **`agy models` also works non-interactively now** (same 1.0.15 fix applies). Confirmed exact label list via plain-pipe spawn: `Gemini 3.5 Flash (Medium/High/Low)`, `Gemini 3.1 Pro (Low/High)`, `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)` — matches A.2 exactly, values confirmed verbatim for `ANTIGRAVITY_CLI_MODELS`.

6. **Session ID + completion markers confirmed live in the CLI log**, matching A.4/A.7 exactly: `Print mode: conversation=<uuid>` (well, observed as `Print mode: starting (...conversationID="")` followed shortly by `Starting conversation update stream for <uuid>` once the conversation is created), and completion via `Stream completed for <uuid>, clearing ResponsePending` immediately followed by `Language server shutting down`. The glog parser design in B.1 is confirmed workable as written.

7. **New finding — MCP does not appear to load at all in headless `-p` mode (workspace OR global).** Tested both: (a) a workspace `.agents/mcp_config.json` with one server entry (deliberately using a nonexistent command so any spawn attempt would show as a log error), and (b) the same probe entry in the global `~/.gemini/config/mcp_config.json`. Ran `agy -p "..."` against each. **Neither produced any log line mentioning `mcp`, the server name, or the fake command** — not even a failed-spawn error. This is a different and more pessimistic finding than issue #60 (which was about the workspace path specifically being ignored while global worked) — here, **neither path shows any evidence of MCP initialization during a single-shot headless print run**. Caveat: the test prompt ("say PONG") never attempted to invoke a tool, so this could mean either (a) headless print mode doesn't initialize MCP tooling at all, or (b) MCP servers are lazy-spawned only on first actual tool-call attempt and a trivial prompt never triggers that. **Follow-up needed before finalizing MCP scope for v1**: re-test with a prompt that forces a tool call against a real (working) MCP server and see if it spawns lazily. If it still doesn't spawn, headless MCP support may need to be scoped out of v1 entirely (interactive-only), which would be a scope reduction from A.8/B.1's "MCP in scope" assumption.

**Net effect on sequencing**: step (1) in the "Lowest-risk sequencing" note at the bottom of this doc — "resolve the headless `-p` pty question first" — is done, and the answer is the good outcome (ship headless via `--print` + exit + log-based session ID, no pty/interactive fallback needed). The MCP lazy-load question (item 7 above) is the next thing to verify before committing to the `.agents/mcp_config.json` writer design in B.1.

---

## Re-verification Delta — 2026-07-05 part 2 (`agy` 1.0.16) — MCP resolved (negative), hooks schema rewritten

Followed up on the two open research items above with real `agy` calls (headless plain-pipe, real pty interactive sessions, and driving the CLI's own `/hooks` TUI). Both are now resolved with hard evidence; the hooks finding is a **major correction** to B.1/A.6, not just a confirmation.

### MCP — confirmed non-functional in this build, not just "unverified"

Built a real test: a workspace `.agents/mcp_config.json` pointing at ctrlyoke's own working MCP stdio server (`out/mcp-server.js`, the same one `mcp.harness.test.ts` uses against `copilot-cli`), then a headless `-p` prompt that explicitly instructed the model to call `ctrlyoke_queue_status`. Result: the model itself replied that it has **no such tool in its tool list**, and suggested checking whether the MCP server was configured at all. Repeated with a probe (nonexistent-command) entry in both the workspace and the **global** `~/.gemini/config/mcp_config.json` — neither produced any log line about MCP init, spawn attempts, or the server name, in headless mode. Then repeated the real-server test in **interactive** mode (`-i`, real pty): the native permission system did show `Requested Permission: mcp(*/ctrlyoke_queue_status)` dialogs (twice) — proving the model *attempted* the call and the permission layer recognized the tool name pattern — but after granting permission, the model reported *"I don't currently have `ctrlyoke_queue_status` available as an MCP tool in my tool set... the ctrlyoke MCP server may not be connected/active in your current session."*

**Conclusion: MCP servers configured via either `.agents/mcp_config.json` (workspace) or `~/.gemini/config/mcp_config.json` (global) do not become callable tools in this build (1.0.16), in headless or interactive mode**, despite the permission layer being aware of the attempted call. This goes beyond issue #60 (which described only the workspace path being ignored) — here neither path worked with a real, working server. **Recommendation: drop MCP support from `antigravity-cli` v1 entirely.** B.1's "`.agents/mcp_config.json` writer + `serverUrl` + cleanup" design should be shelved until Google fixes MCP loading upstream; A.9's "MCP: Gemini-ish workspace file" row should be changed to "not supported in v1."

### Hooks — real schema is inverted from Claude's, and the real event list is different

A.6 assumed (from docs) a Claude-style shape: `{"hooks": {"<EventName>": [{"hooks":[{"type":"command","command":...}]}]}}`, with 9 possible events including `SessionStart`/`SessionEnd`/`UserPromptSubmit`/`PreCompact`/`Notification`/`SubagentStop`. Testing that shape against the confirmed-correct global path `~/.gemini/config/hooks.json` produced a hard parse error in the CLI log (`cannot unmarshal array into Go struct field .PreToolUse of type jsonhook.JSONHookSpec`). Rather than keep guessing field names, drove the CLI's own **`/hooks` TUI** (discovered via `HooksModel`/`enterAddHookForm`/`saveHooks` symbols found by scanning `agy.exe`'s embedded Go strings) to create a real hook through the product's own UI, then read what it wrote to disk — this is authoritative, not inferred.

**The real event list is only 5 items** (shown verbatim in the `/hooks` menu, "5 hook types"): `PreToolUse`, `PostToolUse`, `PreInvocation` ("Before each LLM invocation"), `PostInvocation` ("After each LLM invocation"), `Stop` ("When agent tries to exit"). **`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact`, `Notification`, and `SubagentStop` do not exist as configurable events in this build** — A.6's event table and B.1's `EVENT_MAP`/`ctrlyokeEvents` design (which relied on `sessionStart`, `userPromptSubmit`) need to be rebuilt around this real 5-event list. `PreInvocation`/`PostInvocation` are a new concept not in the original docs at all — they fire around each individual LLM turn, not each tool call.

**The real JSON schema is group-name-keyed, not event-name-keyed**, the opposite of Claude's shape:

```json
{
  "<arbitrary-hook-group-name>": {
    "PreToolUse": [{ "type": "command", "command": "...", "timeout": 0 }],
    "PostToolUse": null,
    "PreInvocation": null,
    "PostInvocation": null,
    "Stop": null
  }
}
```

Every group object always carries all 5 event keys; unused ones are `null` rather than omitted. The top-level key is a free-form name (whatever the "Name:" field in the `/hooks` "Add new hook" form was given, e.g. `ctrlyoke-probe`) — ctrlyoke should register its own hooks under a single stable group name (e.g. `"ctrlyoke"`), not one entry per event. `timeout` is a per-handler field in seconds (`0` = default). No `matcher` field was present for a `Stop` handler in the saved file (the add-hook form for `Stop` only exposed Name/Command/Timeout); PreToolUse/PostToolUse hooks may support a tool-name matcher (the menu labeled the page "`<Event> — Matchers`") but this wasn't directly confirmed since only `Stop` was driven through the form.

**Open sub-issue — `Stop` did not observably fire (as of the previous session).** With a correctly-shaped, TUI-generated `Stop` hook registered globally, tested three exit paths: headless `-p` completion, interactive session ended via double Ctrl+C (graceful, `exitCode 0`), and interactive session ended via typing `/exit`. **None produced a hook capture file**, even with a 2s+ grace period after process exit. In hindsight this was most likely a config problem (see below), not a real "Stop never fires" finding.

> ✅ **RESOLVED 2026-07-05 (later session) — `PreInvocation`, `PostInvocation`, AND `Stop` all fire, per-turn, in both headless and interactive-piped modes.** Built a probe hook script logging raw stdin to a file, wired all 5 events (`PreToolUse`/`PostToolUse`/`PreInvocation`/`PostInvocation`/`Stop`, unused ones `null`) to it under a single group name in the confirmed global path `~/.gemini/config/hooks.json`, and drove two real `agy` invocations:
>
> 1. **Headless** (`agy -p "..."`, single turn, no tool call): probe log shows **`PreInvocation` → `PostInvocation` → `Stop`, in that order, all within ~1.4s**, one call each. `Stop` payload: `{"terminationReason":"NO_TOOL_CALL","fullyIdle":true,"error":""}`.
> 2. **Interactive-piped** (`agy -i "<prompt>"` with stdin piped, no real pty): **same three-event sequence fired after the first turn** — `PreInvocation`/`PostInvocation`/`Stop` all captured with `fullyIdle:true`, before the process had exited (it was still waiting on further stdin when killed).
>
> **Conclusion: `Stop` fires whenever the agent goes fully idle after a turn (no pending tool call), not just on process exit** — the earlier "did not fire" result was very likely caused by a mis-shaped hooks.json silently failing to load (or a bad hook response causing the framework to treat the hook as broken), not a real product limitation. This means **either `PostInvocation` or `Stop` works as the interactive per-turn completion signal** — prefer `PostInvocation` (fires first, has a stable `invocationNum`/`modelName` payload) since it doesn't depend on `fullyIdle` semantics that could differ once tool calls are in play (untested: whether `Stop` fires after every turn or only turns with no tool call — `NO_TOOL_CALL` in the payload hints it may be conditional; `PostInvocation` fired unconditionally in both tests and is the safer bet).
>
> **Important side-finding — hook stdout contract differs by event type.** The probe returned `{"decision":"allow"}` on stdout for every event (copying the `PreToolUse`-style contract). For `PreInvocation`/`PostInvocation`/`Stop` this produced a logged error every time: `failed to unmarshal result ... via protojson: unknown field "decision"`. It did **not** block turn completion in these tests, but the hook script for these three event types should emit `{}` (or nothing) on stdout instead of a `{decision}` object — `decision` is only valid for the tool-permission-gating events (`PreToolUse`, and presumably `PostToolUse`).
>
> **Payload shape confirmed**: `PreInvocation`/`PostInvocation` carry `{artifactDirectoryPath, conversationId, initialNumSteps, invocationNum, modelName, transcriptPath, workspacePaths}`. `Stop` carries `{artifactDirectoryPath, conversationId, error, executionNum, fullyIdle, modelName, terminationReason, transcriptPath, workspacePaths}`. Both confirm `conversationId` is present per A.6/1.0.14 — no glog parsing needed for interactive session ID.

**Consequences for Part B**:
- `AntigravityNotificationMonitor.buildHookConfig()` must emit the group-keyed shape above (one group, e.g. `"ctrlyoke"`, with all 5 event keys present and `null` for unused ones), not Claude's array-of-groups-per-event shape.
- The ctrlyoke logical→native event map in A.6/B.1 needs to drop `sessionStart→SessionStart` and `userPromptSubmit→UserPromptSubmit` (neither event exists) and add `PreInvocation`/`PostInvocation` as available native hooks.
- **RESOLVED**: use **`PostInvocation`** as the interactive per-turn completion signal (confirmed to fire unconditionally, once per turn, in both headless and interactive-piped tests — see the resolved sub-issue above). `Stop` also fires but only carries `fullyIdle`/`terminationReason: NO_TOOL_CALL` semantics that are unconfirmed once tool calls are involved, so it's the fallback, not primary. The hook script must **not** emit `{"decision":...}` on stdout for `PostInvocation`/`Stop` (unknown-field error) — only `PreToolUse` (and presumably `PostToolUse`) should get a `{decision}` response; `PostInvocation`/`Stop` handlers should emit `{}`.

---

## Part A — Research Findings (`agy`, run locally — 1.0.8 baseline, re-verified on 1.0.14)

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
--new-project                   Create a new project for this session            (added 1.0.12)
--project                       Project ID for the current CLI session           (added 1.0.12)

Subcommands: changelog, help, install, models, plugin/plugins, update
```

> **1.0.14 update**: `--new-project` and `--project` were added in 1.0.12. The rest of the flag surface is unchanged from 1.0.8 — still **no `--output-format`, `--stream-json`, `--session-id`, or `--mcp-config`.**

**There is NO `--output-format`, NO `--stream-json`, NO `--session-id`, NO `--mcp-config` flag.** This is the critical departure from Gemini (which ctrlyoke drives with `--prompt ... --output-format stream-json --session-id <id>`).

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

**Implication for `--model`**: `agy --model "<label>"` takes a **human-readable label**, and `agy models` (confirmed via the official tutorial; returns empty in a piped/non-TTY context, so run it in an authenticated TTY) lists **both Gemini and Claude families**:

- `Gemini 3.5 Flash` (Medium / High / Low)
- `Gemini 3.1 Pro` (Low / High)
- `Claude Sonnet 4.6 (Thinking)` (observed default)
- `Claude Opus 4.6 (Thinking)`
- `GPT-OSS 120B (Medium)` ← **added since 1.0.8** (1.0.14 model list now spans three vendors)

So the model dropdown spans multiple vendors (Gemini, Claude, GPT-OSS). The `value` stored in settings should be the exact label string `--model` expects (verify spacing/casing against `agy models` output in a TTY before finalizing the list).

### A.3 Conversations are SQLite/protobuf — NOT JSON logs

This is the most important finding for the parser design. `agy` does **not** write the human-readable `~/.gemini/tmp/<project>/chats/session-*.json` files that `GeminiLogParser` reads. Instead, under `~/.gemini/antigravity-cli/`:

- `conversations/<uuid>.db` (SQLite) and `<uuid>.pb` (protobuf) — opaque, not parseable as JSON
- `brain/<uuid>`, `implicit/<uuid>.pb` — protobuf agent state
- `cache/last_conversations.json` — maps `workspace → most-recent conversationId`
- `history.jsonl` — appends `{display, timestamp, workspace, conversationId, type}` per input
- `log/cli-<datetime>.log` — verbose **glog text** (`I0618 17:00:37.265854 ... server.go:839] ...`)

**Consequence**: there is no way to extract a rich per-tool/diff/token timeline from agy's _stored_ conversations the way `GeminiLogParser` does. The dashboard will show the **plain-text response** plus session/completion state — not the structured tool/diff/thinking event stream. Treat that as an accepted limitation for v1.

> 🔎 **Possible richer path (research item)**: agy's hooks deliver a `transcriptPath` on stdin — "the filepath of the current session log" (see A.6). If that transcript is a parseable JSON/JSONL turn log, a future `AntigravityLogParser` could read it for tool/diff events. Capture a real hook payload and inspect `transcriptPath` before deciding v1 is plain-text-only forever.

### A.4 Session ID = conversation UUID

The "session ID" is the conversation UUID (`8ab91287-cfd4-4e25-8405-8d48b9d8a8e3`). It is **not printed to stdout**. Best sources, in order of reliability:

1. `~/.gemini/antigravity-cli/log/cli-*.log` — regex `Print mode: conversation=<uuid>` / `Starting conversation update stream for <uuid>`.
2. `~/.gemini/antigravity-cli/cache/last_conversations.json` — keyed by absolute workspace path.

Resume with `--continue`/`-c` (most recent) or `--conversation <uuid>` (specific).

> ✅ **Resume bug FIXED in 1.0.9 (resolved as of 1.0.14).** Previously, `--conversation <id> -p` (headless resume) dumped the _entire_ historical transcript instead of only the new response. The 1.0.9 changelog fixes this. **Action: require `agy >= 1.0.9`** (trivially satisfied at 1.0.14) rather than the old "keep only the final turn" parser workaround. A defensive last-turn guard is still cheap insurance but no longer load-bearing.

### A.5 Headless output format = plain text (and currently fragile)

With no `--output-format` flag, `agy --print "..."` is expected to print the model's response as **plain text** to stdout. In local testing under a piped (non-TTY) stdout, `--print` exited `0` with **zero bytes** even though the log showed a conversation was created and `streamGenerateContent` was called. Likely causes: print mode needs a TTY, or quota/`--print-timeout` interaction. The parser must tolerate empty stdout gracefully.

> ⚠️ **Re-confirmed on 1.0.14 (2026-06-30) — still empty in non-TTY.** `echo … | agy -p "…"` again exits `0` with zero bytes; the cli.log shows the language server shutting down without running the turn. This did **not** improve across six releases, so treat "`-p` needs a real pty" as the working hypothesis. **This is the #1 verification item and must be done before any implementation:** spawn `agy -p` through ctrlyoke's `PtyProcessManager` (node-pty allocates a real pty, unlike a shell pipe) and confirm non-empty stdout. If it stays empty even under node-pty, the headless path is not viable and the harness must drive **interactive `-i` + `Stop` hook for every run** (the hook payload carries the response transcript and `conversationId`). Plan for that contingency rather than discovering it mid-build. (Note: `winpty` cannot be used to test this from a non-console shell — it errors `stdin is not a tty`; the test has to run from ctrlyoke's own pty or a real terminal.)

### A.6 Hooks — Claude-style events (verified via official docs)

`agy`'s hook system is modeled on **Claude's**, not Gemini's. Per [antigravity.google/docs/hooks](https://antigravity.google/docs/hooks) and the migration guide:

- **Config location**: workspace `.agents/hooks.json` **or** global `~/.gemini/config/hooks.json`.
- **Event names (Claude-style)**: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact`, `Notification`. (Gemini's `BeforeTool` → Antigravity's `PreToolUse`; tool name `run_shell_command` → `run_command`.)
- **I/O contract**: the hook script receives a **JSON object on stdin** — including `toolCall` details, **step index, `conversationId`, `workspacePaths`, `transcriptPath`** (path to the current session log), and an **artifact directory path** — and prints a **JSON object on stdout** with `{"decision": "allow" | "deny" | "ask"}`.

> **1.0.14 update**: the hook payload carries `conversationId` directly. That means **in interactive mode the session ID is available from the hook itself — no glog log parsing required** for the `-i` path. The `AntigravityLogParser` (A.3/B.1) is therefore only needed for the _headless_ path's session ID, and even there `cache/last_conversations.json` may suffice — consider deferring/simplifying the log parser accordingly.

This is essentially Claude's hook contract, so `AntigravityNotificationMonitor` and `ctrlyoke-antigravity-hook.js` should be **cloned from the Claude implementations**, not Gemini's. ctrlyoke's logical→native event map becomes:

| ctrlyoke logical    | Antigravity native                           |
| ------------------- | -------------------------------------------- |
| `stop`              | `Stop`                                       |
| `sessionStart`      | `SessionStart`                               |
| `preToolUse`        | `PreToolUse`                                 |
| `postToolUse`       | `PostToolUse`                                |
| `userPromptSubmit`  | `UserPromptSubmit`                           |
| `permissionRequest` | `PreToolUse` (decision `allow`/`deny`/`ask`) |

### A.7 Completion detection

- **Headless (`--print`)**: blocks until the turn finishes, then the process exits → use **process-exit detection** (no hook needed). The cli log also marks completion with `Stream completed for <uuid>, clearing ResponsePending` / `Language server shutting down` as a fallback.
- **Interactive (`-i`)**: use a `Stop` hook (A.6) writing a notification file, exactly like Claude's monitor. Whether to register it in workspace `.agents/hooks.json` or global `~/.gemini/config/hooks.json` is the one open choice — prefer **workspace `.agents/hooks.json`** (parallel-workflow-safe, cleaned up per-workflow) over the shared global file.

### A.8 Permissions, MCP, dirs (verified)

- **Permissions**: `--dangerously-skip-permissions` → ctrlyoke `dangerouslyAllowAll`. No `--allow-tools`/`--deny-tools` flags exist, so `allowAll`/`custom` either degrade to "prompt normally" **or** are enforced via a `PreToolUse` hook returning `{"decision":"deny"|"ask"}` (the Antigravity-native way to gate tools). Recommend the hook approach for `custom` mode.
- `--add-dir <dir>` (repeatable) for extra workspace roots.
- **MCP — supported (in scope), but the workspace path needs empirical confirmation on 1.0.14.** There is no `--mcp-config` flag, but agy reads MCP config from files:
  - Global: `~/.gemini/config/mcp_config.json` ← **confirmed present locally** and the reliable path.
  - **Workspace: `.agents/mcp_config.json`** (community guides; consistent with the `.agents/` hooks dir) ← ctrlyoke would write this per-workflow, then clean it up.
  - Format: `{ "mcpServers": { "<name>": { "command", "args", "env", "disabled" } } }`.
  - **Remote servers use `serverUrl`** (NOT Gemini's `httpUrl`/`url` — silent failure if wrong). **No per-server `timeout`** key ("no longer supported"); **no inline comments**. (A _global_ MCP launch timeout exists as a setting since 1.0.7, with `-1` to disable — not a per-server field.)
  - Migration helper: `agy plugin import gemini`.

  > ⚠️ **1.0.14 caveat — verify workspace MCP loading before relying on it.** Open issue [#60](https://github.com/google-antigravity/antigravity-cli/issues/60) reported a project-local `mcp_config.json` being _discovered but silently ignored_ (the reporter used the path `.antigravitycli/mcp_config.json`; only HOME-level config spawned servers), and the **1.0.14 changelog claims it "Fixed an MCP configuration path mismatch in the CLI and permission manager."** Because of this churn, **do not assume `.agents/mcp_config.json` loads** — write it, start a server, and confirm it actually spawns on the shipped agy version. **Fallback if it doesn't:** write to the global `~/.gemini/config/mcp_config.json` (reliable but breaks per-workflow isolation — would need careful namespacing + teardown of ctrlyoke's entries). This is the one MCP decision that can't be finalized from docs alone.

- **Config dir rename**: agy's workspace config dir is **`.agents/`** (not `.gemini/`) — relevant for MCP/hooks injection and `cleanupWorkspaceArtifacts`. Skills: global `~/.gemini/skills/`, CLI-specific `~/.gemini/antigravity-cli/skills/`; workspace agents under `.agents/`.
- `--sandbox` available but not needed for ctrlyoke.

### A.9 Net architecture decision

Antigravity is a **hybrid** — Claude-style flags **and** Claude-style hooks, but plain-text headless output and opaque stored conversations:

| Concern                      | Model it on                     | Notes                                                                                                    |
| ---------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| CLI flags / invocation       | **Claude**                      | `--print`, `-c`/`--conversation`, `--dangerously-skip-permissions`, `--add-dir`, `--model`               |
| Headless completion          | **Codex/Claude exit-based**     | process-exit; plain-text stdout                                                                          |
| Response parsing             | **plain text**                  | clone the simplest text parser; NO stream-json, NO structured stdout events                              |
| Session ID + logs            | **custom**                      | parse `~/.gemini/antigravity-cli/log/cli-*.log` + `cache/last_conversations.json`; NOT `GeminiLogParser` |
| Interactive hooks            | **Claude**                      | Claude-style events in `.agents/hooks.json`; JSON stdin/stdout `{decision}`                              |
| MCP                          | **Gemini-ish (workspace file)** | write `.agents/mcp_config.json`; `serverUrl` not `httpUrl`; cleanup after run                            |
| Permission gating (`custom`) | **Claude hook**                 | `PreToolUse` → `{"decision":"deny"\|"ask"}`                                                              |
| Tool/diff/token timeline     | **none (v1)**                   | not in stdout/stored DB; maybe via hook `transcriptPath` later (A.3)                                     |

---

## Part B — Add the `antigravity-cli` Harness

Follow `ADDING_NEW_CLI_HARNESS.md` for the layer-by-layer mechanics. Below are only the Antigravity-specific decisions and deltas.

### B.1 Harness directory — `src/core/harness/antigravity/`

#### [NEW] `AntigravityCliProvider.ts` (model on `ClaudeCliProvider.ts`)

```ts
config = {
  name: "antigravity",
  harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
  displayName: "Antigravity CLI",
  terminalName: "Antigravity",
  installHint: "Install via: agy install (or from the Antigravity website)",
  shouldStreamHeadlessOutput: true, // plain-text stream
  usesInteractiveNotificationMonitor: true, // Claude-style Stop hook (A.6)
};
```

- `buildHeadlessArgs(baseArgs, prompt)` → `["--print", prompt, ...baseArgs]` (no `--output-format`).
- `buildInteractiveArgs(baseArgs, text)` → `["--prompt-interactive", text, ...baseArgs]`.
- Model: `--model "<label>"` when set and not `MODEL_NONE` (label per `agy models`, A.2).
- Resume: `--conversation <uuid>` when a sessionId exists and `resumeSession` is on; else omit (or `-c` for "continue most recent").
- `--add-dir` for extra workspace dirs if ctrlyoke passes any.
- `checkAvailability()` / `getVersion()` → `CliProviderUtils.checkCliAvailability("agy --version")`.
- `formatFileReference()` → same as Claude (no prefix) until proven otherwise.
- **MCP (in scope, A.8)**: write `.agents/mcp_config.json` in the workspace via a tracker (model on `SettingsJsonMcpTracker`, but new file path `.agents/mcp_config.json` and the `serverUrl` key for remote servers — **not** `httpUrl`). Implement `cleanupWorkspaceArtifacts(workspaceRoot, workingFilePath)` to remove/restore `.agents/mcp_config.json` and the ctrlyoke hook entries. No `--mcp-config` CLI arg exists, so `getMcpConfigArgs()` returns `[]` after writing the file.

#### [NEW] `AntigravityResponseParser.ts` (plain-text)

Clone the **plain-text** parser shape, not Gemini's stream-json one.

- `parse(stdout, stderr, exitCode)` → `{ responseText: stdout-trimmed, success: exitCode === 0, sessionId? }`. Tolerate **empty stdout** (A.5).
- `extractSessionId(output)` → return `undefined` (UUID is not on stdout; the log parser supplies it).
- `processStreamingChunk(chunk)` → return `chunk` (plain passthrough).
- `parseTokenCounts(output)` → likely `undefined` (no token line in plain-text stdout; revisit if one appears).

#### [NEW] `AntigravityLogParser.ts` (custom — extends `BaseLogParser`)

> **1.0.14 scope reduction**: interactive mode now gets `conversationId` straight from the hook payload (A.6), so the glog scrape is only the **headless** path's session-ID source — and even there, `cache/last_conversations.json[workspaceAbsPath]` may be enough on its own. Build the `last_conversations.json` read first; only add the glog-line parsing below if that cache proves unreliable (e.g. stale under parallel workflows).

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

#### [NEW] `AntigravityNotificationMonitor.ts` (model on **Claude's** monitor)

agy's hooks are Claude-style (A.6), so clone `ClaudeNotificationMonitor`:

- `EVENT_MAP` = identity-ish Claude mapping: `stop→Stop`, `sessionStart→SessionStart`, `preToolUse→PreToolUse`, `postToolUse→PostToolUse`, `userPromptSubmit→UserPromptSubmit`, `permissionRequest→PreToolUse`.
- `buildHookConfig()` → write Claude-shaped hook entries into **workspace `.agents/hooks.json`** (preferred over global `~/.gemini/config/hooks.json` for parallel-workflow isolation + clean teardown). The hook command runs `ctrlyoke-antigravity-hook.js <notifyDir>`.
- `getNotificationDirectory()` → `.ctrlyoke/temp/antigravity-notifications/`.
- **Headless**: still exit-based (process-exit), no hook needed; the `Stop` hook is for interactive mode.

#### [NEW] `AntigravityToolPermissionMapper.ts`

- `dangerouslyAllowAll` → `["--dangerously-skip-permissions"]`.
- `allowAll` → `[]` (no native allow-list flag).
- `custom` → no CLI flag; enforce via a `PreToolUse` hook returning `{"decision":"deny"|"ask"}` (A.8). For v1, `[]` + a TODO is acceptable if hook-based gating is deferred.

#### [NEW] Hook script — `src/scripts/ctrlyoke-antigravity-hook.js` (clone Claude's)

Now **in scope**. agy's hook I/O matches Claude's contract: JSON on stdin (incl. `toolCall.args`, `workspacePaths`, `transcriptPath`), JSON on stdout. Clone `ctrlyoke-claude-hook.js`, using `initializeLogger` + `readStdinJson` from `ctrlyoke-hook-utils`, writing the notification file to `argv[2]`. For permission-gating events, emit `{"decision": ...}`; for `Stop`, write the completion notification file.

### B.2 Type, wiring, settings, UI, schema layers

Mechanical — follow `ADDING_NEW_CLI_HARNESS.md` exactly, substituting `antigravity`/`ANTIGRAVITY_CLI`/`AntigravityCli`. Specific values:

- **`DashboardConstants.ts`**: `HARNESS_IDS.ANTIGRAVITY_CLI = "antigravity-cli"`; `HARNESS_INFO`/`HARNESS_DISPLAY_NAMES` → `{ name: "Antigravity CLI", shortName: "Antigravity" }`; `HARNESS_DEFAULT_MODELS` → observed default (`Claude Sonnet 4.6 (Thinking)`); `ANTIGRAVITY_CLI_MODELS` list spans **Gemini, Claude, and GPT-OSS families** (A.2 — now includes `GPT-OSS 120B (Medium)`), values = exact `agy models` labels.
- **`CtrlYokeTypes.ts`**: `Harness.AntigravityCli = "antigravity-cli"`.
- **`IntegrationFactory.ts`** / **`WorkflowOrchestrator.ts`**: factory method, switch case, field, construction, registration, init, `getIntegrationForHarness`, `setWorkflowName`, display label `[Harness.AntigravityCli]: "Antigravity CLI"`.
- **`ConfigurationUtils.ts`**: `antigravityCliModel` / `antigravityCliAdditionalArgs` keys, `normalizeHarness`, `getAntigravityCliModel()`, `getModelForHarness` case.
- **`ModelConstants.ts`**: `ANTIGRAVITY_CLI_MODELS`, `ANTIGRAVITY_CLI_MODEL_LABELS`, type, `isAntigravityCliModel`, `getModelDisplayName` case, and a `getAntigravityModelName` / context-window helper if the provider needs one.
- **`CtrlYokeSettings.ts`**: default model in `CTRLYOKE_SETTINGS_DEFAULTS.defaults.models["antigravity-cli"]`.
- **`SessionValidator.ts`**: add `case HARNESS_IDS.ANTIGRAVITY_CLI` (UUID v4 — same validation as Gemini used).
- **`HarnessDirectoryUtils.ts`**: agent/skill dirs (verified, A.8): workspace agents under `.agents/`; global skills `~/.gemini/skills/`; CLI-specific skills `~/.gemini/antigravity-cli/skills/`. Do **not** assume `.antigravity/`.
- **`cli.ts`**: add `antigravity-cli` to the `--harness` description string.
- **`package.json`**: harness enum + description, `ctrlyoke.antigravityCliModel` (order 450), `ctrlyoke.antigravityCliAdditionalArgs` (order 451).
- **UI**: `WebviewSettingsSync.ts`, `HarnessDropdown.tsx` (display name + `CLI_HARNESSES`), `settingsStore.ts`, `HarnessIcon.tsx` (add an Antigravity icon).
- **Schemas**: `workflow-schema.json` + `settings-schema.json` enums/properties, then `npm run generate-schema`.
- **`scripts/sync-models.mjs`**: add an `antigravityModels` block parallel to (replacing) the Gemini one.
- **Docs**: `.github/copilot-instructions.md` harness + debug-log table; `docs/harnesses/antigravity-cli.md` (+ index/installation/concepts/settings).
- **Tests**: `harnessRunner.ts` union + default model; `hooks.harness.test.ts` only if hooks land; **`AntigravityResponseParser.test.ts`** + **`AntigravityLogParser.test.ts`** (plain-text parse, empty-stdout tolerance, UUID extraction from glog lines, `last_conversations.json` fallback).

---

## Part C — Remove the `gemini-cli` Harness

Delete Gemini everywhere it was added (the inverse of `ADDING_NEW_CLI_HARNESS.md`), plus the extra touchpoints found via grep. ~110 code references across 20 `src` files, plus docs/tests/schemas.

### C.1 Delete files

- `src/core/harness/gemini/` (whole dir: `GeminiCliProvider.ts`, `GeminiResponseParser.ts`, `GeminiNotificationMonitor.ts`, `GeminiToolPermissionMapper.ts`, `GeminiLogParser.ts`)
- `src/scripts/ctrlyoke-gemini-hook.js`
- `docs/harnesses/gemini-cli.md`

### C.2 Type layer

- `CtrlYokeTypes.ts` — remove `Harness.GeminiCli`.
- `DashboardConstants.ts` — remove `HARNESS_IDS.GEMINI_CLI`, its `HARNESS_INFO`/`HARNESS_DISPLAY_NAMES`/`HARNESS_DEFAULT_MODELS` entries, and `GEMINI_CLI_MODELS` (13 refs).
- `CtrlYokeSettings.ts` — remove `"gemini-cli"` default model.

### C.3 Wiring layer

- `IntegrationFactory.ts` — remove import, `createGeminiCli()`, switch case (5 refs).
- `WorkflowOrchestrator.ts` — remove field, construction, registration, init, resolution case, `setWorkflowName`, display label (8 refs).

### C.4 Settings layer

- `ConfigurationUtils.ts` — remove model key, args key, `normalizeHarness` cases, `getGeminiCliModel()`, `getModelForHarness` case (6 refs).
- `ModelConstants.ts` — remove `GEMINI_CLI_MODELS`, `GEMINI_CLI_MODEL_LABELS`, `GeminiCliModel`, `isGeminiCliModel`, `getGeminiModelName`, `getGeminiContextWindowSize`, `getModelDisplayName` case (8 refs). **Check call sites** — `getGeminiModelName`/`getGeminiContextWindowSize` are referenced by `GeminiCliProvider`/`GeminiLogParser` (being deleted) but grep for any stragglers.
- `SessionValidator.ts` — remove `case HARNESS_IDS.GEMINI_CLI` + doc lines (2 refs).
- `HarnessDirectoryUtils.ts` — remove all 5 `GEMINI_CLI` agent/skill/extension entries; update the "Codex, Gemini, Qwen…" comment.
- `cli.ts` — drop `gemini-cli` from the `--harness` description.
- `package.json` — remove `gemini-cli` from harness enum/enumDescriptions/markdownDescription and delete `ctrlyoke.geminiCliModel` + `ctrlyoke.geminiCliAdditionalArgs`.

### C.5 UI layer

- `WebviewSettingsSync.ts` — remove import, initial availability, `VALID_CLI_HARNESSES` entry, model/args maps, model options (9 refs).
- `HarnessDropdown.tsx` — remove display name + `CLI_HARNESSES` entry.
- `settingsStore.ts` — remove import, model array, initial availability, `modelsByHarness` (4 refs).
- `permissionUtils.ts` — remove the Gemini ref (1).
- Also check: `PropertiesDrawer.tsx`, `WorkflowPropertiesPanel.tsx`, `HarnessesSection.tsx`, `AdvancedPermissionsSection.tsx`, `HarnessIcon.tsx` (icon mapping) — remove Gemini entries.

### C.6 Schemas

- `schemas/workflow-schema.json` — remove `"gemini-cli"` from harness enum.
- `schemas/settings-schema.json` — remove from `defaults.harness`, `models`, `additionalArgs`.
- Run `npm run generate-schema` to regenerate `schemas/workflow-schema.yaml`.

### C.7 Shared infra — comments only (no logic change)

These mention Gemini in comments/lists but the code is generic; just update the wording:
`CliIntegration.ts:1453`, `INotificationMonitor.ts` (49, 511), `CodexNotificationMonitor.ts` (21, 52), `CliProviderUtils.ts` (295, 299). The `SettingsJsonMcpTracker`/`SettingsJsonHooksTracker` `"gemini"` singleton instances live in `GeminiCliProvider` (deleted) — confirm no other harness instantiates `getInstance("gemini")`.

### C.8 Tests

Remove Gemini from: `harnessRunner.ts`, `hooks.harness.test.ts`, `ModelConstants.test.ts` (11 refs), `ToolPermissionMappers.test.ts`, `HarnessToolPermissionMappers.test.ts`, `CtrlYokeConfigService.test.ts` (6 refs), `SettingsJsonHooksTracker.test.ts`, `WorkflowInstance.test.ts`. Where a test needs a representative "settings.json hook" harness and Gemini was the example, switch it to Qwen (which uses the same mechanism).

### C.9 Docs / misc

`.github/copilot-instructions.md` (harness + debug-log table), `docs/harnesses/index.md`, `docs/guide/installation.md`, `docs/guide/concepts.md`, `docs/reference/settings.md`, `docs/.vitepress/config.mts`, `README.md`, `QUICK_START.md`, `CHANGELOG.md` (add a removal entry), `scripts/discovered-models.json` (drop Gemini models), `scripts/sync-models.mjs` (remove the `geminiModels` block — superseded by `antigravityModels`), `src/ui/webview-react/static/dictionaries/en_US/en_US.dic` (remove "gemini" if present), `dev/reference/old-vscode-flightpath-settings.json` (historical filename — leave as-is).

> Leave historical planning docs under `dev/implemented/` and `dev/research/` (e.g. `GEMINI_INTEGRATION_PLAN.md`) **as-is** — they are a record of past work, not live config.

---

## Combined Checklist

### Research (do first, while authenticated in a TTY)

- [x] **(#1 blocker) RESOLVED 2026-07-05, better than hoped.** Reproduced ctrlyoke's _actual_ headless spawn (`CliProcessManager.spawn` — plain `child_process.spawn`, `stdio:["ignore","pipe","pipe"]`, `shell:false`, **not** node-pty) against `agy -p "..."` on 1.0.16: exit 0, clean non-empty plain-text stdout, no ANSI codes. Root cause of the old empty-stdout finding was a Windows non-TTY bug, fixed in **1.0.15** per changelog. Action: gate on `agy >= 1.0.15`. No `-i`+`Stop`-hook-for-all-runs fallback needed — see the 2026-07-05 delta section above.
- [x] **MCP loading — RESOLVED 2026-07-05, negative result.** Tested with a real, working MCP server (ctrlyoke's own `out/mcp-server.js`) in both workspace `.agents/mcp_config.json` and global `~/.gemini/config/mcp_config.json`, in both headless `-p` and interactive `-i` modes, with a prompt that forced a tool-call attempt. **In every combination, the tool never became callable** — in interactive mode the permission system prompted for `mcp(*/ctrlyoke_queue_status)` (proving the model tried), but the model then reported the server "may not be connected/active." **Conclusion: MCP is non-functional in this build (1.0.16) regardless of config location. Drop MCP support from v1 scope.** See the 2026-07-05 part 2 delta section above.
- [x] `agy models` (via plain-pipe spawn, no TTY needed — same 1.0.15 fix applies) → confirmed exact label strings on 1.0.16: `Gemini 3.5 Flash (Medium/High/Low)`, `Gemini 3.1 Pro (Low/High)`, `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, `GPT-OSS 120B (Medium)` (A.2)
- [x] **Captured the real hooks.json schema — RESOLVED 2026-07-05, major correction to A.6.** Drove the CLI's own `/hooks` TUI (found via `agy.exe`'s embedded Go symbol strings) to create a hook through the product's own UI and read what it wrote. Real event list is only 5 items — `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` — **not** the 9-event Claude-style list A.6 assumed (`SessionStart`/`SessionEnd`/`UserPromptSubmit`/`PreCompact`/`Notification`/`SubagentStop` don't exist). Schema is **group-name-keyed** (`{"<groupName>": {"PreToolUse": [...]|null, ..., "Stop": [...]|null}}`), inverted from Claude's event-name-keyed shape.
- [x] **`PreInvocation`/`PostInvocation`/`Stop` firing — RESOLVED 2026-07-05 (later session).** A probe hook script wired to all 5 events confirmed `PreInvocation` → `PostInvocation` → `Stop` all fire, once per turn, in both headless (`-p`) and interactive-piped (`-i`) runs — contradicting the earlier "`Stop` never fires" finding, which was most likely caused by a bad hook response (see next item) rather than a real limitation. **Use `PostInvocation` as the primary interactive completion signal** (fires unconditionally); `Stop` is the fallback since its payload includes `fullyIdle`/`terminationReason` fields whose behavior around tool calls is unconfirmed. See the resolved sub-issue in the 2026-07-05 part 2 delta section above for full payload shapes.
- [x] **Hook stdout contract — `{"decision":...}` is `PreToolUse`-only.** Returning `{"decision":"allow"}` from a `PreInvocation`/`PostInvocation`/`Stop` handler produces a logged `protojson: unknown field "decision"` error (turn still completed in testing, but this should not be relied on). `ctrlyoke-antigravity-hook.js` must only emit `{decision}` for `PreToolUse`/`PostToolUse`; the invocation/stop handlers should emit `{}`.
- [x] `agy --version` ≥ 1.0.9 → **satisfied (1.0.16)**; headless-resume transcript-dump bug is fixed (A.4); session ID + completion markers reconfirmed live in the CLI log on 1.0.16 (see 2026-07-05 delta, item 6)

### Add Antigravity

- [ ] `src/core/harness/antigravity/` — `AntigravityCliProvider`, `AntigravityResponseParser` (plain-text), `AntigravityLogParser` (custom glog), `AntigravityNotificationMonitor` (group-keyed hook config per the 2026-07-05 part 2 schema — try `PostInvocation` for interactive completion, not `Stop`), `AntigravityToolPermissionMapper`
- [ ] `src/scripts/ctrlyoke-antigravity-hook.js` (I/O contract still JSON stdin/stdout like Claude's, but hook config shape is agy's own group-keyed format, not Claude's)
- [x] **MCP: `.agents/mcp_config.json` writer/tracker — IMPLEMENTED and WORKING (2026-07-06).** `AntigravityCliProvider.getMcpConfigArgs` writes a bare `{ mcpServers }` object to the workspace `.agents/mcp_config.json` via a shared `SettingsJsonMcpTracker` singleton (generalized to accept custom project/user config paths — agy uses `.agents/mcp_config.json` + `~/.gemini/config/mcp_config.json`). Remote servers use `serverUrl` (not `url`/`type`) and no `trust` field, via new `buildSettingsJsonMcpEntries` options. No `--allowed-mcp-server-names` flag exists on agy, so parallel workflows in one workspace share the file's servers (no per-prompt scoping). **MCP is NOT broken in agy 1.0.16 — confirmed working by manual testing (Nathan called MCP tools successfully, multiple times). No gate.** The earlier "hangs on startup / non-functional" findings (2026-07-05 part 2 delta) were a mis-diagnosis: the real symptom was agy headless **resolving the relative prompt-file path (`.ctrlyoke/temp/…prompt.md`) inconsistently** — its agent sometimes anchors relative paths to the workspace cwd and sometimes wanders the filesystem from the home dir searching for the file (reproduced 2026-07-06: two near-identical `agy --print` runs with a relative ref gave `FOUNDABS` vs a 60s+ wander/timeout). agy's process cwd IS the workspace (`workspaceDirs=[C:\dev\ctrlyoke]` in the log), so this is an agent-side relative-path quirk, not a spawn-cwd bug. **Fix (superseded, 2026-07-07): `usesAbsoluteFileReferences: true` on the Antigravity `HarnessConfig`** — `CliIntegration.formatDirectFileRef`/`formatTempFileRef` then emit absolute paths for all injected references (prompt/agent/skills/context/@-mentions). Verified: an absolute-path `--print` ref resolves deterministically (`FOUNDABS`). **Update (2026-07-07): agy fixed the underlying relative-path resolution as long as `--add-dir` is set (already the case — see `getWorkspaceDirs`/`--add-dir` wiring above), so the hard-coded `usesAbsoluteFileReferences` workaround was removed; Antigravity now follows the same `ui.useAbsolutePathReferences`/multi-root rule as every other harness (see `ABSOLUTE_FILE_REFERENCE_MODE_PLAN.md`).** Test agy with `--model "Gemini 3.5 Flash (Low)"` — the default (Sonnet) has a tiny quota that exhausts for ~28h.
- [ ] Type/wiring/settings/UI/schema layers per Part B.2
- [ ] `npm run generate-schema`
- [ ] Tests: `AntigravityResponseParser.test.ts`, `AntigravityLogParser.test.ts`, `hooks.harness.test.ts` (Claude-style events); update `harnessRunner.ts`
- [ ] Docs: `docs/harnesses/antigravity-cli.md`, copilot-instructions tables

### Remove Gemini (Part C)

- [ ] Delete harness dir, hook script, doc page (C.1)
- [ ] Type / wiring / settings / UI / schema removals (C.2–C.6)
- [ ] Comment cleanups (C.7)
- [ ] Test removals / re-point to Qwen (C.8)
- [ ] Docs / scripts / dictionary (C.9)
- [ ] **Note**: removing Gemini does _not_ free agy's MCP/skills dirs — agy reuses `~/.gemini/`. Don't delete `~/.gemini/`-related path handling that Antigravity now depends on.

### Verification

- [ ] `npm run typecheck` — zero errors (catches every missed Gemini reference)
- [ ] `npm run compile`
- [ ] `npm test` — existing pass; new Antigravity parser/log tests pass
- [ ] Grep `gemini`/`Gemini`/`GEMINI` over `src/` → only generic/unrelated hits remain
- [ ] Manual: set harness to `antigravity-cli`, confirm "Available", run a 1-step headless workflow (response captured via plain-text stdout), run a 2-step `resumeSession` workflow (UUID resume via `--conversation`)

---

## Estimated Effort

**6–8 hours** _once the two research blockers are resolved_ (headless `-p` viability under node-pty, and workspace MCP loading). The plain-text parser + exit-based headless completion are simpler than Gemini's stream-json, but the Claude-style hooks, the `.agents/mcp_config.json` writer/cleanup, and the hook script bring it back to par. The Gemini removal is mechanical but touches ~20 `src` files — lean on `npm run typecheck` to find every site.

Lowest-risk sequencing: **(0)** **resolve the headless `-p` pty question first** (A.5) — it determines whether step 1 is even viable; **(1)** ship headless (`--print` + exit + `last_conversations.json` session ID) _if_ `-p` works under pty, else go straight to interactive `-i` + `Stop` hook as the primary path; **(2)** add/confirm the Claude-style `Stop` hook (interactive mode + session ID from `conversationId` payload); **(3)** add MCP via `.agents/mcp_config.json` _after confirming it loads_, with global-file fallback; **(4)** remove Gemini last (so a working harness exists before the old one is deleted).

---

## Sources

- `agy --help`, `agy changelog`, `agy models`, `agy plugin`, and on-disk inspection of `~/.gemini/` + `~/.gemini/antigravity-cli/` (local — original v1.0.8, **re-verified v1.0.14 on 2026-06-30**)
- [Issue #60 — project-local `mcp_config.json` ignored](https://github.com/google-antigravity/antigravity-cli/issues/60) — workspace MCP path churn; 1.0.14 "MCP config path mismatch" fix
- [agy CHANGELOG (1.0.7–1.0.14)](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md) — 1.0.9 headless-resume fix, 1.0.12 `--project`/`--new-project`, 1.0.14 MCP path fix
- [Configuring MCP Servers and Skills for Antigravity CLI (Dazbo, Google Cloud Community)](https://medium.com/google-cloud/configuring-mcp-servers-and-skills-for-antigravity-cli-and-ide-a938c7eebb78) — `serverUrl`, no per-server `timeout`, skills paths
- [Antigravity Hooks docs](https://antigravity.google/docs/hooks) — event names, JSON stdin/stdout `{decision}`, `transcriptPath`
- [Migrating to Antigravity CLI (Google Cloud Community / Medium)](https://medium.com/google-cloud/migrating-to-antigravity-cli-a841c6964f37) — `.gemini/`→`.agents/`, `BeforeTool`→`PreToolUse`, MCP file locations
- [Configuring MCP Servers and Skills for Antigravity CLI (Deven Goratela)](https://devengoratela.com/2026/05/configuring-mcp-servers-and-skills-for-antigravity-cli-and-ide/) — `mcp_config.json` schema, `serverUrl` vs `httpUrl`, no `timeout`
- [Antigravity CLI Tutorial Series (Google Cloud Community / Medium)](https://medium.com/google-cloud/antigravity-cli-tutorial-series-12b46cfe3bf2) — `agy models` list, `--print` behavior, resume flags
- [Antigravity CLI Cheatsheet (scriptbyai)](https://www.scriptbyai.com/antigravity-cli-cheatsheet/) — `/hooks`, `/resume`, MCP locations
- Official repo: [`google-antigravity/antigravity-cli`](https://github.com/google-antigravity/antigravity-cli)

Note from nathan: I have a session that contains file edits here C:\Users\natha\.gemini\antigravity-cli\conversations\7e581470-492e-4fec-80e7-1b60dc721cc8.db if we need to test db parsing after we implement this.
