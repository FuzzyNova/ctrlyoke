# Feedback, Automation, and Compatibility Staging

**Decided 2026-08-02.** Implementation order for the remaining work in three
plans, none of which is a 0.1.0 release gate:

- [`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md)
  — Phases 2, 2.5 (Site 3), 3, 4, and the Phase 5 guards.
- [`AUTOMATION_API_PLAN.md`](../implemented/AUTOMATION_API_PLAN.md)
  — the per-step `ctrlyoke run --headless --json` v1 contract, in full.
- [`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md)
  — Phase 2, Phase 3, and the permission plan's post-release parity items.

This document owns only **sequencing and the dependency argument**. Each plan
remains the source of truth for its own scope, phases, and acceptance criteria;
do not restate their content here.

**Supersedes** [`COMPATIBILITY_AND_FEEDBACK_STAGING.md`](../implemented/COMPATIBILITY_AND_FEEDBACK_STAGING.md)
for forward-looking work. That document's queue is fully complete and it is
retained as the record of how the 0.1.0 permission gate was sequenced.

**Closed 2026-08-18 after final acceptance.** Stage D (CLI compatibility
validation) is complete: `validate` preserves parse-only behavior by default,
supports selected/all-installed targets, shared diagnostics, strict warning
policies, and a clean compatibility JSON v1 envelope. Stage E (client-scoped routing)
is complete — `WebviewClientContext` is threaded through
`WorkflowMutationCoordinator`, `WorkflowStepHandlers`, `UndoRedoCoordinator`,
and the terminal handlers, and a two-tab isolation test exists
(`CoreFeedbackMigration.test.ts`). It landed across commits `6b1e8040`
(2026-07-24), `aad4be61` (2026-08-02), and `effbc9be` (2026-08-06) — all
before this document's last grooming pass — but was never marked done in the
queue below; that is corrected here. **Stage F has since been completed
(2026-08-17, steps 18-24), Stage D is complete, and Stage G.8 is now complete.**
**Stage G** (compatibility domains and portability reporting) now has its
multi-domain registry, portability projection, React report surface, and
generated customer documentation shipped. The dependency that
formerly split Stage G has now landed: both
[`SECRETS_AND_REDACTION_PLAN.md`](../implemented/SECRETS_AND_REDACTION_PLAN.md)
and [`DRY_RUN_PREVIEW_PLAN.md`](../implemented/DRY_RUN_PREVIEW_PLAN.md) are
implemented. Re-verification also found that the dry-run leg itself shipped
with the preview work: `ExecutionPreviewService` runs the shared analyzer and
projects the actual provider plan, including diagnostics, permission
translation, MCP application, command arguments, and workspace mutations. It
therefore needs acceptance re-verification, not another implementation step.
The final acceptance audit, generated-doc drift check, and project gates are
complete. This staging record and the owning compatibility plan are now
implemented history; future compatibility changes should open a new scoped
plan with fresh provider evidence.

**Addendum 2026-08-14 — the Secrets plan left this queue.**
[`ROADMAP.md`](ROADMAP.md) promoted
[`SECRETS_AND_REDACTION_PLAN.md`](../implemented/SECRETS_AND_REDACTION_PLAN.md) to a
**P0 pre-release one-way door**, on irreversibility grounds rather than the
dependency grounds this document reasons from: unredacted run artifacts already
written cannot be retracted, and Stage B shipped a writer whose v1 contract
promises verbatim condition stdout/stderr. Stage G's dry-run leg is therefore no
longer waiting on an unscheduled plan — it is waiting on P0 work with an owner.
That plan has since landed in full. Nothing else in this queue changes; D and F
were the next unblocked steps at the time (F has since landed, leaving D). See
the revised recommendation at the end.

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

## Current state (measured 2026-08-18)

Measured against `src/`, not read from the plans. Where these disagree with a
plan's own table, this section is newer.

| Fact                                                              | Value                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Direct `show*Message` in reusable code (the parity gap)           | **0** — all six Phase 4 action-bearing sites are resolved; the initial Stage C count was 63 |
| Direct `show*Message` at the VS Code boundary (correctly staying) | **53** across 7 files after F.4 (was 49 across 6 when measured 2026-08-02; 54 before F.4)   |
| Adapter-mediated host UI (`platform.log/warn/error`)              | **0** — all 18 sites now use `UserFeedbackSink`                                             |
| Adapter-mediated `showChoice()`                                   | **0** — the final `CliIntegration.ts` site now uses warning feedback                        |
| `USER_FEEDBACK_SEVERITY`                                          | Shipped in `DashboardConstants.ts:482`                                                      |
| `MESSAGE_TYPES.USER_FEEDBACK`                                     | **Shipped** — Phase 2 transport and sink implementations are wired                          |
| `ToastViewport`                                                   | Shipped, mounted, consuming the queue                                                       |
| `src/cli/CliJsonResultBuilder.ts`                                 | **Shipped** — `cli.ts` emits the versioned per-step JSON v1 envelope with clean stdout      |
| Capability registry, analyzer, snapshot, preflight, honest UI     | Shipped (Compatibility Phases 1A–1C)                                                        |

Two consequences worth naming up front:

1. **The feedback plan's Phases 1 and 2 are genuinely done.** The severity
   constant, rendered queue, transport, sink, and reusable-call migration are
   shipped; all six action-bearing Phase 4 holds are now resolved in Stage F.
2. **The adapter-UI baseline of 19 in
   [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
   Phase 0 is exactly right** (18 + 1). That number is still accurate and can be
   committed as the counter's baseline without re-deriving it.

---

## Dependency map

Only four real dependencies exist across the three plans. Everything else is
preference.

| Work                                            | Genuinely requires                                                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feedback Phase 3 (client-scoped routing)        | Feedback Phase 2's sink contract                                                                                                                                                                                                 |
| Feedback Phase 4 (interactive choices)          | Feedback Phase 2's transport                                                                                                                                                                                                     |
| Decoupling Stage 10 (`StandaloneServerAdapter`) | Feedback Phase 2 deleting the five `PlatformAdapter` UI methods                                                                                                                                                                  |
| Compatibility Phase 2 — **dry-run leg only**    | [`DRY_RUN_PREVIEW_PLAN.md`](../implemented/DRY_RUN_PREVIEW_PLAN.md), which itself needed [`SECRETS_AND_REDACTION_PLAN.md`](../implemented/SECRETS_AND_REDACTION_PLAN.md) — both dependencies and the integration are now shipped |

**The last row is why Compatibility Phase 2 had to be split.** It was written as
one phase — "dry run, portability report, CLI/MCP serialization" — but only the
dry-run third originally carried the dependency, two levels deep behind two
then-Proposed plans. Keeping the phase whole would have parked the other two
legs behind a blocker that did not apply to them. Split apart and judged on
their own, those two legs then went different ways: CLI validation survived as
Stage D, capability serialization was cut, and the portability report was
deferred until multiple domains made it informative. That condition is met by
G.3–G.5, so the report returns afterward as G.6–G.7. The dependency argument
and the value argument are separate, and collapsing them is what the
single-phase framing encouraged.

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
[`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
Phase 0 items 3 and 6 — the direct `show*Message` counter (initial baseline 63
reusable / 53 boundary) and the adapter-UI counter (initial baseline 19).

This is the one item whose cost rises the longer it waits: it exists to stop the
migration target growing while the migration runs, so it must precede Stage C.

**The initial three baselines were re-verified against `src/` on 2026-08-02 as
53 boundary / 63 reusable / 19 adapter-UI; all three were then lowered as Stage
C landed. Current values:**

- **49 boundary as committed by A.1** = `extension.ts` 20, `DevCommands` 12,
  `ContextMenuReferenceCommands` 6, `ScmCommitCommand` 5,
  `ExternalFileTrustPrompt` 3, `NotificationManager` 3. **Now 54 across 7 files**
  (re-read from `FEEDBACK_SOURCE_AUDIT_BASELINES` 2026-08-17): boundary-approved
  growth added `WebviewMessageRouter.ts` 5 to the allowlist.
  Down from 53: C.3 deleted the four `VsCodeAdapter` calls that implemented the
  removed `PlatformAdapter` UI methods. `VsCodeAdapter.ts` stays in the
  counter's `boundaryFiles` list at zero calls, so a future call there is
  classified as boundary rather than counted as a reusable regression.
- **6 reusable after C.6** = `TemplateImporter` 2,
  `WorkflowCommandHandler` 2, `WorkflowOrchestrator` 1, and
  `WorkflowSerializer` 1. These were all Phase 4 interaction holds; F.4
  removed the `WorkflowOrchestrator` and `WorkflowSerializer` sites, and F.5
  removed the two `TemplateImporter` sites, leaving the current reusable
  baseline at 2 (`WorkflowCommandHandler`). The commented
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
[`TOOL_PERMISSION_PARITY_PLAN.md`](../implemented/TOOL_PERMISSION_PARITY_PLAN.md)
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

### Stage B — Automation API, in full — COMPLETE

Self-contained, unblocked, ships a user-visible feature, and produces the
condition-record substrate and JSON envelope convention that Stages C and D
reuse (see the two ordering nudges). Five steps, covering the plan's design
sections in dependency order rather than section order — see the note under the
queue table.

Stage B was completed on 2026-08-02 after live success, end-condition failure,
pre-condition skip, and parse-error verification against the built CLI.

### Stage C — Browser feedback Phases 2 and 2.5

The largest single chunk across all three plans. Split by seam, below.

### Stage D — Compatibility Phase 2, CLI validation only — COMPLETE 2026-08-18

`ctrlyoke validate --harness` / `--all-installed-harnesses --json`. Small,
because the registry and analyzer already exist and this is projection work over
them.

`src/cli.ts` keeps the existing parse-only path intact and now adds mutually
exclusive `--harness` and `--all-installed-harnesses` targets, real cached
availability/version probing, shared consumer-level diagnostics, typed
`--strict lossy|unverified|all` policies, and a one-line compatibility JSON v1
envelope. The analyzer retargets each enabled AI consumer without bypassing
the shared resolver's inheritance/provenance; scripts and `finalStep` handling
remain covered by focused parser/command/result tests. Validation never creates
`WorkflowInstance` or starts a harness.

**The other two legs of Phase 2 left Stage D on 2026-08-02**, leaving CLI
validation as the whole stage:

- **Portability report — deferred to Phase 3, now restored as G.6–G.7.** At the
  time, `enabledDomains` was
  `["permissions"]`, so every row of the table would be driven by one near-constant
  question (does this harness enforce allow/deny lists), making it a static
  documentation table rendered as a per-workflow report. It only becomes
  informative once Phase 3 adds domains — at which point the generated
  compatibility docs that Phase 3 already planned might have covered the need
  better than an in-dashboard panel. G.3–G.5 make the report genuinely
  workflow-specific across several domains, while generated docs remain a
  static harness-fact surface, so the two are no longer substitutes.
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

### Stage E — Browser feedback Phase 3 — DONE

Client-scoped routing. **Identical work to decoupling plan Phase 5 item 1** —
execute once, and update both plans when it lands.

**Confirmed complete (2026-08-11).** `WebviewClientContext` is threaded per-message
through `WebviewMessageRouter` into all four target modules — every public
method on `WorkflowMutationCoordinator` and `WorkflowStepHandlers` takes `ctx:
WebviewClientContext` and replies only via `ctx.postMessage`/`ctx.emit`;
`TerminalMessageHandlers` is scoped the same way; `UndoRedoCoordinator` takes
an explicit `postMessage`/`clientId` per call, with `WebviewMessageRouter`
passing the single initiating client rather than broadcasting. Commit
`aad4be61` removed the last broadcast/native-modal fallbacks from exactly
these four files. `DashboardBroadcastHub` still broadcasts, correctly, for
genuine shared/background events (workflow-registry add/dismiss/summary) —
that is the plan's own carve-out, not a leftover gap. A representative
two-tab isolation test exists at `CoreFeedbackMigration.test.ts:25-45`
(`browser:1` receives a scoped failure, `browser:2` receives nothing).
**Outstanding nit, not a blocker:** that test covers the shared
`WebviewClientContext` scoping generically; there is no dedicated per-module
two-tab test for the terminal or undo/redo paths specifically. Worth a small
follow-up if item 4's acceptance bar is read as per-module coverage.

**The decoupling plan's Phase 5 item 1 status was not checked as part of this
pass** (out of scope for this document) — `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`
Stage 6 describes this as the same edit set and should be updated to reflect
that it has landed, per this document's own "update both plans when it lands"
rule above.

### Stage F — Browser feedback Phase 4 + Phase 6 — COMPLETE 2026-08-17

**Redesigned 2026-08-17: the `USER_INTERACTION_REQUEST` correlation contract
is no longer being built.** Each of the 6 surviving action-bearing sites was
re-examined individually against the current code instead — four are cut
outright, two relocate into existing/inline UI (`DeleteConfirmModal` for
clear-all-workflows; a small in-app control for post-script-create; an inline
retry affordance for harness detection). Full per-site findings and decisions
are in `BROWSER_USER_FEEDBACK_PLAN.md` Phase 4. F.4 is complete: both
post-workspace-init toasts and the native clear-all confirmation are gone, and
clear-all now uses `DeleteConfirmModal`.

The final action-bearing site previously called
`vscode.window.show*Message(...)` directly with action-button strings:
`WorkflowCommandHandler.ts:148` (retry harness automation). F.7 removed that
gate and added the inline retry affordance next to `HarnessDropdown`, with a
client-scoped result and host-aware feedback.
F.6 moved the post-script-create flow from `WorkflowCommandHandler.ts` into
`ScriptConditionEditor` with a client-scoped router reply and deleted the
native command.
F.5 cut the `TemplateImporter.ts:200` overwrite and `TemplateImporter.ts:243`
post-import sites together with the import command and repointed
`ctrlyoke.createNewTemplate` at the pre-expanded `TemplateModal` flow.
Completed in F.4: `WorkflowOrchestrator.ts:1344` and its duplicate
`extension.ts:177` (post-workspace-init, cut), plus `WorkflowSerializer.ts:1375`
(clear-all-workflows, replaced by `DeleteConfirmModal`). **All locations were
re-verified against `src/` on 2026-08-17.**

**Stage F also now owns Phase 6**, added to the feedback plan on 2026-08-17 and
not previously represented in this queue. It was a distinct gap from everything
above: the _webview's own_ toast dispatch was not host-aware, so 27 call sites
across 9 `webview-react` files rendered an in-app toast even inside the VS Code
panel. Phase 6 adds a single client-side `notifyUser()` dispatcher (the
client-side counterpart to Phase 2's `UserFeedbackSink`) and has migrated those
sites to it. **Phase 6 is complete and was sequenced before Phase 4** — Phase
4's two relocated sites report through `notifyUser()` rather than hand-rolling
a `standalone` check that would immediately need migrating.

### Stage G — Compatibility Phase 3, and the deferred remainder — PARTIALLY SHIPPED

Capability domains (hooks, MCP per-server tool filtering, images), generated
compatibility docs, the Codex partial-support investigation, and a
re-evaluation of the portability report against a multi-domain registry.

**MCP per-server filtering is now enabled (2026-08-18), and image prompt inputs
are now enabled (2026-08-18).** The registry defaults to `permissions`,
`promptInputs`, `hooks`, and `mcp`; all six adapters own declarations for
`mcp.perServerToolFiltering`, including Codex's native server-denial path and
Antigravity's explicit unsupported state. The analyzer diagnoses every authored
unsupported, partial, or unverified server filter with its exact RFC 6901
pointer and MCP source tier, while translated and native verified paths remain
execution-plan truth. Copilot and Claude declare verified native image
attachment through their existing provider reference conventions; Codex and
OpenCode now use their native `--image`/`--file` attachment arguments, while
Qwen and Antigravity remain explicitly unsupported because their current
adapters do not pass a verified native vision attachment. Image
diagnostics are emitted only for resolved full-file image references, point to
the authored prompt field, and remain at the prompt authoring surface; no
Harness-tab badge plumbing was added.

**The dry-run leg is already complete.** `ExecutionPreviewService.build()`
calls `analyzeCompatibility()` and the shared `ExecutionPlanBuilder.plan()`,
then exposes both the structured diagnostics and the provider's actual command,
permission application, MCP application, and workspace mutations through
`WorkflowExecutionPreview`. CLI JSON, terminal rendering, the React
`DryRunModal`, and focused service/UI tests consume that projection. Secrets
and the central redaction pipeline have also landed, so there is neither a
blocker nor missing dry-run implementation left to queue.

**Usage is removed from Stage G, not enabled.** The plan's own rule says to
remove this domain if Antigravity reaches the normalized usage contract before
implementation. It has: `AntigravityUsageProvider` participates in the same
six-provider `HarnessUsageService`, and the Antigravity statusline/log parser
now supplies normalized turn and context-window usage. Usage is therefore a
uniform workflow feature, not a compatibility dimension. The registry
foundation step should remove the unused `usage` capability vocabulary rather
than populate it.

**The MCP contract is now narrowed to per-server filtering.**
Injection remains a uniform feature and is not modeled; only
`perServerToolFiltering` is in the registry.

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

| #   | Stage | Scope                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A.1   | **DONE** — Shrink-only `show*Message` and adapter-UI counters, with baselines committed as measured above                                                                                                                                                                                                                                                                                |
| 2   | A.2   | **DONE** — Author-time diagnostic for ctrlyoke MCP tool denials; route `permissionApplication.diagnostics` off `Log.warn`                                                                                                                                                                                                                                                                |
| 3   | A.3   | **DONE** — Antigravity `allowAll` no longer uses the dangerous bypass; mode fidelity is partial and author-time compatibility remains honest                                                                                                                                                                                                                                             |
| 4   | A.4   | **DONE** — Preserve `headers` (and other unmodelled fields) across the `McpServerForm` edit round trip with transport-aware invalidation                                                                                                                                                                                                                                                 |
| 5   | B.1   | **DONE** — Typed pre/end-condition summaries are queue-owned and recorded through final verdict/error/retry paths; effective `executionMode` persists in `_runtime` (plan §3)                                                                                                                                                                                                            |
| 6   | B.2   | **DONE** — `RunOutputResolver` one-pass attempt/file-event/loop projection with focused streaming/history coverage (plan §2)                                                                                                                                                                                                                                                             |
| 7   | B.3   | **DONE** — CLI-local result contract + `CliJsonResultBuilder`, consuming steps 5–6 (plan §1)                                                                                                                                                                                                                                                                                             |
| 8   | B.4   | **DONE** — Wire the builder into `cli.ts` success and `catch` paths; single-line stdout (plan §4)                                                                                                                                                                                                                                                                                        |
| 9   | B.5   | **DONE** — Live end-to-end CLI verification on `opencode-cli`; fixed defects; moved the plan to `dev/implemented/`                                                                                                                                                                                                                                                                       |
| 10  | C.1   | **DONE** — Added the `USER_FEEDBACK` contract, payload type, unconditional browser toast handler, and focused Vitest coverage                                                                                                                                                                                                                                                            |
| 11  | C.2   | **DONE** — Added the injectable feedback sink contract and VS Code/console/hosted-WebSocket implementations, with browser-only broadcast and focused Mocha coverage                                                                                                                                                                                                                      |
| 12  | C.3   | **DONE** — Migrated all 19 adapter-UI calls incl. `CliIntegration.ts:1380` `showChoice` (Phase 2.5 Site 3); deleted the five `PlatformAdapter` UI methods and updated all impls                                                                                                                                                                                                          |
| 13  | C.4   | **DONE** — AST-verified triage of all 63 reusable direct sites: 1 policy deletion, 7 duplicate deletions, 8 noise deletions, 39 scoped replies, 8 broadcast/interaction-held sites; no migration                                                                                                                                                                                         |
| 14  | C.5   | **DONE** — Executed the triage for the core/orchestration group (32 sites in 4 files); retained five interaction holds for Phase 4 and recorded 23 client-scope fallbacks for Stage E                                                                                                                                                                                                    |
| 15  | C.6   | **DONE** — Executed the triage for the ui/utils group (31 sites in 8 files); reusable direct-message baseline is now 6, with the six Phase 4 interaction holds remaining                                                                                                                                                                                                                 |
| 16  | D     | **DONE 2026-08-18** — `ctrlyoke validate` compatibility targets, real installed-harness filtering, shared diagnostics, strict CI policies, clean JSON v1 output, human remediation output, and focused parser/command/result coverage (`0551b3b6`)                                                                                                                                       |
| 17  | E     | **DONE** — `WebviewClientContext` threaded through `WorkflowMutationCoordinator`, `WorkflowStepHandlers`, `UndoRedoCoordinator`, and terminal handlers (landed 2026-07-24 to 2026-08-06); two-tab isolation test in `CoreFeedbackMigration.test.ts`                                                                                                                                      |
| 18  | F.1   | **DONE.** Phase 6 infra: `MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK` in `src/types/DashboardConstants.ts` / `src/types/WebviewMessageTypes.ts`, the `WebviewMessageRouter` handler and shared-sink wiring in `src/ui/WebviewMessageRouter.ts`, `src/ui/CtrlYokeWebviewProvider.ts`, `src/extension.ts`, plus `notifyUser()` in `src/ui/webview-react/utils/notifyUser.ts`                       |
| 19  | F.2   | **DONE.** Phase 6 step 4: migrated Group A's 15 client-only toast call sites (8 `webview-react` files) to `notifyUser()`; the 2026-08-17 re-verification matched the table and found no action-bearing exceptions                                                                                                                                                                        |
| 20  | F.3   | **DONE.** Phase 6 steps 5–7: migrated Group B's 12 scoped-reply handlers to `notifyUser()`, retained the standalone duplicate-tab action, and added the shrink-only raw-toast audit (baseline 1)                                                                                                                                                                                         |
| 21  | F.4   | **DONE.** Phase 4 items 5 + 6: cut both duplicate workspace-init toasts; funnel clear-all-history through `DeleteConfirmModal` (`boundary` 54 → 53, `reusable` 6 → 4)                                                                                                                                                                                                                    |
| 22  | F.5   | **DONE.** Phase 4 items 3 + 4: deleted `TemplateImporter.ts` and `ctrlyoke.importWorkflowTemplates`; repointed `ctrlyoke.createNewTemplate` at the pre-expanded `TemplateModal` (`reusable` 4 → 2)                                                                                                                                                                                       |
| 23  | F.6   | **DONE.** Phase 4 item 1: in-app end-condition script creation in `ScriptConditionEditor`; deleted `ctrlyoke.createEndConditionScript` (`reusable` 2 → 1)                                                                                                                                                                                                                                |
| 24  | F.7   | **DONE.** Phase 4 item 2: inline harness-detection retry next to `HarnessDropdown`; cut the `openPanel()` gate (`reusable` 1 → 0)                                                                                                                                                                                                                                                        |
| 25  | G.0   | **DONE ahead of this queue.** Dry-run already runs the shared analyzer and exact provider plan; Secrets/Redaction is implemented and all preview surfaces consume the redacted projection (`1e942605`)                                                                                                                                                                                   |
| 26  | G.1   | **DONE 2026-08-18 (`32ed9400`).** Codex 0.147.0 source/schema and local `execpolicy` evidence show no safe general mapping for arbitrary shell, MCP, or read/write tool patterns; declarations remain unsupported, diagnostics remain required, server-owned `disabled_tools` is reserved for G.4, and Antigravity 1.1.12 remains unsupported for granular lists                         |
| 27  | G.2   | **DONE 2026-08-18 (`5930fb7d`).** Generalized provider-owned registry assembly, snapshot guards, completeness, version-aware effective-state lookup, and serialization across arbitrary enabled domain sets; removed uniform `usage` and stale MCP injection vocabulary, and added six-harness/invalid/round-trip coverage                                                               |
| 28  | G.3   | **DONE 2026-08-18 (`3f8b5903`).** Enabled hooks as the first new complete domain across all six harnesses; moved event support to adapter-owned declarations, added configured-event analyzer/preview/UI coverage, and layered diagnostics over the Hooks tab without changing hook state or introducing notification preferences                                                        |
| 29  | G.4   | **DONE 2026-08-18 (`11892482`).** Enabled adapter-owned MCP per-server filtering across all six harnesses; preserved translated runtime denials, Codex native `disabled_tools`, and Antigravity unsupported behavior; moved diagnostics into the MCP domain with per-server RFC 6901 pointers, dedupe-safe preview coverage, persistent editor diagnostics, and MCP warning-tab overlays |
| 30  | G.5   | **DONE 2026-08-18 (`cf3c92b2`).** Enabled images across all six harnesses; propagated resolved full-file refs; added prompt-pointer diagnostics and preview/editor coverage; ordinary refs, scripts, disabled steps, and the Harness-tab badge remain untouched                                                                                                                          |
| 31  | G.6   | **DONE 2026-08-18 (`d802b9c8`).** Added the pure installed-harness portability projection over the multi-domain analyzer, with ready/lossy/unsupported/workspace-side-effect rows, unverified visibility, stable diagnostic identities/remediation, side-effect drill-down, deterministic ordering, and authored-object immutability coverage                                            |
| 32  | G.7   | **DONE 2026-08-18 (`77af50e4`).** Added the shared React workflow portability report, workflow-properties entry point, snapshot-based row drill-down, loading/empty/responsive/focus handling, and dashboard/hosted-client shared-surface coverage                                                                                                                                       |
| 33  | G.8   | **DONE 2026-08-18 (`500d14d8`).** Added the compiled-registry compatibility-doc generator and checked-in matrix for all six harnesses and enabled leaves, with shared caveat/remediation prose, portable attachment versus optional native discovery guidance, VitePress links, and a byte-for-byte `--check` gate on `docs:build`; `.ctrlyoke/capabilities.json` remains untouched      |
| 34  | G.9   | **DONE 2026-08-18** — Final acceptance audit and full project/docs gates passed; bounded defects were fixed, owning plans updated, and both plans moved to `dev/implemented/`. The closure commit is the handoff evidence.                                                                                                                                                               |

**Stage B was reordered on 2026-08-02 from the plan's section numbering.** The
plan lists the builder first, but `CliJsonResultBuilder` consumes the projection
type from plan §2 and the condition-summary types from plan §3 — writing it first
means writing it against types that do not exist and revising it twice. Producers
now land first (§3 → §2 → §1 → §4), which is this document's own
contracts-before-consumers rule. The plan's §5 test list was also folded into the
steps that introduce each behavior, freeing step 9 to be the live end-to-end run
that mocks cannot substitute for.

Step 13 was deliberately its own step. The plan is explicit that porting all
sites is the wrong default and that a meaningful fraction should be deleted;
the completed C.4 table now fixes the exact work for steps 14 and 15 before
either implementation session starts.

**Stage C was corrected on 2026-08-02 before queueing, on three points.**

1. **Steps 12 and 15 both claimed `CliIntegration`'s `showChoice`.** Step 12
   deletes `showChoice` from `PlatformAdapter`; step 15 owned its only surviving
   caller. Step 12 cannot land with the caller unmigrated, so Phase 2.5 Site 3
   moved into step 12 and step 15 is now purely triage execution. The
   suppression flag that site needs already exists
   (`ConfigurationUtils.shouldShowHeadlessPermissionWarning()` /
   `setShowHeadlessPermissionWarning()`), so the migration is a feedback
   emission, not new persistence.
2. **Steps 14 and 15 were re-split by file group, not by disposition class.**
   Splitting "deletions + scoped replies" from "broadcast ports" means almost
   every one of the 12 files gets edited twice by two sessions that each hold
   half the triage — `WorkflowCommandHandler` alone has 13 sites that would span
   both. Splitting by file lets each file be finished once: step 14 takes
   `WorkflowCommandHandler` (13), `TemplateImporter` (7), `WorkflowOrchestrator`
   (7), `PromptFileLoader` (5); step 15 takes `McpManagerService` (8),
   `WorkflowSerializer` (8), `UndoRedoCoordinator` (5), `WorkflowStepHandlers`
   (5), `TerminalMessageHandlers` (2), and one each in
   `PromptEditorSupportService`, `WorkflowMutationCoordinator`,
   `FileSystemUtils`.
3. **The initial three baselines were re-measured by AST on 2026-08-02 before
   Stage C** — exactly 53 boundary / 63 reusable / 19 adapter-UI, matching what
   Stage A.1 committed. Stage C then took adapter-UI to 0, boundary to 49, and
   reusable to 6. Note that an AST scan reports
   `CliIntegration`'s `showChoice` at **1380**, the start of the call expression
   (`this.platform`), while the plan cites **1381**, where `.showChoice(`
   textually sits. Both are correct; the split-line form is the reason this
   counter cannot be a line-oriented `grep`, as noted under A.1.

### The Stage A.1 counters fail on shrink, not just growth

`assertShrinkOnly` in `src/test/unit/SourceAuditCounters.test.ts` throws in
**both** directions: a count below the committed baseline is as much a failure as
one above it, and the message tells you to lower the baseline. This is
deliberate — it keeps the baseline honest rather than letting it drift above
reality — but it means every step from 12 onward **must edit
`FEEDBACK_SOURCE_AUDIT_BASELINES` in the same commit that removes call sites**,
or `npm test` fails on a change that is otherwise correct. Step 12 takes
`adapterUi` to 0; steps 14 and 15 each lower `directMessage.reusable`. The
`boundary` baseline — 49 when Stage C landed, **53 after F.4** — must not move for
any Stage C/D step; those sites are staying. Stage F is the one exception: it
lowers `boundary` 54 → 53 exactly once, in the step that deletes the duplicate
workspace-initialization toast at `extension.ts:177`, and takes
`directMessage.reusable` 6 → 4 in F.4, then 4 → 0 across its remaining steps.

### Stage C.3 disposition — complete

All 19 adapter-mediated sites remain operational user feedback: workflow load,
queue, parse, execution-limit, harness-failure, retry-failure, and headless
permission outcomes are visible outcomes for the person running the workflow,
not diagnostic-only noise. Their existing `Log.*` calls remain the separate
diagnostic channel; no `PlatformAdapter` logging meaning was preserved. The
headless permission warning now emits warning feedback without an inline
"Don't Show Again" action. The suppression setting remains reachable through
the dashboard's General settings section (`ui.showHeadlessPermissionWarning`)
and remains user-editable.

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

### Browser feedback Phase 3 — client-scoped routing (Stage E) — DONE

Threads `WebviewClientContext` (or a scoped feedback callback) into the router
delegates that currently emit process-global messages —
`WorkflowMutationCoordinator`, `WorkflowStepHandlers`, `UndoRedoCoordinator`,
terminal handlers — so a failure caused by one browser tab returns to that tab
instead of every connected client, while genuine background events stay on the
broadcast path. This is the same edit set as decoupling plan Phase 5 item 1; do
it once and update both plans.

**Landed 2026-07-24 through 2026-08-06** (commits `6b1e8040`, `aad4be61`,
`effbc9be`), confirmed against `src/` on 2026-08-11. The decoupling plan's own
Phase 5 item 1 status still needs updating to match — this document was
corrected first.

### Browser feedback Phase 4 — interactive choices (Stage F)

**Redesigned 2026-08-17 — no correlated `USER_INTERACTION_REQUEST` contract.**
The 6 surviving reusable action-bearing messages (template overwrite,
post-import, post-script-create, retry harness automation, post-workspace-init,
clear-all-workflows) were re-examined one by one instead: template
overwrite and post-import are the same `TemplateImporter.importWorkflowTemplates()`
call and are both cut (superseded by `TemplateModal`'s "New template..." flow);
post-workspace-init is cut (it's a click-through after the user already acted
in `StartupOverlay`, and there are actually two duplicate toasts, both cut);
post-script-create moves into a small in-app control in
`ScriptConditionEditor.tsx`; retry harness automation moves into an inline
affordance next to `HarnessDropdown`; clear-all-workflows is funneled through
the existing `DeleteConfirmModal` (it was never actually using it, despite
looking like it should have been). See `BROWSER_USER_FEEDBACK_PLAN.md` Phase 4
for the full per-site reasoning. All six items are implemented in F.4–F.7.
The duplicate-running-workflow site was deleted in C.4 as a policy conflict
and was never in Stage F's scope.

### Compatibility Phase 2 — CLI validation (Stage D)

`ctrlyoke validate` gains `--harness <id>` and
`--all-installed-harnesses --json`, emitting the same stable diagnostic codes
the dashboard already renders, so CI can fail on errors and optionally on
lossy/unverified classes. The workflow-level portability report follows the
multi-domain work as G.6–G.7. Capability serialization remains cut:
`.ctrlyoke/capabilities.json` keeps its existing availability/model data and
existence-validation role.

### Compatibility Phase 2 — dry-run leg (completed ahead of Stage G)

`ExecutionPreviewService` already integrates diagnostics and the actual provider
translation into dry-run preview, and every CLI/dashboard preview surface
consumes its redacted DTO. `DRY_RUN_PREVIEW_PLAN.md` and
`SECRETS_AND_REDACTION_PLAN.md` are both implemented. The final audit should
re-run this acceptance coverage, but no new implementation step is warranted.

### Compatibility Phase 3 — capability domains (Stage G)

Expands `enabledDomains` beyond `permissions`, one domain at a time, each with
the completeness test across all six `HARNESS_IDS`: hooks and notifications,
MCP per-server tool filtering, and image prompt inputs. MCP injection remains a
uniform product feature and is not modeled. The required Antigravity usage
re-audit is now complete: all six harnesses participate in the normalized usage
pipeline, so the unused usage vocabulary is removed rather than enabled.
Finishes with the workflow-level portability report and generated
customer-facing compatibility documentation from the registry instead of
hand-maintaining parity claims.

### Permission plan post-release items (completed)

The Codex partial-support investigation and Antigravity re-audit are complete.
Neither provider has a documented, behaviorally verified general granular-list
mapping, so the registry retains honest unsupported declarations and the
analyzer continues to disclose those requests. No parity gap remains queued;
future changes require new provider evidence.

---

## Closure record

Re-verified against `src/` on 2026-08-18, including the final acceptance audit.
Stages A–G are complete. Stage D's CLI validation, Stage G's dry-run,
multi-domain registry, hooks/MCP/image compatibility, portability report,
generated documentation, and Codex/Antigravity evidence review all passed the
required gates. The analyzer now stays silent for domains outside the snapshot
rollout, strict CLI policies classify every enabled domain, and runtime image
diagnostics use the actual prepared attachments.

No implementation work remains in this staging sequence. New provider behavior
or capability domains require fresh evidence and a new scoped plan.

**The Secrets plan is complete and is no longer sequenced from here.** The previous
recommendation was to pick it up only when Stage G's dry-run leg was the piece
actually being worked. [`ROADMAP.md`](ROADMAP.md) promoted
[`SECRETS_AND_REDACTION_PLAN.md`](../implemented/SECRETS_AND_REDACTION_PLAN.md) to a
**P0 pre-release one-way door** on 2026-08-14, on a criterion this document does
not model: irreversibility. Redaction is not merely a dependency of dry-run
preview — it is a producer for everything that writes run artifacts, and
unredacted artifacts already written cannot be retracted. Stage B has **already
shipped** one such writer: the JSON v1 contract promises pre-condition,
end-condition, and script stdout/stderr "exactly as produced; no CLI-only
truncation."

That promotion does not contradict this document's ordering rule — "defer only on
a real unbuilt dependency, or when landing it first makes later work harder" — it
satisfies it. Redaction is a contract that later writers consume, so
contracts-before-consumers applies, and this document already applied that rule
to reorder Stage B. The practical effect is now visible in the code: the plan
landed and dry-run already consumes its redaction contract, so that leg is
marked complete rather than re-queued.

The queue is complete and this document was moved to `dev/implemented/` on
2026-08-18.

## What would change this recommendation

- ~~`DRY_RUN_PREVIEW_PLAN.md` is shipped; taking on `SECRETS_AND_REDACTION_PLAN.md` —
  that pulls Compatibility Phase 2's dry-run leg out of Stage G and back beside
  Stage D.~~ **Triggered and completed.** The Secrets plan landed, and code
  inspection confirmed the dry-run integration had already shipped; G.0 records
  it complete.
- ~~Pulling [`STANDALONE_SERVER_PLAN.md`](../active/STANDALONE_SERVER_PLAN.md)
  forward — its Phase 5 needs the `PlatformAdapter` UI methods gone, which would
  promote Stage C.3 ahead of everything else in Stage C.~~ Moot: Stage C.3
  already deleted the five `PlatformAdapter` UI methods, so this dependency is
  satisfied regardless of standalone-server sequencing.
- Evidence that Codex or Antigravity has a usable granular-policy mechanism —
  that moves the investigation out of Stage G and enlarges the registry work.
- A decision to work the decoupling plan directly — Stages A, C.3, and E (all
  now complete) were stages of it; a fresh decision to work that plan directly
  would still make it the owning sequence for D/F/G's remaining decoupling
  overlap rather than a cross-reference.
