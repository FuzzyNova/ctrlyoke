# Cross-Harness Tool Permission Parity Plan

> **Status:** In progress
>
> **Priority:** P0 — release gate for 0.1.0
>
> **Parent architecture:**
> [`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md)

This plan is implemented in full before 0.1.0 ships, not split into a pre-launch
honesty slice and a post-launch parity slice. The staging below is therefore an
engineering sequence, not a release boundary: no stage is deferred past release,
and the honest-UI stage is built directly on the shared registry rather than as
a throwaway stopgap.

Capability _classifications_ still change as the sequence progresses. Qwen's
inline allow/deny flags are supported and manually verified; it does not need a
workspace settings mutation. OpenCode's workspace-config implementation landed
on 2026-07-30, with real-CLI behavioral verification still required before its
capability declaration advances to verified support.

---

## Problem

ctrlyoke exposes a shared `toolPermissions` model:

- permission mode;
- allowed tool patterns;
- denied tool patterns.

The coarse permission mode has a meaningful provider mapping, but granular tool
lists are not reliably enforced across the supported harnesses.

Current code overstates support in several places:

- Qwen's earlier silent-deny failure was traced to its headless input mode, not
  to an absence of inline allow/deny support. The canonical tool-name mapping
  plus `--input-format stream-json` path is manually verified; automated
  real-harness regression coverage remains to be added.
- `getPermissionHarnessSupport()` in
  `src/ui/webview-react/components/shared/permissionUtils.ts` classifies only
  Codex, OpenCode, and Antigravity as `mode-only`; every other harness falls
  through to `"full"`. Qwen therefore reports **full granular support** in the
  UI today, so a user's Denied Tools list is presented as enforced while the
  flags carrying it are unverified. This is the most acute instance of the
  problem and the first thing the honesty work must correct.
- OpenCode previously promised an `opencode.json` permission side effect that
  did not exist. The workspace-root config mutation, MCP coordination, and
  ownership-aware cleanup are now implemented; behavioral verification against
  a real OpenCode CLI remains open.
- Codex and Antigravity are intentionally mode-only, but the caveat is not
  consistently visible across every permissions surface.
- Mapper unit tests assert generated strings. They do not prove that a harness
  accepts the configuration or blocks/allows a real tool call.

This is a security and trust issue. A denied rule that is silently ignored is
materially different from an unavailable convenience feature.

## Current Baseline

Treat granular allow/deny support as follows until behavioral verification says
otherwise:

| Harness         | Permission mode                             | Allowed/denied lists              | Current disposition                                                                          |
| --------------- | ------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| Copilot CLI     | Supported                                   | Supported                         | Retain and integration-test                                                                  |
| Claude CLI      | Supported                                   | Supported through translation     | Retain and integration-test                                                                  |
| Qwen Code       | Supported                                   | Supported inline                  | Retain canonical inline mapping; add automated real-harness regression coverage              |
| OpenCode        | Supported                                   | Implemented; verification pending | Keep unverified until safe allow/deny calls pass against a pinned real CLI                   |
| Codex CLI       | Supported through sandbox/approval controls | No general equivalent             | Mode-only summary derived from the three capabilities; investigate safe partial translations |
| Antigravity CLI | Supported                                   | No documented granular equivalent | Mode-only summary derived from the three capabilities                                        |

These six CLI harnesses are the complete supported set (`HARNESS_IDS` in
`src/types/DashboardConstants.ts`). The `copilot-chat` harness was permanently
removed before release per
`dev/implemented/COPILOT_CHAT_ARCHIVAL_REMOVAL_PLAN.md`; it must not reappear as
a capability row, descriptor, or UI caveat.

This table belongs in the shared capability registry once that registry exists.
Do not copy it into multiple UI components.

## Root Cause: Why Qwen's Allow/Deny Lists Silently No-Op

Confirmed by reading `packages/cli/src/config/config.ts` and
`packages/core/src/{utils/tool-utils.ts,permissions/rule-parser.ts}` in a
checkout of `qwen-code` (v0.21.1, installed CLI v0.20.1) and reproducing the
failure against the real CLI. `--allowed-tools`/`--exclude-tools`/
`--approval-mode` are real, live, non-hidden yargs options — they only
disappear from `qwen --help` because of a yargs help-rendering quirk when no
positional query is present (`qwen hello --help` lists them); this is not
evidence they were removed.

Qwen has **two independent, drifted-apart tool-name alias tables**:

- `packages/core/src/permissions/rule-parser.ts` (`TOOL_NAME_ALIASES`) is the
  current permission engine and explicitly maps Claude-Code-style names —
  `Write` → `write_file`, `Bash` → `run_shell_command` — with the code comment
  `// Claude Code compatibility`. It also supports `Bash(git status *)`-style
  glob specifiers via real picomatch/shell-aware parsing.
- `packages/core/src/utils/tool-utils.ts` (`TOOL_ALIAS_MAP`) is an older,
  narrower table built only from internal canonical/display names
  (`write_file`/`WriteFile`/`WriteFileTool`, `run_shell_command`/`Shell`/
  `ShellTool`). It has **no entry for `Write` or `Bash`** and was never
  updated when the Claude-compat table was introduced.

`config.ts`'s non-interactive auto-deny gate (~line 1810) uses the **old**
table to decide whether a tool the model wants to call is "explicitly
allowed." When ctrlyoke's Qwen invocation is classified non-interactive
(query + `--output-format stream-json`, historically with no
`--input-format`) and approval mode is `default`/`auto`, the gate doesn't
recognize `Write` or `Bash` as covering `write_file`/`run_shell_command`, so
it force-adds the canonical name to the deny list — which then wins over the
correctly-resolved allow entry, because Qwen's permission evaluator applies
`deny > ask > allow`. The CLI process exits 0; the tool call is silently
rejected as a `tool_result` with `EXECUTION_DENIED`, which is exactly the
symptom observed (`write_file` blocked despite `Write` being in
`--allowed-tools`, no error surfaced).

**The fix**: the auto-deny gate is unconditionally skipped when
`--input-format stream-json` is set (`config.ts` guard:
`inputFormat !== InputFormat.STREAM_JSON`), regardless of interactive
classification. `QwenCliProvider.buildHeadlessArgs()` now sends
`--input-format stream-json` alongside the existing `--output-format
stream-json`. Qwen auto-wraps the positional prompt into the initial
stream-json user message internally (`gemini.tsx` → `nonInteractive/session.ts`
`runNonInteractiveStreamJson`), so no stdin protocol writing was needed;
ctrlyoke's headless spawn already runs with `stdio: ["ignore", "pipe", "pipe"]`
(`CliProcessManager.ts`), so Qwen's stream-json stdin reader hits EOF
immediately and `Session.drainAndShutdown()` still correctly awaits the
in-flight turn before the process exits — the existing process-exit
completion signal is unaffected. Verified empirically against the installed
CLI (v0.20.1): `write_file` now succeeds (`is_error: false`,
`permission_denials: []`) with the exact `Write`/`Bash(...)` alias syntax that
previously failed.

This establishes that Qwen's granular lists are supported inline; no
`.qwen/settings.json` permission mutation is needed. Formal real-harness
regression coverage is still required, but `--input-format stream-json` is the
standing invocation shape for headless Qwen runs. Interactive mode
(`buildInteractiveArgs`, the `-i` flag) never sets `--output-format`, so it was
never classified non-interactive and never hit this gate.

`QwenToolPermissionMapper` was also updated to emit `WriteFile`/`ShellTool`
instead of `Write`/`Bash` (both alias tables recognize the former; only the
newer one recognizes the latter — see the mapper's doc comments). All three
security-relevant properties were re-verified empirically against the
installed CLI (v0.20.1) with this invocation shape:

- **allow proceeds**: `--allowed-tools "WriteFile,..."` → `write_file`
  succeeds (`is_error: false`, `permission_denials: []`, file written).
- **deny blocks**: `--exclude-tools "WriteFile,..."` → `write_file` refused
  (`permission_denials` populated with the denied call, file not written).
- **deny wins over allow**: `--allowed-tools "WriteFile" --exclude-tools
"WriteFile"` → refused, same as deny-only.

Not yet covered by this session's manual verification: automated real-harness
coverage of these three behaviors (as opposed to one-off manual runs).

`QwenToolPermissionMapper`'s `delete`/`remove` pattern handling was also fixed:
it previously mapped to a literal `"Delete"` specifier, which is a silent
no-op — Qwen's full `TOOL_NAME_ALIASES` registry (grepped directly from the
installed CLI) has no delete/remove-file tool at all, so an allow/deny rule
targeting it never matched any real Qwen tool call. The mapper now skips
`delete`/`remove` patterns with a `Log.warn` pointing users at `shell(rm:*)`
instead, which is how Qwen actually performs file deletion.

## Staging Within the Parent Plan

This is the first consumer of the compatibility architecture, not an
independently startable parallel plan. Implement it in this order:

1. complete Compatibility Phase 1A (shared contracts and pure property
   resolution);
2. complete Compatibility Phase 1B (permission descriptors, registry,
   analyzer, preflight, and client snapshot);
3. complete the honest authoring UI below as Compatibility Phase 1C;
4. evolve the runtime permission-preparation contract;
5. implement the shared workspace-policy lease/writer and blocking-conflict UX;
6. retain Qwen's verified inline mapping and add automated behavioral coverage;
7. behaviorally verify the implemented OpenCode config path and finish its
   structured conflict/recovery UX;
8. continue to Compatibility Phase 2 for dry run, CLI/reporting, and MCP
   serialization.

The Codex partial-support investigation follows the verified Qwen path and the
implemented OpenCode path; it does not block the permission vertical slice.
Antigravity remains an explicit unsupported granular-list declaration unless
new evidence changes it.

**Release-gate boundary.** Stages 1–8 above are the P0 gate. The Codex
partial-support investigation is explicitly _not_ part of it: it is open-ended
research whose outcome may be "no safe general mapping exists," and a release
must never wait on a question that can legitimately answer no. Codex ships with
its derived mode-only summary and a non-blocking warning, which is already
honest. Schedule the investigation post-release, and only advertise `partial`
for categories that then earn a behavioral test.

## Compatibility Phase 1C — Honest UI

Until a harness has a passing behavioral test, the permissions UI must state
that Allowed Tools and Denied Tools are currently supported by Copilot CLI,
Claude CLI, and Qwen Code. OpenCode remains verification-pending.

Update every surface that exposes the lists:

- workflow properties panel;
- prompt properties drawer;
- default permissions page;
- advanced permissions help;
- schema/settings documentation and tooltips.

Required behavior:

- Qwen is classified as inline granular support; do not describe it as needing
  workspace configuration.
- A harness-specific warning explains whether the lists are ignored,
  unverified, or require workspace configuration.
- Keep Allowed/Denied Tools editable at workflow, prompt, and defaults scope
  regardless of harness support. Workflow-level lists can still be inherited by
  steps whose harness overrides support them, and authored values may become
  effective after a later harness change.
- Resolve support per AI step/final-step consumer, then aggregate it at the
  workflow field. A Codex-default workflow with Claude override steps must not
  be classified wholesale as Codex mode-only.
- The defaults page, which has no concrete consumers, displays the cross-harness
  support summary without disabling the fields.
- The warning must state that a denied list is **not enforced**. Avoid softer
  wording such as "may behave differently."
- Ignored Allowed/Denied Tools are non-blocking warnings. They never require
  confirmation, acknowledgment, or an extra click before execution.

This stage requires Compatibility Phases 1A and 1B. Implement it directly
against the shared registry/analyzer and remove the existing helper switch in
the same change. Do not add a temporary support table or leave the old helper as
a fallback.

## Workspace-Configuration Support

OpenCode uses project `opencode.json` permission rules with `allow`, `ask`, and
`deny` decisions. Qwen remains inline-only in ctrlyoke; do not add a
`.qwen/settings.json` permission writer.

The first implementation slice landed on 2026-07-30 by extending
`SettingsJsonMcpTracker`, so OpenCode's MCP and permission mutations share the
same lock, baseline, reference counting, atomic writer, and cleanup ownership.
It applies identical policies once for multiple owners, rejects a different
later policy without changing the active file, restores the original
permission value on final release, and preserves user edits detected during
cleanup.

Remaining work in this section:

- persist crash-recovery ownership metadata;
- return the structured `acquired` / `shared` / `conflict` application
  contract instead of surfacing a plain provider error;
- wire disclosure, dry-run details, persisted diagnostics, and blocking
  conflict UX across dashboard, CLI, and MCP surfaces.

Note how those two existing trackers share a lock: `SettingsJsonMcpTracker` owns
the `AsyncMutex`, and `SettingsJsonHooksTracker` has no mutex of its own — its
class documentation requires callers to invoke it under
`mcpTracker.withLock()`. That convention is easy to violate silently, because
forgetting the wrapper produces a correct-looking call that only corrupts state
under concurrency. The new permission writer must not extend this
by-convention pattern: lock ownership belongs to the shared mutation service,
and acquiring the lock must be structurally required by its API rather than
documented in a comment.

### Required mutation semantics

- Read-modify-write only the owned permission keys.
- Preserve unrelated user settings, formatting limitations permitting.
- Capture the original value before the first active owner.
- Reference-count identical active configurations.
- Never merge or alternate conflicting active configurations in the same
  workspace. Two parallel workflows must never silently replace one another's
  security policy.
- On final release, restore only ctrlyoke-owned changes.
- Do not overwrite edits the user made while the workflow was running. Use an
  ownership/three-way comparison and surface a cleanup conflict.
- Persist enough recovery metadata to remove stale ctrlyoke-owned values after a
  crash without replacing the user's whole file.
- Use atomic writes and the existing workspace-scoped path/security guards.
- Hold the configuration for the lifetime of the harness process that consumes
  it, including a retained interactive session.

### Required disclosure

Project settings are discovered by every matching harness process in that
workspace. While ctrlyoke's injected permission policy is active, it can affect:

- other ctrlyoke workflows using that harness;
- a manually launched harness in the same workspace;
- an interactive session that outlives the workflow step.

Show this caveat before execution and in dry-run output. The caveat should name
the exact file and whether ctrlyoke will restore its owned changes. This is a
non-blocking warning and does not add a confirmation gate.

### Conflict decision — reject the later acquisition

Reference counting is required but resolves only identical policies. If
workflow A and workflow B request the same normalized permission configuration,
the writer applies it once, records both owners, and restores the baseline only
after both release it.

For non-identical policies targeting the same harness configuration file,
reject the later acquisition. Preparation returns a structured blocking
conflict diagnostic naming the active owner, harness, and target file. The
first workflow continues unchanged; the user can retry the second after the
active policy is released.

A file mutex is still required, but it is not itself a conflict strategy: it
prevents two read-modify-write operations from interleaving while still
allowing a later write to replace the first policy immediately after the lock
is released unless the ownership check and acquisition happen atomically under
that lock.

The public application contract represents `acquired`, `shared`, and `conflict`
outcomes. Do not add a dormant `waiting` state or make the workflow appear
queued. If workflow chaining/queuing is implemented later, the conflict
diagnostic can gain a `queue-after-owner` remediation action and the lease
contract can add a waiting outcome without changing the ownership semantics.

Compare the final normalized, harness-specific permission policy when deciding
whether configurations are identical. Canonicalize only fields whose ordering
is behaviorally irrelevant; preserve order where harness rule precedence makes
it meaningful.

### Blocking conflict UX

A workspace permission conflict is an `error`, not a warning-severity
diagnostic, because ctrlyoke cannot safely prepare the requested execution. It
blocks only the workflow whose later acquisition failed.

When a dashboard user presses Run and atomic acquisition returns `conflict`,
show a shared React modal with:

- title: **Workflow can't start**;
- the active workflow name, harness, and workspace configuration path;
- an explanation that the workflows require different permission policies and
  that replacing the active policy could invalidate its security controls;
- **View active workflow** when that workflow can be selected in the dashboard;
- **Close**;
- no Continue Anyway, confirmation, or unavailable Queue action.

This is a blocking-result dialog, not a confirmation dialog: it reports that
the requested start failed and offers no unsafe override. Use the existing
shared React `Modal` foundation so the VS Code webview and hosted browser behave
the same. Do not use `vscode.window.showErrorMessage` and do not wait for a
future toast-unification project.

The modal is the immediate interruption, but not the only record. Persist the
same diagnostic code and details in dashboard status/output and expose it
through validation/dry-run results while the conflict remains. CLI starts exit
nonzero with the structured diagnostic; MCP callers receive the same error
contract. Once the active owner releases the policy, a retry performs a fresh
atomic acquisition and may proceed.

## Qwen Inline Implementation

Retain the inline CLI-list mapping:

- `--input-format stream-json` is now sent for headless runs (see Root Cause
  above), which removes the silent-deny failure mode independent of tool-name
  choice. Still translate ctrlyoke patterns to Qwen's current canonical tool
  names as defense in depth — `WriteFile`/`write_file` and
  `ShellTool`/`run_shell_command` are recognized by _both_ Qwen alias tables,
  where bare `Write`/`Bash` are only recognized by the newer one — so a future
  Qwen build or an interactive/non-stream-json code path can't reintroduce the
  same class of bug;
- retain coarse mode arguments only where the installed version accepts them.

Version differences matter because Qwen has changed both its settings schema and
CLI arguments. Record Qwen mode, Allowed Tools, and Denied Tools verification
evidence independently, detect the installed version, and mark only
out-of-range capabilities unverified rather than falling back to stale flags.

Behavioral tests must launch Qwen in an isolated fixture workspace and prove that:

- an allowed harmless tool call proceeds as intended;
- a denied harmless fixture operation is refused;
- deny wins when a pattern appears in both lists;

## OpenCode Implementation

Implementation landed on 2026-07-30:

- `custom` merges a `permission` block beginning with `"*": "ask"`;
- `allowAll` begins with `"*": "allow"` and still applies deny overrides;
- `none` and `dangerouslyAllowAll` do not mutate permissions;
- known ctrlyoke tools map to OpenCode permission keys, including file-write
  aliases to `edit`;
- `shell(command:*)` becomes OpenCode's `bash` wildcard form (`command *`);
- denied rules are inserted after allowed rules for last-match-wins behavior;
- the workspace-root `opencode.json` is the single MCP/permission target;
- unrelated permission rules, MCP entries, and non-permission config survive
  both application and cleanup;
- newly created `opencode.json` receives a temporary sibling `.gitignore`
  (which ignores both files) when no user-owned `.gitignore` exists;
- malformed existing JSON fails closed and is never overwritten.

Unit coverage proves mapping, MCP/permission coordination, baseline restore,
temporary-file cleanup, identical-policy sharing, conflict rejection, user-edit
preservation, and malformed-JSON handling. `npm test` passed after this slice
(2,244 extension tests and 1,237 UI tests).

Still required: behavioral tests against a pinned real OpenCode CLI must prove
allow and deny decisions with safe fixture tools. Crash recovery and the shared
structured conflict/disclosure UX remain in Workspace-Configuration Support.

## Codex Partial Support Investigation

> Post-release. Not part of the 0.1.0 gate — see the release-gate boundary in
> the staging section above.

Codex has useful security primitives, but they do not form a general mapping for
ctrlyoke tool names:

- project `.codex/config.toml`;
- project-local command rules;
- sandbox/approval settings and permission profiles;
- MCP server `enabled_tools` and `disabled_tools`.

Investigate translations by category:

- `shell(command:*)` may map to project-local command prefix rules;
- MCP tool patterns may map to per-server enabled/disabled tool lists;
- broad read/write patterns may map only approximately to permission profiles.

Only advertise `partial` for categories with behavioral tests. A partial mapping
must emit diagnostics for every untranslatable rule. Never translate a broad
denial into a weaker rule silently.

Until this investigation lands, the analyzer derives Codex's mode-only summary
from supported coarse mode plus unsupported Allowed Tools and Denied Tools
capabilities. Harness mappers do not store `mode-only` as a capability value.

## Antigravity

Keep deriving an Antigravity mode-only summary unless its supported
CLI/configuration exposes a documented granular policy mechanism. Harness
adapters do not store that summary as a capability value.

Do not infer granular support from Gemini/Qwen configuration merely because the
products share history or directories. Antigravity needs its own verified
contract.

## Interface Changes

`IToolPermissionMapper.buildArgs()` cannot represent a permission policy applied
through a workspace file or report lossy translations. Evolve the abstraction:

```typescript
interface ToolPermissionApplication {
  cliArgs: string[];
  workspaceMutation?: WorkspacePermissionMutation;
  diagnostics: CompatibilityDiagnostic[];
}

interface IToolPermissionMapper {
  /**
   * Static permission facts owned by this harness mapper and referenced by the
   * harness descriptor. The backend registry is the only layer that evaluates
   * these declarations against an installed version.
   */
  readonly capabilities: PermissionCapabilityDescriptor;
  prepare(
    config: ToolPermissionConfig,
    context: PermissionContext
  ): Promise<ToolPermissionApplication>;
  hasFullPermissions(config: ToolPermissionConfig): boolean;
}
```

The harness adapter's registry descriptor must reference this same
`capabilities` object rather than copy it. Do not add
`describeSupport(version)` or any second mapper-owned version evaluator.
Command arguments, workspace side effects, and diagnostics must be returned
through one preparation contract.

## Testing Strategy

Keep mapper unit tests, but add:

- capability completeness tests for every harness;
- workspace writer merge/restore/conflict/crash-recovery tests;
- harness command/config snapshot tests;
- UI tests for the relevant fidelity/mechanism/verification combinations;
- integration tests against pinned harness versions;
- negative behavioral tests that exercise safe denied operations.

An argument/config snapshot is not sufficient evidence for `exact` or `partial`
fidelity with verified status.

## Acceptance Criteria

- Every permission UI clearly states the current granular-support boundary.
- Qwen retains its canonical inline tool-list mapping and never adds a
  workspace permission writer.
- OpenCode no longer claims a permission config side effect it does not perform.
- Qwen and OpenCode granular policies pass behavioral allow/deny tests before
  their capability declarations advance from unsupported/unverified to the
  behaviorally justified fidelity and verified status.
- Conflicting workspace permission policies cannot run concurrently without an
  explicit resolution; the later acquisition is rejected without modifying the
  active policy.
- A dashboard start rejected by a permission-policy conflict shows the shared
  blocking modal and persists the same diagnostic in status/output; CLI and MCP
  surfaces return the same error code without relying on a toast or VS Code
  notification.
- Cleanup preserves pre-existing settings and user edits.
- Codex and Antigravity never silently ignore configured granular rules; the
  compatibility layer emits a non-blocking pre-execution warning without a
  confirmation gate.
- Dry run shows the exact permission translation and workspace file side effect.

## Non-goals

- Pretending all harness permission systems have identical semantics.
- Writing user-global harness configuration.
- Leaving workspace permission mutations behind as persistent project policy.
- Treating prompt instructions such as "do not use shell" as a security control.
- Claiming verified exact/partial fidelity based only on harness documentation
  or emitted flags.
