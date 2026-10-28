# Harness-Agnostic Hook Decision Format Plan

**Status:** Partly shipped (Phase 1 docs and the OpenCode compatibility caveats); Phase 2 not started.

## Status (2026-10-26)

Shipped:

- **Hook environment documented.** `docs/workflows/hooks.md` ("Environment" table) lists
  `CTRLYOKE_WORKFLOW_NAME`, `CTRLYOKE_PROMPT_NAME`, `CTRLYOKE_PROMPT_INDEX`,
  `CTRLYOKE_PARALLEL_GROUP_ID`, `CTRLYOKE_HARNESS_ID`, `CTRLYOKE_WORKSPACE_ROOT` and
  `CTRLYOKE_WORKING_FILE`, with an example script that reads `CTRLYOKE_HARNESS_ID` (Phase 1
  item 3, apart from a per-harness _branching_ example).
- **Compatibility no longer overstates OpenCode.** `OpenCodeNotificationMonitor` declares
  `preToolUse` partial with `HOOK_CAVEAT_CODES.CANNOT_BLOCK` (`75eb666c3`) and
  `permissionRequest` partial with `HOOK_CAVEAT_CODES.DECISION_UNSUPPORTED` (OpenCode 1.19.4
  delivers `permission.asked` only through the plugin event callback, which has no reply
  channel; `38e3e4d96`). `docs/harnesses/compatibility.md` shows both as partial.
- **Per-hook `env`.** Hooks with `env` now run through the `out/scripts/ctrlyoke-hook-run.js`
  launcher (`src/core/harness/shared/UserHookEnvironment.ts`), which reads a per-step temp
  JSON file keyed by hook ID. It still pipes stdio through unchanged, but it is the natural
  place to hang Phase 2's wrapping.

Remaining: Phase 1 items 1 (single-source the names in `CTRLYOKE_ENV_VARS`, which still holds
only `WORKING_FILE`) and 4 (per-harness forwarding evidence), and all of Phase 2.

## Problem

A user who wants one tool-approval script for every harness cannot write one today. ctrlyoke
maps the logical event name (`preToolUse`, `permissionRequest`) to each harness's native event,
then registers the user's `command` verbatim. The script receives the harness's raw stdin payload,
and its stdout and exit code go straight back to that harness. Nothing is translated in either
direction, so a guard script has to:

- parse a different payload per harness (Claude sends `tool_name`/`tool_input`, Copilot sends
  `toolName`/`toolArgs`, and so on);
- answer in each harness's own decision format;
- know which harness invoked it, which today means knowing about an undocumented environment
  variable (see below).

On OpenCode it cannot deny at all. The ctrlyoke plugin's `tool.execute.before` runs `preToolUse`
hooks through `_runUserHooks` (async `spawn` with a stable JSON stdin payload, stdout not
captured, errors swallowed), and OpenCode only blocks a tool when the plugin throws.

`docs/harnesses/compatibility.md` now marks OpenCode's Pre Tool Use partial (cannot block), but
still shows the other five as plainly supported. That is true for "the hook fires" and
unverified for "the hook can block", which is what a guard needs.

## Current state

### Hook registration (verbatim passthrough)

| Harness     | Where user hooks are registered                                                  | `preToolUse` decision today                                    |
| ----------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Claude      | `ClaudeNotificationMonitor.buildHookConfig` / `buildUserOnlyConfig` (headless)   | Native contract, verbatim command                              |
| Codex       | `CodexCliProvider.buildUserHooksSection` via `createCodexCommandHookGroup`       | Native contract, verbatim command                              |
| Copilot     | `CopilotNotificationMonitor` (`bash` and `powershell` keys, `timeoutSec ?? 10`)  | Native contract, verbatim command                              |
| Qwen        | `QwenNotificationMonitor.buildHookConfig` (via `QwenCliProvider`)                | Native contract, verbatim command                              |
| Antigravity | `AntigravityNotificationMonitor` (`pushHandler(nativeEvent, hook.command)`)      | Native contract (unrecorded), verbatim command                 |
| OpenCode    | `ctrlyoke-opencode-plugin.ts`, hooks passed as JSON in `CTRLYOKE_OPENCODE_HOOKS` | **Cannot deny**: fire-and-forget `_runUserHooks("preToolUse")` |

The only wrapped path is `permissionRequest`. `INotificationMonitor.encodePermissionRequestHook`
base64-encodes the first user `permissionRequest` command and appends it to ctrlyoke's own hook
script invocation, and `dispatchPermissionRequest` / `runDecisionHook` in
`src/scripts/ctrlyoke-hook-utils.js` run it, piping the native payload to stdin and forwarding
stdout and the exit code unchanged. That exists so ctrlyoke's notification hook and the user's
decision hook can share one native event, not to translate anything. OpenCode has no decision
path any more: `permission.asked` arrives through the plugin event callback and runs
`permissionRequest` hooks as notifications only (`HOOK_CAVEAT_CODES.DECISION_UNSUPPORTED`).

User hooks with an `env` block are wrapped in the `ctrlyoke-hook-run.js` launcher
(`UserHookEnvironment.prepareUserHookEnvironments`), which still passes stdin/stdout/exit code
through unchanged.

None of the native `preToolUse` decision contracts is recorded or tested in the repo. The
compatibility registry carries `CANNOT_BLOCK` on OpenCode's `preToolUse` and
`DECISION_UNSUPPORTED` on OpenCode's `permissionRequest`; `UNVERIFIED_DECISION_CONTRACT` exists
but is no longer used by any harness.

### Harness identity for hooks

`CliExecutionRunner.buildHookEnvVars` already sets `CTRLYOKE_HARNESS_ID` (the `HARNESS_IDS`
value, e.g. `claude-cli`) on every harness process, headless and interactive, alongside
`CTRLYOKE_RUN_ID`, `CTRLYOKE_WORKFLOW_ID`, `CTRLYOKE_WORKFLOW_NAME`, `CTRLYOKE_PROMPT_INDEX`,
`CTRLYOKE_PROMPT_NAME`, `CTRLYOKE_PARALLEL_GROUP_ID`, `CTRLYOKE_WORKSPACE_ROOT` and
`CTRLYOKE_WORKING_FILE` (`src/core/harness/shared/CliExecutionRunner.ts`). Hook processes inherit
it from the harness, and `docs/workflows/hooks.md` documents them. The remaining gaps:

- Only `CTRLYOKE_WORKING_FILE` is single-sourced in `CTRLYOKE_ENV_VARS`
  (`src/types/DashboardConstants.ts`); the rest are string literals in `CliExecutionRunner` and
  read back as literals in `ctrlyoke-hook-utils.js` and the OpenCode plugin.
- No test asserts that a user hook actually sees it. It reaches the hook only because each harness
  passes its own environment to hook children, and that is an assumption per harness, not a
  checked fact.

## Proposal

### Phase 1: Make the harness environment a documented contract

This ships on its own. It already lets users branch per harness in their own scripts, which covers
the workaround case without waiting for Phase 2.

1. Move every hook-visible variable name into `CTRLYOKE_ENV_VARS` and use the constants in
   `CliExecutionRunner`. The `.js` hook scripts and the OpenCode plugin cannot import TypeScript
   constants at runtime; leave their literals and add a comment naming the constant they mirror.
2. Keep the name `CTRLYOKE_HARNESS_ID`. It is already set and already read by the hook scripts, and
   its value is exactly a `HARNESS_IDS` member, so the name says what the value is.
3. ~~Add a user-facing page listing each variable~~ Done (`docs/workflows/hooks.md`). Optionally
   add a short per-harness branching example script there.
4. Test, per harness, that a user hook's process sees `CTRLYOKE_HARNESS_ID`. The unit level can
   assert the built env; the claim that the harness forwards it to hook children needs either a
   real-harness case in `src/test/harness/**` or a recorded manual verification per harness.

### Phase 2: One ctrlyoke decision format

**Opt-in per hook.** Add `format: "native" | "ctrlyoke"` to the hook object (default `"native"`),
so existing harness-specific scripts keep receiving native payloads. A hook with
`format: "ctrlyoke"` is valid only on decision events (`preToolUse`, `permissionRequest`); reject
it elsewhere in schema validation. Schema change: describe the format in the property
`description`, then run `npm run schema:update`. `HooksEditor.tsx` gets the control, and the field
goes into `AUTHORED_STEP_FIELDS` (`WorkflowStepSanitizer.ts`) coverage (see `test.instructions.md`, the round-trip
suites).

**Input** (stdin, one JSON object):

```json
{
  "version": 1,
  "harness": "claude-cli",
  "event": "preToolUse",
  "tool": "Bash",
  "input": { "command": "sed -i 's/a/b/' src/x.ts" },
  "cwd": "C:/dev/project",
  "native": { "...": "the harness's original payload, untouched" }
}
```

`tool` is the harness's own tool name; normalizing tool names across harnesses is out of scope
(see below). `input` carries the fields a guard usually needs, normalized when the harness exposes
them: `command` for shell tools, `path` for file tools. `native` is always present, so a script can
fall back to harness-specific fields without switching format.

**Output** (stdout, one JSON object, all fields optional):

```json
{ "decision": "allow" | "deny" | "ask", "reason": "shown to the agent on deny" }
```

- No output, empty output, or no `decision`: no opinion; the harness proceeds as if the hook were
  absent.
- `ask`: falls back to "no opinion" on harnesses with no ask equivalent. Record which those are in
  the capability declaration.
- Invalid JSON, a crash, or a timeout: no opinion (fail open), logged to the harness's hook debug
  log. Fail-closed is a possible later option for guard scripts; do not add it until someone asks.
- Several `format: "ctrlyoke"` hooks on one event: run all of them; any `deny` wins, then `ask`,
  then `allow`. Combine deny reasons.

**Routing.** When any resolved hook for a decision event has `format: "ctrlyoke"`, register
ctrlyoke's own hook script on that native event (it is often already registered for
notifications), and do not also register those commands verbatim. The script runs them and
translates the result:

- Put the translation in `ctrlyoke-hook-utils.js`, next to `runDecisionHook`: one normalizer from
  native payload to the input above, and one renderer from the decision to the native reply, per
  harness. All five config-file harnesses' hook scripts already require that module.
- Pass the hook list through the environment as process-local JSON (like
  `CTRLYOKE_OPENCODE_HOOKS`), not base64 on the command line. A list of commands with per-hook env
  can exceed `cmd.exe`'s 8191-character limit, and Qwen's and Antigravity's command quoting is
  already fragile (see the comments in their notification monitors).
- Headless matters: Claude headless today uses `buildUserOnlyConfig` with no ctrlyoke script, and
  the hook scripts expect a notify directory argument. The wrapper has to work in both modes.
- OpenCode: replace the fire-and-forget `_runUserHooks("preToolUse")` in `tool.execute.before`
  with a decision run (capture stdout), and throw an `Error(reason)` on deny, then lift the
  `CANNOT_BLOCK` caveat. `permissionRequest` stays notification-only until OpenCode exposes a
  reply channel (`DECISION_UNSUPPORTED`); reject `format: "ctrlyoke"` there or document it as
  no-op.
- Per-hook `env` already goes through a per-step temp JSON file read by `ctrlyoke-hook-run.js`;
  reuse that file (or extend the launcher) for the wrapped hook list rather than inventing a
  second transport.
- Timeouts: the user hooks now run inside ctrlyoke's hook process, so they share the harness's
  per-hook timeout (Copilot defaults to 10s in `CopilotNotificationMonitor`). Size the native
  timeout from the sum of the wrapped hooks' `timeoutSec`.

**Per-harness native contracts.** Before implementing each renderer, verify and record that
harness's `preToolUse` deny/allow reply and payload fields, with the CLI version checked. Starting
points, all unverified: Claude blocks on exit code 2 or
`hookSpecificOutput.permissionDecision: "deny"`; Copilot reads a flat
`{"permissionDecision": "deny", "permissionDecisionReason": "…"}`; Codex, Qwen and Antigravity
need checking from scratch. A harness whose contract cannot be verified gets
`UNVERIFIED_DECISION_CONTRACT` instead of a renderer that guesses.

**Compatibility.** Add a "Pre Tool Use decisions" capability (and the same for Permission Request)
to the harness capability declarations, separate from "the event fires". Regenerate
`docs/harnesses/compatibility.md` with `scripts/generate-compatibility-docs.mjs`; never hand-edit
it.

## Out of scope

- **Cross-harness tool-name normalization** (mapping Claude `Bash`, Copilot `shell`, and so on to
  one vocabulary). Useful, but it is a maintained table that drifts with every CLI release. `tool`
  stays native; scripts that need it can branch on `harness`.
- **A global hook tier that workflows cannot replace.** `resolveHooks`
  (`src/types/ExecutionPropertyResolver.ts`) lets a workflow's own `hooks` replace the settings
  defaults entirely, so a guard configured as a default is dropped by any workflow that defines
  even a `stop` hook. A guard needs an always-appended tier. Plan it separately; it touches the
  settings schema and the inheritance UI, not the decision format.
- **Rewriting tool input** (Claude's `updatedInput` and similar). Decisions only.

## Tests

- `src/test/unit/NotificationHookScripts.test.ts`: per harness, a native payload in gives the
  normalized input; each decision out gives the verified native reply. Cover no output, invalid
  JSON, a crashing hook, and several hooks combining (deny wins).
- Provider and monitor tests: a `format: "ctrlyoke"` hook is routed through the ctrlyoke script and
  not registered verbatim; a `format: "native"` hook is unchanged. Both modes, interactive and
  headless.
- OpenCode plugin: deny throws, with the reason; no opinion does not.
- `src/test/unit/HarnessCapabilityRegistry.test.ts`: the new decision capabilities.
- Webview: `HooksEditor` exposes `format` only on decision events; schema round-trip suites stay
  green without opt-outs.
- Phase 1: `CliExecutionRunner` env includes `CTRLYOKE_HARNESS_ID` for every harness, built from
  `CTRLYOKE_ENV_VARS`.
