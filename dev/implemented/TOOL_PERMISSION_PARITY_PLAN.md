# Cross-Harness Tool Permission Parity Plan

> **Status:** Provider work, Compatibility Phases 1A–1C, runtime preparation,
> and the surviving Antigravity statusline-lease scope are complete. The
> shared analyzer now drives persistent mixed-harness diagnostics across the
> workflow, prompt, defaults, and advanced permission surfaces; authored tool
> lists remain editable under mode-only harnesses. Qwen/OpenCode behavioral
> verification remains pinned in the separate real-harness fixture suite; the
> post-release work is limited to Antigravity/Codex parity follow-up. Two
> Antigravity enforcement gaps found 2026-08-02 are open and queued — see
> "Known enforcement gaps".
>
> **Priority:** P0 — release gate for 0.1.0
>
> **Parent architecture:**
> [`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](../active/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md)
>
> **Implementation order:** the completed Stages 1–7 are recorded in
> [`COMPATIBILITY_AND_FEEDBACK_STAGING.md`](COMPATIBILITY_AND_FEEDBACK_STAGING.md);
> the remaining Codex and Antigravity parity items are Stage G of
> [`FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`](../active/FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md).
>
> **No dependency on**
> [`BROWSER_USER_FEEDBACK_PLAN.md`](../active/BROWSER_USER_FEEDBACK_PLAN.md). Every user
> surface this plan needs already exists: `components/shared/Modal.tsx` for
> blocking results, and the `warning` prop / `dropdownValidation.ts` helpers
> shipped by `DROPDOWN_VALIDATION_STYLING_PLAN.md` for field diagnostics.
> Nothing here routes through toast.

**Code state verified 2026-08-01.** What has landed:

- Qwen sends `--input-format stream-json` in `QwenCliProvider.buildHeadlessArgs()`
  (`QwenCliProvider.ts` ~line 500), which is the fix for the silent-deny gate.
- OpenCode delivers `mcp`/`permission`/`plugin` through `OPENCODE_CONFIG_CONTENT`
  (`OpenCodeCliProvider.ts:434,444`); no workspace `opencode.json` is written.
- `src/test/harness/inline-config.harness.test.ts` exists and is excluded from
  the ordinary gate.
- The old per-harness permission UI switch has been removed; compatibility is
  now resolved per execution target by the shared analyzer.

The runtime preparation contract has landed: `IToolPermissionMapper.prepare()`
now returns CLI arguments, optional workspace mutations, and compatibility
diagnostics through one application object. Antigravity's remaining global
statusline lease scope is also complete; the post-release follow-up is limited
to new parity evidence for Antigravity and Codex.

Stages 1–7 are implemented before 0.1.0 ships; Compatibility Phase 2 and the
Codex/Antigravity parity investigation remain post-release. The staging below
is therefore an engineering sequence for the shipped gate, while the honest-UI
stage is built directly on the shared registry rather than as a throwaway
stopgap.

Capability _classifications_ still change only when new behavioral evidence is
available. Qwen's inline allow/deny flags and OpenCode's inline permission
mapping are covered by pinned real-harness fixtures in
`src/test/harness/inline-config.harness.test.ts`; the suite is intentionally
not run as part of the ordinary gate because it drives live CLIs. Neither
harness writes a workspace permission configuration on its normal path.

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
  plus `--input-format stream-json` path is covered by the pinned real-harness
  fixtures; upgrade verification remains explicit because Qwen's alias tables
  have drifted across releases.
- OpenCode delivers permission and MCP settings through
  `OPENCODE_CONFIG_CONTENT`; it no longer mutates `opencode.json`.
- Codex and Antigravity are intentionally mode-only, but the caveat is not
  consistently visible across every permissions surface.
- Mapper unit tests assert generated strings. The pinned real-harness fixtures
  now cover the remaining Qwen/OpenCode allow/deny and inline MCP behavior, but
  they are not run by `npm test`.

The remaining UI defects are narrower than when this plan was written, because
the Qwen and OpenCode provider fixes landed and `getPermissionHarnessSupport()`
was corrected for OpenCode. What is still wrong in
`src/ui/webview-react/components/shared/permissionUtils.ts` and its two
consumers:

- **The tool-list fields are disabled, not annotated.** A `mode-only`
  `harnessSupport` feeds the `disabled` prop and an
  `opacity-50 cursor-not-allowed`
  class for both textareas in `WorkflowPropertiesPanel.tsx` (~lines 1569, 1574,
  1618, 1624) and via `allowedDisabled` / `deniedDisabled` in
  `PropertiesDrawer.tsx:996–1005`. This directly contradicts the parent plan's
  "Editing remains available" rule: a workflow-level list that a Claude override
  step would enforce cannot be typed at all when the workflow default is Codex.
  Removing this is the single highest-value fix in the honest-UI stage.
- **Support is resolved from one harness, not per consumer.** Both call sites
  pass a single `effectiveHarness` / `effectivePermHarness`, so a Codex-default
  workflow is classified wholesale as Codex regardless of step overrides.
- **The caveat is styled as information, not warning.** Both surfaces render an
  `ℹ️` paragraph in `text-description-fg`. The plan requires warning treatment
  and the words "not enforced".
- **The prose is hardcoded per harness in both components.** Two near-duplicate
  ternaries over `HARNESS_IDS.CODEX_CLI` / `ANTIGRAVITY_CLI` with a generic
  fallback branch.

This is a security and trust issue. A denied rule that is silently ignored is
materially different from an unavailable convenience feature.

## Current Baseline

Treat granular allow/deny support as follows until behavioral verification says
otherwise:

| Harness         | Permission mode                             | Allowed/denied lists              | Current disposition                                                                          |
| --------------- | ------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| Copilot CLI     | Supported                                   | Supported                         | Retain and integration-test                                                                  |
| Claude CLI      | Supported                                   | Supported through translation     | Retain and integration-test                                                                  |
| Qwen Code       | Supported                                   | Supported inline                  | Retain canonical inline mapping; re-verify the pinned fixture on CLI upgrade                 |
| OpenCode        | Supported                                   | Supported inline                  | Retain collision-safe inline mapping; re-verify the pinned fixture on CLI upgrade            |
| Codex CLI       | Supported through sandbox/approval controls | No general equivalent             | Mode-only summary derived from the three capabilities; investigate safe partial translations |
| Antigravity CLI | Supported                                   | No documented granular equivalent | Mode-only summary derived from the three capabilities                                        |

These six CLI harnesses are the complete supported set (`HARNESS_IDS` in
`src/types/DashboardConstants.ts`). The `copilot-chat` harness was permanently
removed before release per
`dev/implemented/COPILOT_CHAT_ARCHIVAL_REMOVAL_PLAN.md`; it must not reappear as
a capability row, descriptor, or UI caveat.

The shared capability registry now assembles this table from the six mapper
descriptors. Do not copy it into multiple UI components.

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

The automated cases are written in the pinned real-harness fixture; they remain
outside the ordinary test gate because executing them drives live Qwen CLIs.

`QwenToolPermissionMapper`'s `delete`/`remove` pattern handling was also fixed:
it previously mapped to a literal `"Delete"` specifier, which is a silent
no-op — Qwen's full `TOOL_NAME_ALIASES` registry (grepped directly from the
installed CLI) has no delete/remove-file tool at all, so an allow/deny rule
targeting it never matched any real Qwen tool call. The mapper now skips
`delete`/`remove` patterns with a `Log.warn` pointing users at `shell(rm:*)`
instead, which is how Qwen actually performs file deletion.

## Known enforcement gaps (found 2026-08-02)

Two Antigravity defects found while auditing whether capability data was worth
serializing for MCP consumers. Both are the failure mode this plan exists to
prevent — a restriction ctrlyoke presents as active that the harness does not
apply — and both are queued as Stage A of
[`FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`](../active/FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md).

### Gap 1 — ctrlyoke MCP tool denials are silently unenforced on Antigravity

Unchecking a function in the ctrlyoke MCP server's per-tool controls produces no
enforcement under Antigravity, and no user-visible warning on any surface.

The path:

1. `McpServersEditor.tsx:82` is the **only** producer of
   `McpServerConfig.deniedTools` — it emits `{ id: "ctrlyoke", deniedTools }` and
   passes every other server through untouched. The field is not in
   `schemas/workflow-schema.json`'s `mcpServers` entries either, so the ctrlyoke
   checkboxes are its sole authoring path despite the generic type.
2. `CliIntegration.mergeServerDeniedTools()` (defined line 1252, called line 963)
   rewrites those entries as `mcp__ctrlyoke__<tool>` and appends them to
   `toolPermissions.deniedTools`. There is one enforcement mechanism with two
   entry points, not a second deny list.
3. Antigravity declares `deniedTools` `fidelity: "unsupported"`, so its mapper
   drops them.

Why nothing warns:

- **Author time is blind.** `WorkflowInstance.ts:429` runs the analyzer on
  `PropertyResolver.resolveTarget()` output — _upstream_ of the merge in step 2 —
  and `CompatibilityAnalyzer.ts:152` gates the diagnostic on
  `used: permissions.deniedTools.length > 0`. With denials expressed only through
  the checkboxes, that list is empty and no diagnostic is produced.
- **Runtime warns into a log file.** `prepare()` _does_ receive the merged config,
  so `getToolTranslationDiagnostics()` (`IToolPermissionMapper.ts:109`) correctly
  emits `DENIED_TOOLS_NOT_ENFORCED`. Its only consumer is
  `CliIntegration.ts:994`, a bare `Log.warn`. That violates this plan's parent
  architecture rule that runtime warnings reuse the same codes _and_ stay visible
  in status/output.

Scope is one harness: Copilot/Claude/Qwen/OpenCode enforce the pattern normally,
and Codex enforces it through its own native `disabled_tools`
(`CodexCliProvider.ts:592`) despite its mode-only summary. Fix both halves —
teach the analyzer about attached-server denials so author time matches runtime,
and route `permissionApplication.diagnostics` to status/output. Note that the
RFC 6901 `propertyPointer` must address the ctrlyoke MCP entry rather than
`/toolPermissions/deniedTools`, since that is where the value was authored.

**A.2 completed (2026-08-02).** `mergeServerDeniedTools()` now lives in
`src/types/ToolPermissionUtils.ts` and is the shared pure merge used by both
`CompatibilityAnalyzer` and `CliIntegration`. The analyzer includes attached
server denials in its `used` gate while preserving the `none` and
`dangerouslyAllowAll` early exits. When the denial was authored in a prompt or
workflow `mcpServers` array, the diagnostic points to the first denied server's
array entry: `/steps/<stepIndex>/mcpServers/<serverIndex>/deniedTools` for a
prompt override, or `/mcpServers/<serverIndex>/deniedTools` for a workflow
property. Runtime mapper diagnostics remain in the log and are also forwarded
through `WorkflowInstance.reportCompatibilityDiagnostics()` to the dashboard
status surface with the executing consumer attached.

### Gap 2 — Antigravity maps `allowAll` to `--dangerously-skip-permissions`

`AntigravityToolPermissionMapper.ts:58` emits `--dangerously-skip-permissions`
for **both** `dangerouslyAllowAll` and `allowAll`, and `hasFullPermissions()`
returns true for both. The workflow schema documents `allowAll` as "auto-grants
all but respects deny list", so whenever a deny list exists the effective posture
is not "all granted except these" but "permission checking off".

This compounds Gap 1: in the checkbox scenario above the outcome is not one
missing denial but no permission enforcement at all. It also sits uneasily with
Antigravity declaring `mode: { fidelity: "exact", mechanism: "native" }` —
defensible with no deny list, questionable with one. Decide whether the fix is
the mapping, the declaration, or a diagnostic, and record the reasoning.

**A.3 completed (2026-08-02).** The installed Antigravity CLI is 1.1.9. Its
`agy --help` surface exposes `--dangerously-skip-permissions` (auto-approves
all tool permission requests) and `--sandbox` (enables terminal restrictions),
but no safe auto-approve flag and no allow/deny-tool flags. The mapping is now:
`dangerouslyAllowAll` → `--dangerously-skip-permissions`; `allowAll` → no
permission flag; `custom` → `--sandbox`. `hasFullPermissions()` is true only
for `dangerouslyAllowAll`. The mode declaration is `partial`/`native` with the
coarse-permission caveat, so author-time compatibility analysis discloses that
the requested mode is not fully translated; the existing unsupported denied
tools declaration also discloses any deny list.

The rejected alternatives were deliberate. Keeping the dangerous flag for
`allowAll` would preserve the defect because agy would ignore the deny list.
Mapping `allowAll` to `--sandbox` would invent semantics: the installed help
describes sandbox restrictions, not auto-approval or deny-list enforcement.
A diagnostic-only fix would still launch agy with the bypass and would leave
`hasFullPermissions()` claiming that headless approval cannot block, so it does
not repair the enforcement posture. Keeping `mode` exact was also rejected:
`allowAll` has no native representation, making exact fidelity indefensible
even when its deny list is empty. No granular `allowedTools` or `deniedTools`
support is inferred; both remain explicitly unsupported.

**Residual risk this decision accepts, recorded 2026-08-02.** `allowAll` is the
_default_ mode (`CtrlYokeSettings` defaults, `toolPermissions.mode: "allowAll"`),
so this change removes `--dangerously-skip-permissions` from default-configured
Antigravity runs. What agy then does headlessly — block on an approval prompt,
auto-deny, or proceed — is **not established by code inspection**, and this
plan's own standard is that behavior is only claimed once a behavioral test
earns it. The honest-enforcement argument still wins on the merits: the previous
mapping silently disabled the deny list, and no safe auto-approve flag exists to
substitute. The exposure is bounded because `hasFullPermissions()` now returns
false for this combination, which fires
`CliIntegration.warnIfHeadlessWithoutPermissions()` before the run, and the
`partial` mode declaration produces an author-time diagnostic. Confirm the
headless behavior with a real-harness test before treating this as settled; if
agy blocks, the follow-up is a defined headless fallback, not a return to the
bypass.

## Staging Within the Parent Plan

This is the first consumer of the compatibility architecture, not an
independently startable parallel plan. Implement it in this order:

1. complete Compatibility Phase 1A (shared contracts and pure property
   resolution);
2. complete Compatibility Phase 1B (permission descriptors, registry,
   analyzer, preflight, and client snapshot);
3. complete the honest authoring UI below as Compatibility Phase 1C;
4. evolve the runtime permission-preparation contract;
5. implement the shared workspace-policy lease/writer and blocking-conflict UX
   for any remaining file-backed policy;
6. retain Qwen's verified inline mapping and its pinned behavioral fixtures;
7. retain OpenCode's behaviorally verified inline path and its pinned
   behavioral fixtures;
8. _(post-release)_ continue to Compatibility Phase 2 for dry run,
   CLI/reporting, and MCP serialization.

The Codex partial-support investigation follows the verified Qwen and OpenCode
paths; it does not block the permission vertical slice. The remaining
workspace-configuration scope is Antigravity's global statusline lease and
workspace MCP scoping, not an OpenCode permission lease.
Antigravity remains an explicit unsupported granular-list declaration unless
new evidence changes it.

**Release-gate boundary.** Stages 1–7 above are the P0 gate. Stage 8
(Compatibility Phase 2) was descoped to P1 on 2026-07-31: dry run, the
portability report, and CLI/MCP serialization make existing truth more visible
rather than preventing a dishonest support claim or an unsafe workspace
mutation. The Codex partial-support investigation is also explicitly _not_ part
of the gate: it is open-ended
research whose outcome may be "no safe general mapping exists," and a release
must never wait on a question that can legitimately answer no. Codex ships with
its derived mode-only summary and a non-blocking warning, which is already
honest. Schedule the investigation post-release, and only advertise `partial`
for categories that then earn a behavioral test.

## Compatibility Phase 1C — Honest UI

Until a harness has a passing behavioral test, the permissions UI must state
that Allowed Tools and Denied Tools are currently supported by Copilot CLI,
Claude CLI, Qwen Code, and OpenCode.

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

Deleting `getPermissionHarnessSupport()` is not the whole change: its
`"mode-only"` return value is also wired into the `disabled` props and
`opacity-50 cursor-not-allowed` classes enumerated in the Problem section
above. Those must come out in the same change, or the analyzer will produce
correct diagnostics for fields the user still cannot edit.

## Workspace-Configuration Support

OpenCode no longer participates in workspace-configuration support: its MCP,
permission, and plugin configuration are accumulated per step and delivered
through `OPENCODE_CONFIG_CONTENT` at spawn time. It has no permission-policy
lease, step-scoped release, cross-process conflict contract, blocking conflict
modal, CLI/MCP conflict exit code, or workspace-mutation disclosure caveat.

The remaining scope of this section is Antigravity's global statusline lease.
Its generic `registerValueLease` / `unregisterValueLease` /
`getValueLeaseBaseline` machinery remains in `SettingsJsonMcpTracker` and must
retain its existing baseline restoration and ownership behavior.

### Stage 11 scope decision (2026-08-01)

The surviving implementation scope is deliberately narrower than the retired
OpenCode workspace-lease design:

- **In scope:** key MCP and value-lease baseline snapshots by their resolved
  config file path. This prevents one tracker serving multiple workspaces (or
  Antigravity's global settings through different workspace arguments) from
  accumulating a union baseline and restoring the wrong file's state.
- **In scope:** identify lease owners with the process PID plus a random token
  generated once per ctrlyoke process. PID-only ownership can mistake a
  recycled process for the owner of a stale sidecar; the token is checked for
  owners belonging to the current process, while live foreign processes remain
  protected by PID liveness.
- **In scope:** add regression coverage for pruning a dead owner, including a
  stale owner with the same workflow key as a new acquisition.
- **In scope:** correct `withLock()`'s documentation to describe its actual
  in-process `AsyncMutex`, and use the existing `withFileLock()` around
  tracker-owned settings mutations. Antigravity's statusline file is global
  and can be touched by multiple ctrlyoke processes; MCP mutations use the
  same tracker and must retain atomic read-modify-write behavior.
- **Out of scope:** the retired OpenCode permission lease, step-scoped lease
  lifetime, structured conflict results, blocking conflict UX, retry policy,
  disclosure work, and any attempt to govern harnesses launched outside
  ctrlyoke. OpenCode continues to use `OPENCODE_CONFIG_CONTENT`.

<!-- Pre-Stage-2 OpenCode workspace-lease design retained below only as an
     implementation-history reference; it is no longer active scope.

### Decided semantics (2026-07-31)

These six questions are now answered. Implement to these decisions.

**1. The conflict domain is the config file path, uniformly.** Not "the
workspace." Value leases are already keyed by `settingsPath::key`, which is
correct and makes separate worktrees independent by construction. The MCP
baseline is **not** keyed this way and must be fixed: `baselineServers`,
`baselineProjectServers`, and the three `baselineProject*` booleans are
per-tool-singleton fields, and `captureBaseline()` resets only the booleans when
`baselineCapturedForWorkspace` changes — it never clears the Sets. One process
serving two roots (multi-root VS Code, two worktrees, or the hosted server)
therefore accumulates a union baseline, and worktree B treats worktree A's MCP
servers as pre-existing and never cleans them up. Key all baseline state by
resolved config file path.

**2. Lease lifetime is the step, not the workflow or the harness process.**
The rule: _a ctrlyoke-owned settings file exists only while ctrlyoke is actively
running a step._ Acquire before every step; release on step completion.

A retained interactive TUI can outlive the step and the user can type into it
directly; ctrlyoke does not try to govern that (see decision 6).

Injected steps are the exception, and they need _less_ work rather than more:
because OpenCode caches config at spawn (see "Resolved: OpenCode caches config
at process start"), an injected prompt runs under the policy the live session
already cached, and ctrlyoke restarts instead of injecting whenever that policy
would differ. An injecting step therefore writes no config file, acquires no
lease, and cannot conflict.

The change to current call sites is at the release end. `prepareToolPermissions`
is invoked from `CliIntegration.ts:961` during CLI argument construction, which
is already the launch boundary and is where acquisition belongs. Release
currently happens in `cleanupWorkspaceArtifacts` (`OpenCodeCliProvider.ts:439`)
at workflow teardown; it moves to step completion.

**3. Owner identity is PID plus a per-process random token.** `getOwnerId()`
currently returns `${pid}:${workflowKey}`. A recycled PID makes a dead owner
look alive and can block indefinitely. Generate one random token per ctrlyoke
process at startup and include it in the owner record and sidecar, so liveness
is `isProcessAlive(pid) && token matches`.

**4. Dead owners are pruned, with an explicit regression test.** Pruning exists;
the test does not. Add a test that writes a sidecar naming a dead PID, then
proves a fresh acquisition succeeds rather than reporting a false conflict.
Cover the same-`workflowKey` case: re-running a workflow after a crash must not
be blocked by its own stale lease.

**5. Conflict becomes a structured result instead of a thrown error.** Accepted:
`registerValueLease` returns a discriminated `PolicyLeaseResult` whose `conflict`
outcome carries a structured diagnostic, and exceptions are reserved for genuine
I/O and parse failures. Contract and rationale in "Conflict result contract"
below.

**6. Harnesses launched outside ctrlyoke are out of scope, permanently.** A user
who runs OpenCode manually in the same workspace, or `--resume`s a session
ctrlyoke is driving, can defeat any of this. ctrlyoke does not detect, prevent,
or work around it; this is a standing known limitation of every workspace-scoped
mechanism, not a gap in this plan. Disclose it (see "Required disclosure") and
do not add machinery that pretends to solve it.

### Resolved: OpenCode caches config at process start

**Verified manually 2026-07-31.** Editing `opencode.json` between prompts of a
running TUI has no effect: the session keeps enforcing the permission settings
present at launch and ignores mid-session changes.

**This removes the inject re-apply work entirely rather than complicating it.**
The config file only governs a harness process at spawn time, so:

- **identical policy → inject.** The live TUI already cached exactly that
  policy at launch. Nothing needs to be written, and the injected step needs
  neither the file nor a lease.
- **different policy → fresh process.** ctrlyoke already restarts rather than
  injects when spawn-time config changes, so the file is written and leased at
  the launch that consumes it.

The invariant that makes this safe is `getInjectIncompatibilityReason`
(`CliIntegration.ts:467`), which refuses inject and forces a restart when
`resolvedProperties.toolPermissions` or `.mcpServers` differ from the stored
`spawnedWith` snapshot. Two consequences:

1. **That comparison is now security-critical, not a convenience.** If it ever
   stops catching a permission difference, ctrlyoke injects into a session
   enforcing a stale cached policy — silent under-enforcement with no error and
   no diagnostic. Add explicit regression tests that a changed `toolPermissions`
   and a changed `mcpServers` each force a restart.
2. **Missing snapshots fail closed (landed 2026-07-31).**
   `getInjectIncompatibilityReason` now returns distinct restart reasons when
   either the `spawnedWith` snapshot or the current resolved properties are
   missing. `shouldUseInjectMode` logs the reason and uses the existing restart
   path, and unit coverage protects both cases plus a fully matching snapshot.

Because an injecting step touches no config file, two workflows with different
policies may legitimately run concurrently while one of them is injecting. That
is correct, not a gap in the gate: the file does not govern an already-running
process.

The same caching argument applies to the `mcpServers` block in the same file, so
MCP registration follows the same step-scoped rule and the same restart-on-change
invariant. Today `unregisterWorkflow` runs only at workflow cleanup
(`OpenCodeCliProvider.ts:443`); align it with the step boundary.

**Lease window.** Config is consumed only at spawn, so in principle the lease
could be released as soon as the process has read it. There is no observable
"config consumed" signal, and releasing immediately after spawn would let another
workflow rewrite the file before OpenCode reads it. Keep release at step
completion per decision 2 — it costs nothing and closes that race. Releasing at a
startup-ready signal is a possible later optimization, not a requirement.

### Mid-run acquisition failure

**Decided 2026-07-31: fail with an error, not a bounded wait.** Under
per-workflow leases a conflict could only happen at start. Under step-scoped
leases, workflow A can release after step 1, workflow B can acquire, and A's
step 2 then fails mid-run. Handle it as a blocking `error` diagnostic that stops
the workflow at that step, leaving it resumable once the other owner releases.
Explicitly exclude conflicts from `errorBehavior` retry: a conflict is not a
transient harness failure, and retrying it produces nondeterministic behavior
that depends on another workflow's timing.

Note that step-scoped leases narrow the product promise in a way that is
_more_ precise, not weaker: conflicting workflows may interleave between steps,
because the config file only governs a harness process while that process is
consuming it. What must never happen is two conflicting policies overlapping
during execution.

### Cross-process acquisition must be atomic

`withLock()` (`SettingsJsonMcpTracker.ts:231`) acquires only the in-process
`AsyncMutex`, despite its doc comment describing it as "the settings.json file
lock." Correct that comment and the mechanism.

The sidecar makes ownership _visible_ across processes, but acquisition is not
_atomic_ across them. Two ctrlyoke processes in one worktree — a CLI run plus the
extension host, or two CLI runs — can both prune, both read the sidecar, both see
no conflict, and both write. The later policy silently replaces the earlier one,
which is precisely the failure this section exists to prevent.

`withFileLock()` in `src/utils/FileLockUtils.ts:73` is the existing cross-process
primitive and already guards working files. The whole prune → read → conflict
check → write → sidecar sequence must run inside it, not merely the write. The
in-process mutex stays as the inner guard so a single process does not
self-interleave while awaiting the file lock.

### Conflict result contract

`registerValueLease` currently returns `"acquired" | "shared"` and throws a
prose `Error` on conflict (`SettingsJsonMcpTracker.ts:523`). Replace the throw
with a discriminated result. Reserve exceptions for genuine I/O and parse
failures.

The throw is wrong for four reasons:

- a conflict is programmatically indistinguishable from a disk error, a
  malformed config, or a permissions failure — callers can only match on message
  text;
- the message embeds the absolute config path and another workflow's key, and
  flows wherever errors flow, against this plan's telemetry rules;
- the required surfaces (blocking modal naming the active workflow/harness/file
  with a **View active workflow** action, nonzero CLI exit with a structured
  diagnostic, the same contract for MCP callers, and a persisted diagnostic code
  in status/output) cannot be built from prose; and
- with decision 2, conflicts now occur mid-run and would otherwise enter the
  `errorBehavior` retry path as if they were transient harness failures.

The shape should be equivalent to:

```typescript
type PolicyLeaseResult =
  | { outcome: "acquired" | "shared" }
  | { outcome: "conflict"; diagnostic: PermissionPolicyConflict };

interface PermissionPolicyConflict {
  /** Stable diagnostic code shared by dashboard, CLI, and MCP. */
  code: string;
  harnessId: HarnessId;
  /** Absolute path; surfaces render it workspace-relative. */
  configPath: string;
  key: string;
  activeOwner: {
    workflowKey: WorkflowKey;
    runRef?: RunRef;
    pid: number;
    workflowName?: string;
  };
}
```

`prepareToolPermissions` returns the `ToolPermissionApplication` contract from
"Interface Changes" carrying this diagnostic, and the executor converts a
`conflict` outcome into the blocking error described below.

### Remaining work in this section

- key all baseline state by config file path (decision 1);
- move lease release to step completion, for both the permission lease and MCP
  registration (decision 2);
- add the per-process random token to owner identity (decision 3);
- add the dead-PID pruning regression test (decision 4);
- replace the conflict throw with the structured result (decision 5);
- wrap acquisition in `withFileLock` so the ownership check and write are atomic
  across processes;
- surface a mid-run conflict as a blocking error that stops the workflow and is
  excluded from `errorBehavior` retry;
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
- Hold the configuration for the duration of the step and release on step
  completion (decision 2). This supersedes the earlier "hold for the lifetime of
  the harness process" rule. Steps that inject into a live session acquire
  nothing, because the harness cached its policy at spawn and ctrlyoke restarts
  rather than injects when that policy would change.

### Required disclosure

Project settings are discovered by every matching harness process in that
workspace. While ctrlyoke's injected permission policy is active, it can affect:

- other ctrlyoke workflows using that harness;
- a manually launched harness in the same workspace;
- an interactive session that outlives the workflow step.

Show this caveat before execution and in dry-run output. The caveat should name
the exact file and whether ctrlyoke will restore its owned changes. This is a
non-blocking warning and does not add a confirmation gate.

A harness the user launches manually in the same workspace is explicitly out of
scope (decision 6). ctrlyoke cannot detect or prevent it, and the same exposure
already exists for manually resuming a session ctrlyoke is driving. Disclose the
window honestly and add no machinery that implies the case is handled.

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
that lock. The current implementation does not satisfy this — see
"Cross-process acquisition must be atomic" above.

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

-->

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

Implementation landed on 2026-07-30; inline delivery landed on 2026-07-31:

- `custom` merges a `permission` block beginning with `"*": "ask"`;
- `allowAll` begins with `"*": "allow"` and still applies deny overrides;
- `none` and `dangerouslyAllowAll` do not mutate permissions;
- known ctrlyoke tools map to OpenCode permission keys, including file-write
  aliases to `edit`;
- `shell(command:*)` becomes OpenCode's `bash` wildcard form (`command *`);
- denied rules are inserted after allowed rules for last-match-wins behavior;
- `mcp`, `permission`, and `plugin` are serialized into
  `OPENCODE_CONFIG_CONTENT` per step;
- no `opencode.json` or permission lease is created by a normal OpenCode run;
- the completion plugin is delivered from the extension installation, with a
  warning-backed workspace fallback only when that external path is unusable.

Unit coverage proves mapping, inline MCP/permission composition, matching
headless and interactive spawn env values, accumulator reset between steps, and
the absence of workspace `opencode.json` output.

Manually verified against a real OpenCode CLI on 2026-07-31: allow and deny
decisions were proved correct with safe fixture tools, confirming the
`getPermissionHarnessSupport()` UI gate for OpenCode in
`WorkflowPropertiesPanel.tsx` and `PropertiesDrawer.tsx` can open. The pinned
real-harness regression fixture additionally covers collision rewriting, MCP,
and external-plugin completion in headless and TUI modes; it is intentionally
not run by `npm test`.

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
- real-harness fixtures against pinned CLI versions (run only on request);
- negative behavioral tests that exercise safe denied operations.

An argument/config snapshot is not sufficient evidence for `exact` or `partial`
fidelity with verified status.

## Acceptance Criteria

- Every permission UI clearly states the current granular-support boundary.
- Qwen retains its canonical inline tool-list mapping and never adds a
  workspace permission writer.
- OpenCode no longer claims a permission config side effect it does not perform.
- Qwen and OpenCode granular policies retain their behaviorally justified
  inline capability declarations, with pinned fixtures re-run on CLI upgrade.
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
