# Feedback, Automation, and Compatibility Staging

**Decided 2026-08-02.** Implementation order for the remaining work in three
plans, none of which is a 0.1.0 release gate:

- [`BROWSER_USER_FEEDBACK_PLAN.md`](../backlog/BROWSER_USER_FEEDBACK_PLAN.md)
  — Phases 2, 2.5 (Site 3), 3, 4, and the Phase 5 guards.
- [`AUTOMATION_API_PLAN.md`](AUTOMATION_API_PLAN.md)
  — the per-step `ctrlyoke run --headless --json` v1 contract, in full.
- [`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](../backlog/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md)
  — Phase 2, Phase 3, and the permission plan's post-release parity items.

This document owns only **sequencing and the dependency argument**. Each plan
remains the source of truth for its own scope, phases, and acceptance criteria;
do not restate their content here.

**Supersedes** [`COMPATIBILITY_AND_FEEDBACK_STAGING.md`](COMPATIBILITY_AND_FEEDBACK_STAGING.md)
for forward-looking work. That document's queue is fully complete and it is
retained as the record of how the 0.1.0 permission gate was sequenced.

---

## The framing this settles

> Should the order of this work be decided by what belongs in 0.1.0?

**No.** Release scope and implementation order are separate questions, and only
one of them is urgent. Release is months out and its remaining blockers are
manual/external work — [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md)
(domain, Netlify, Workspace inboxes, repo rename, Marketplace) and
[`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) (Lemon Squeezy, Keygen, the EULA) —
none of which is unblocked by code sequencing.

So the ordering rule for everything below is **"what is the right way to build
this feature"**, not **"is this acceptable to ship 0.1.0 without"**. Concretely
that means:

- A plan's phase is not deferred merely because it was labelled post-release.
  The P0/P1 labels in the three plans recorded a _release-gate_ judgment, not an
  engineering one, and they no longer drive order.
- A phase is deferred only when it has a real unbuilt dependency (see the
  dependency map) or when landing it first would make later work harder.
- Nothing here is scoped down to fit a milestone. Where a plan's phase is large,
  it is split by seam, not by what would be "enough for now".

The one place release scope still legitimately constrains order is the
**shrink-only baselines** in Stage A: those exist to stop a metric growing while
a long migration is in flight, and that argument is independent of release date.

---

## Current state (measured 2026-08-02)

Measured against `src/`, not read from the plans. Where these disagree with a
plan's own table, this section is newer.

| Fact                                                              | Value                                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Direct `show*Message` in reusable code (the parity gap)           | **63** across 12 files (an AST count; the earlier 64/13 included the commented-out call in `WorkspaceSessionManager.ts:62`) |
| Direct `show*Message` at the VS Code boundary (correctly staying) | **53** across 7 files                                                                                                       |
| Adapter-mediated host UI (`platform.log/warn/error`)              | **18** — `WorkflowInstance` ×9, `PromptFileParser` ×4, `WorkflowExecutor` ×3, `CliIntegration` ×1, `EndConditionHandler` ×1 |
| Adapter-mediated `showChoice()`                                   | **1** — `CliIntegration.ts:1381` (was 1394 before Stage A.2 edited the file above it; the plan's 1373 is older still)       |
| `USER_FEEDBACK_SEVERITY`                                          | Shipped in `DashboardConstants.ts:482`                                                                                      |
| `MESSAGE_TYPES.USER_FEEDBACK`                                     | **Does not exist** — Phase 1 landed the severity vocabulary and the queue, not the transport                                |
| `ToastViewport`                                                   | Shipped, mounted, consuming the queue                                                                                       |
| `src/cli/CliJsonResultBuilder.ts`                                 | **Does not exist** — `cli.ts:541` still emits the compact unversioned payload via `console.log`                             |
| Capability registry, analyzer, snapshot, preflight, honest UI     | Shipped (Compatibility Phases 1A–1C)                                                                                        |

Two consequences worth naming up front:

1. **The feedback plan's Phase 1 is genuinely done and Phase 2 is genuinely
   untouched.** The severity constant and the rendered queue exist; there is no
   message type, no sink, and no migrated call site. Phase 2 starts from zero.
2. **The adapter-UI baseline of 19 in
   [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../backlog/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
   Phase 0 is exactly right** (18 + 1). That number is still accurate and can be
   committed as the counter's baseline without re-deriving it.

---

## Dependency map

Only four real dependencies exist across the three plans. Everything else is
preference.

| Work                                            | Genuinely requires                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feedback Phase 3 (client-scoped routing)        | Feedback Phase 2's sink contract                                                                                                                                |
| Feedback Phase 4 (interactive choices)          | Feedback Phase 2's transport                                                                                                                                    |
| Decoupling Stage 10 (`StandaloneServerAdapter`) | Feedback Phase 2 deleting the five `PlatformAdapter` UI methods                                                                                                 |
| Compatibility Phase 2 — **dry-run leg only**    | [`DRY_RUN_PREVIEW_PLAN.md`](../backlog/DRY_RUN_PREVIEW_PLAN.md), which itself needs [`SECRETS_AND_REDACTION_PLAN.md`](../backlog/SECRETS_AND_REDACTION_PLAN.md) |

**The last row is why Compatibility Phase 2 had to be split.** It is written as
one phase — "dry run, portability report, CLI/MCP serialization" — but only the
dry-run third carries the dependency, and it carries it two levels deep behind
two Proposed plans. Keeping the phase whole would have parked the other two legs
behind a blocker that does not apply to them. Split apart and judged on their
own, those two legs then went different ways: CLI validation survived as Stage
D, and the portability report and capability serialization were both cut (see
Stage D for the reasoning). The dependency argument and the value argument are
separate, and collapsing them is what the single-phase framing encouraged.

Non-dependencies, stated explicitly so they are not re-litigated:

- **Automation API and browser feedback are independent.** Their only file
  overlap is `WorkflowExecutor` (3 adapter calls) and `EndConditionHandler`
  (1) — different concerns in the same files, not the same edits.
- **Compatibility Phase 3 does not depend on Phase 2.** It adds capability
  domains to the shipped registry; the reporting surfaces are separate.
- **Nothing here depends on the rebrand or licensing work**, and that work does
  not depend on any of this.

### The two ordering nudges that do exist

Neither is a blocker; both are cheap to honor and annoying to get wrong.

1. **Automation API step 3 before feedback triage of the same two files.**
   Automation records structured pre-condition and end-condition summaries onto
   `PromptResult` / `FinalStepRuntimeState`. Feedback Phase 2 then has to
   classify `EndConditionHandler` and `WorkflowExecutor` message sites against
   the "Delete — duplicate" test. Doing automation first means those sites can
   be deleted in favor of a real structured record rather than migrated to a
   toast that duplicates it.
2. **Automation API before Compatibility Phase 2's CLI leg.** Both add versioned
   JSON to `cli.ts`. Automation defines the `schemaVersion` envelope for `run`;
   `validate --json` should follow the same convention rather than inventing a
   second one.

---

## Recommended order

### Stage A — guards and independent bug fixes (do first)

Four items, mutually independent, none blocking anything else. The counters go
first; the three bugs can land in any order.

#### A.1 — freeze the baselines

Land the two **shrink-only counters** from
[`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../backlog/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
Phase 0 items 3 and 6 — the direct `show*Message` counter (baseline 63 reusable
/ 53 boundary) and the adapter-UI counter (baseline 19).

This is the one item whose cost rises the longer it waits: it exists to stop the
migration target growing while the migration runs, so it must precede Stage C.

**The three baselines were re-verified against `src/` on 2026-08-02; the
measured numbers below are the committed baselines:**

- **53 boundary** = `extension.ts` 20, `DevCommands` 12, `ContextMenuReferenceCommands` 6,
  `ScmCommitCommand` 5, `VsCodeAdapter` 4, `ExternalFileTrustPrompt` 3, `NotificationManager` 3.
- **63 reusable** = `WorkflowCommandHandler` 13, `WorkflowSerializer` 8,
  `McpManagerService` 8, `WorkflowOrchestrator` 7, `TemplateImporter` 7,
  `PromptFileLoader` 5, `WorkflowStepHandlers` 5, `UndoRedoCoordinator` 5,
  `TerminalMessageHandlers` 2, and 1 each in `FileSystemUtils`,
  `WorkflowMutationCoordinator`, `PromptEditorSupportService`. The commented
  `WorkspaceSessionManager` reference is not an AST call site.
- **19 adapter-UI** = `WorkflowInstance` 9, `PromptFileParser` 4, `WorkflowExecutor` 3,
  `EndConditionHandler` 1, `CliIntegration` 1 (`platform.warn`), plus the one `showChoice`.

Neither counter can be a line-oriented `grep`: `PromptFileParser.ts:227` and
`EndConditionHandler.ts:382` call through `this.platform?.` (optional chaining),
and `CliIntegration.ts:1381`'s `.showChoice(` sits on its own line with the
receiver above it. Count by AST, and exclude declarations and prose — the
`show*Message` members declared in `platform/vscode-shim.ts`, the four
`PlatformAdapter.ts` doc-comment mentions, and the comment references in
`WebviewMessageTypes.ts` and `useMessageHandler.ts` are not call sites.

**A.1 constrains A.2.** Once the adapter-UI counter is frozen at 19, the runtime
diagnostic routing in A.2 cannot be implemented with a new `platform.warn` — it
must reach an existing dashboard/status surface instead. That is the intended
pressure, not an obstacle to route around by raising the baseline.

**Scope it to the counters only.** Decoupling Phase 0 also specifies `vscode`
import path groups, an allowlist, and a bundle metafile check. Those belong to
the decoupling plan's own sequence and are not needed to protect this work;
pulling them in here would triple the stage for no benefit to Stages B–G.

#### A.2 — ctrlyoke MCP tool denials are silently unenforced on Antigravity

Found 2026-08-02 while auditing the cut of the MCP capability serialization.
Owned by
[`TOOL_PERMISSION_PARITY_PLAN.md`](../backlog/TOOL_PERMISSION_PARITY_PLAN.md)
"Known enforcement gaps"; that plan holds the full trace. It is queued here
because it is the same dishonest-enforcement class the 0.1.0 gate existed to
close, and because a checkbox is a stronger promise than a pattern textarea.

#### A.3 — Antigravity maps `allowAll` to `--dangerously-skip-permissions`

Also owned by the permission plan's "Known enforcement gaps". Distinct from A.2
and worth resolving in the same pass, since both concern whether Antigravity's
declared capabilities match what it actually enforces.

#### A.4 — `McpServerForm` silently drops `headers` on edit — RESOLVED

A plain data-loss bug with no owning plan; it lives here.
`src/ui/webview-react/components/shared/McpServerForm.tsx` round-trips only
id/description/command/args/env/autoApprove/url/transport —
`serverToMcpServerFormState()` (line 64) never reads `headers`, and
`mcpServerFormStateToServer()` (line 81) rebuilds a fresh `McpServerConfig`
without it. Import a remote registry server carrying required headers
(`McpManagerSection.tsx:204` populates them), press Edit then Save, and the
headers are gone — while `ServerDetails` still renders a `headers` row, so the
loss is visible after the fact. Fix by preserving unmodelled fields across the
form round trip rather than by adding a header editor; `deniedTools` is
vulnerable to the same rebuild if the ctrlyoke entry ever becomes editable
through this form.

**`autoApprove` is lossy in the same round trip and belongs to the same fix.**
`McpServerConfig.autoApprove` is `boolean | string[]`, but `McpServerFormState`
narrows it to `boolean` — so a server carrying a per-tool allowlist
(`autoApprove: ["tool_a"]`) comes back from `serverToMcpServerFormState()` as
`false` and is rebuilt as an omitted field. This is a value collapse rather than
a dropped key, so preserving "fields the form does not model" is not by itself
sufficient; the original value has to survive alongside the boolean the checkbox
edits. Whatever mechanism preserves it must still drop fields the user
deliberately invalidated by switching the stdio/remote tab — a server edited from
remote to stdio must not retain `url`, `transport`, or `headers`.

Resolved 2026-08-02 — the form keeps a cloned original config snapshot and applies
transport-aware invalidation before saving the edited fields.

### Stage B — Automation API, in full

Self-contained, unblocked, ships a user-visible feature, and produces the
condition-record substrate and JSON envelope convention that Stages C and D
reuse (see the two ordering nudges). Five steps, covering the plan's design
sections in dependency order rather than section order — see the note under the
queue table.

### Stage C — Browser feedback Phases 2 and 2.5

The largest single chunk across all three plans. Split by seam, below.

### Stage D — Compatibility Phase 2, CLI validation only

`ctrlyoke validate --harness` / `--all-installed-harnesses --json`. Small,
because the registry and analyzer already exist and this is projection work over
them.

**The other two legs of Phase 2 were cut on 2026-08-02**, leaving CLI validation
as the whole stage:

- **Portability report — dropped, revisit in Phase 3.** `enabledDomains` is
  `["permissions"]`, so every row of the table would be driven by one near-constant
  question (does this harness enforce allow/deny lists), making it a static
  documentation table rendered as a per-workflow report. It only becomes
  informative once Phase 3 adds domains — at which point the generated
  compatibility docs that Phase 3 already plans may cover the need better than an
  in-dashboard panel. Re-evaluate it there rather than building it now.
- **MCP capability serialization — cut.** Its only payoff was letting an agent
  calling `ctrlyoke_append_queue` pick a harness knowing which ones enforce tool
  lists. That fails on its own terms: a serialized snapshot is **context-free**,
  so it would tell an agent "Antigravity does not enforce denied tools" even when
  the workflow's permission mode is `none`, `passthrough`, or
  `dangerouslyAllowAll` and no deny list is in play. The analyzer is honest here
  precisely because it gates on `used: deniedTools.length > 0`
  (`CompatibilityAnalyzer.ts:152`) — a static per-harness table cannot make that
  judgment. And it plugs no hole: `analyzeCompatibility()` already runs at
  authoritative execution preflight (`WorkflowInstance.ts:429`), so an
  agent-appended step still produces its diagnostic when the workflow runs.
  `.ctrlyoke/capabilities.json` keeps its existing availability/model data and
  its existence-validation role in `mcp-server.ts:485`.

### Stage E — Browser feedback Phase 3

Client-scoped routing. **Identical work to decoupling plan Phase 5 item 1** —
execute once, and update both plans when it lands.

### Stage F — Browser feedback Phase 4

Interactive choices: the 7 surviving action-bearing sites and the
`USER_INTERACTION_REQUEST` correlation contract.

### Stage G — Compatibility Phase 3, and the deferred remainder

Capability domains (hooks, MCP per-server tool filtering, images, usage),
generated compatibility docs, the Codex partial-support investigation,
Compatibility Phase 2's dry-run leg once `DRY_RUN_PREVIEW_PLAN.md` exists, and a
re-evaluation of the portability report against a multi-domain registry.

**`mcp.injection` was deleted from Phase 3 on 2026-08-02.** Every harness
attaches MCP servers, so it is a uniform product feature, and the plan's own rule
is to remove uniform behavior from the registry rather than ship a dimension
whose entries are all identical. It is now listed alongside execution mode and
sessions under "Uniform Workflow Features Outside the Registry".

**Preference note.** Stages B and C are mutually independent; if the appetite is
to start on feedback rather than automation, swap them. The only cost is
nudge (1) — `EndConditionHandler` and `WorkflowExecutor` get touched twice — and
that cost is small. Stage A should still go first either way.

---

## Queued implementation sequence

Single-session steps. Each commits its own work and leaves this document and its
owning plan current. Steps are strictly ordered within a stage; stages B and C
may be swapped as a block.

| #   | Stage | Scope                                                                                                                                        |
| --- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A.1   | **DONE** — Shrink-only `show*Message` and adapter-UI counters, with baselines committed as measured above                                    |
| 2   | A.2   | **DONE** — Author-time diagnostic for ctrlyoke MCP tool denials; route `permissionApplication.diagnostics` off `Log.warn`                    |
| 3   | A.3   | **DONE** — Antigravity `allowAll` no longer uses the dangerous bypass; mode fidelity is partial and author-time compatibility remains honest |
| 4   | A.4   | **DONE** — Preserve `headers` (and other unmodelled fields) across the `McpServerForm` edit round trip with transport-aware invalidation     |
| 5   | B.1   | **DONE** — Typed pre/end-condition summaries are queue-owned and recorded through final verdict/error/retry paths; effective `executionMode` persists in `_runtime` (plan §3) |
| 6   | B.2   | **DONE** — `RunOutputResolver` one-pass attempt/file-event/loop projection with focused streaming/history coverage (plan §2)                |
| 7   | B.3   | CLI-local result contract + `CliJsonResultBuilder`, consuming steps 5–6 (plan §1)                                                            |
| 8   | B.4   | Wire the builder into `cli.ts` success and `catch` paths; single-line stdout (plan §4)                                                       |
| 9   | B.5   | Live end-to-end CLI verification on `opencode-cli`; fix defects; move the plan to `dev/implemented/`                                         |
| 10  | C.1   | `MESSAGE_TYPES.USER_FEEDBACK` + payload type + browser handler                                                                               |
| 11  | C.2   | `UserFeedbackSink` contract; VS Code, console, and hosted-WebSocket implementations; browser-only broadcast                                  |
| 12  | C.3   | Migrate the 18 adapter-UI calls + `showChoice`; delete the five `PlatformAdapter` UI methods and update all impls                            |
| 13  | C.4   | Triage all 63 reusable direct sites and record per-site disposition (no migration yet)                                                       |
| 14  | C.5   | Execute the triage: deletions and scoped-reply conversions                                                                                   |
| 15  | C.6   | Execute the triage: broadcast ports; `CliIntegration.ts:1381` "don't show again" (Phase 2.5 Site 3)                                          |
| 16  | D     | `ctrlyoke validate --harness` / `--all-installed-harnesses --json`, following the step-9 envelope convention                                 |
| 17  | E     | Client-scoped routing (= decoupling Phase 5 item 1); two-tab isolation tests                                                                 |
| 18  | F     | `USER_INTERACTION_REQUEST` contract; migrate the 7 action-bearing sites; headless fallbacks                                                  |
| 19  | G.x   | Compatibility Phase 3 domains, generated docs, Codex investigation, dry-run integration                                                      |

**Stage B was reordered on 2026-08-02 from the plan's section numbering.** The
plan lists the builder first, but `CliJsonResultBuilder` consumes the projection
type from plan §2 and the condition-summary types from plan §3 — writing it first
means writing it against types that do not exist and revising it twice. Producers
now land first (§3 → §2 → §1 → §4), which is this document's own
contracts-before-consumers rule. The plan's §5 test list was also folded into the
steps that introduce each behavior, freeing step 9 to be the live end-to-end run
that mocks cannot substitute for.

Step 13 is deliberately its own step. The plan is explicit that porting all
sites is the wrong default and that a meaningful fraction should be deleted;
triage is the work that decides how large steps 14 and 15 actually are, and it
is worth having reviewed before either of them starts.

---

## Work summaries

One paragraph per chunk, so scope is legible without re-reading three plans.

### Automation API — per-step `--json` (Stage B, whole plan)

`ctrlyoke run --headless --json` currently emits an unversioned compact payload:
version, file, harness/model, workflow status, and aggregate counts. The plan
replaces it with a versioned v1 contract carrying a row per queue step —
effective harness/model/execution mode, terminal status, attempt count and last
attempt, timings, session ID, deduplicated scope-classified file changes,
pre-condition and end-condition verdicts with stdout/stderr/exit code, failure
classification — plus a separate `finalStep` summary so an unbounded loop cannot
inflate the step array. The runtime already holds all of this; the work is
projection, not new instrumentation, with one real exception: pre-condition
output and the _final_ end-condition evaluation are not currently retained on
the queue result, so step 3 adds typed summaries and the narrow `PromptQueue`
methods to record them. Values of workflow variables are deliberately excluded
(names only) because stdout ends up in CI logs.

### Browser feedback Phase 2 — operational feedback transport (Stage C)

The largest chunk. Adds `MESSAGE_TYPES.USER_FEEDBACK` and a narrow
`UserFeedbackSink` port, with VS Code / console / hosted-WebSocket
implementations, where the browser sink deliberately excludes the VS Code panel
so completions never render twice. Then migrates callers: the 18
adapter-mediated `platform.log/warn/error` calls in `WorkflowInstance`,
`PromptFileParser`, `WorkflowExecutor`, `CliIntegration`, and
`EndConditionHandler` move to the sink and the five UI methods are **deleted**
from `PlatformAdapter` — deleting them is what stops the native path being
reintroduced, and it is what unblocks `StandaloneServerAdapter`. The 63 direct
`show*Message` calls in reusable code are triaged first against the plan's
five-class table (delete-policy-conflict / delete-duplicate / delete-noise /
convert-to-scoped-reply / port-to-broadcast); sampling suggests scoped reply,
not toast, is the largest class. Operational feedback must never route through
`dispatchCompletionNotification()`, or it inherits the notification settings
gate and vanishes for anyone with browser notifications off.

### Browser feedback Phase 2.5 Site 3 (folded into Stage C.6)

The last surviving `showChoice()` — a "don't show again" harness warning at
`CliIntegration.ts:1381`. Unlike the two deleted end-condition dialogs it is
neither execution-blocking nor policy-contradicting, so it migrates normally:
feedback plus a persisted suppression flag.

### Browser feedback Phase 3 — client-scoped routing (Stage E)

Threads `WebviewClientContext` (or a scoped feedback callback) into the router
delegates that currently emit process-global messages —
`WorkflowMutationCoordinator`, `WorkflowStepHandlers`, `UndoRedoCoordinator`,
terminal handlers — so a failure caused by one browser tab returns to that tab
instead of every connected client, while genuine background events stay on the
broadcast path. This is the same edit set as decoupling plan Phase 5 item 1; do
it once and update both plans.

### Browser feedback Phase 4 — interactive choices (Stage F)

The 7 reusable action-bearing messages (template overwrite, post-import,
post-script-create, retry harness automation, duplicate-running-workflow,
post-workspace-init, clear-all-workflows) get a correlated
`USER_INTERACTION_REQUEST` contract: the browser returns only a request ID and a
choice ID, the host owns what the choice means. Requires timeout, dismissal, and
disconnect handling, a defined headless fallback per interaction, and rejection
of duplicate/expired responses. The duplicate-running-workflow site should be
re-tested against the policy-conflict rule first — it may be a deletion rather
than a migration, like the two end-condition dialogs were.

### Compatibility Phase 2 — unblocked legs (Stage D)

Three projections over the shipped registry and analyzer. `ctrlyoke validate`
gains `--harness <id>` and `--all-installed-harnesses --json`, emitting the same
stable diagnostic codes the dashboard already renders, so CI can fail on errors
and optionally on lossy/unverified classes. A workflow-level portability report
evaluates one workflow against every installed harness as a
ready/lossy/unsupported/side-effects table with drill-down to step and property
findings. `.ctrlyoke/capabilities.json` gains the installed-version-aware
capability subset alongside its existing availability/model data, without
becoming a second source of truth.

### Compatibility Phase 2 — dry-run leg (deferred into Stage G)

Integrating diagnostics and the actual provider translation into dry-run preview
requires a dry-run service that does not exist. `DRY_RUN_PREVIEW_PLAN.md` is
Proposed and states it needs both the compatibility contracts (now shipped) and
the redaction contracts from `SECRETS_AND_REDACTION_PLAN.md` (also Proposed).
Two unbuilt plans deep — this is the only item in the three plans with a genuine
blocking dependency.

### Compatibility Phase 3 — capability domains (Stage G)

Expands `enabledDomains` beyond `permissions`, one domain at a time, each with
the completeness test across all six `HARNESS_IDS`: hooks and notifications, MCP
injection and per-server tool filtering, image prompt inputs, and usage
metadata. **Re-audit Antigravity before implementing the usage domain** — the
plan is explicit that if every harness has reached the same normalized usage
contract by then, usage should be _removed_ from the registry rather than
shipped as a compatibility dimension whose entries are all identical. Finishes
with generating customer-facing compatibility documentation from the registry
instead of hand-maintaining parity claims.

### Permission plan post-release items (Stage G)

Two remaining, both research-shaped rather than build-shaped. The **Codex
partial-support investigation** asks whether `shell(command:*)` maps to
project-local command prefix rules, whether MCP tool patterns map to per-server
enabled/disabled lists, and whether broad read/write patterns map to permission
profiles — with the standing rule that `partial` is only advertised for
categories that earn a behavioral test, and that its honest answer may be "no
safe general mapping exists". **Antigravity** stays an explicit unsupported
granular-list declaration until its CLI exposes a documented granular mechanism;
notably, granular support must not be inferred from Gemini/Qwen configuration
just because the products share history and directories.

---

## What would change this recommendation

- `DRY_RUN_PREVIEW_PLAN.md` and `SECRETS_AND_REDACTION_PLAN.md` being taken on —
  that pulls Compatibility Phase 2's dry-run leg out of Stage G and back beside
  Stage D.
- Pulling [`STANDALONE_SERVER_PLAN.md`](../backlog/STANDALONE_SERVER_PLAN.md)
  forward — its Phase 5 needs the `PlatformAdapter` UI methods gone, which would
  promote Stage C.3 ahead of everything else in Stage C.
- Evidence that Codex or Antigravity has a usable granular-policy mechanism —
  that moves the investigation out of Stage G and enlarges the registry work.
- A decision to work the decoupling plan directly — Stages A, C.3, and E are all
  stages of it, and it would become the owning sequence rather than a
  cross-reference.
