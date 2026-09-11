# Execution-Root Coordination Plan

> **Status:** Backlog / design proposal. Nothing here is implemented.
>
> **Supersedes:** `PARALLEL_STEP_COORDINATION_PLAN.md`, which scoped a coordination
> board to one workflow run and only made it reachable from inside a `parallel:`
> group. This revision (2026-09-10) widens the scope to **anything sharing an
> execution root** — parallel steps, sequential steps, and separate parallel
> _workflows_ alike — and folds in a fix for `global_status`, which turned out to
> be the coarse half of the same problem.
>
> **Depends on:** [`PARALLEL_STEPS_PLAN.md`](../implemented/PARALLEL_STEPS_PLAN.md)
> (shipped, adds fork/join scheduling and topology — unchanged by this plan) and
> [`WORKTREE_SUPPORT_PLAN.md`](../implemented/WORKTREE_SUPPORT_PLAN.md) (shipped,
> defines the execution-workspace model and execution-lease scope identity this
> plan reuses directly).

## Problem

Two independent things run concurrently against the same files today, and
neither has a coordination channel:

1. **Members of one `parallel:` group.** Worktree is a workflow-level property
   (`WORKTREE_SUPPORT_PLAN.md`), so every member of a group edits the same
   execution root at the same time by construction. Two members told to
   "implement the API layer" and "implement the client layer" will both touch
   shared types; today the failure is silent — last writer wins, and neither
   agent ever learns the other existed.
2. **Separate ordinary workflows sharing the main checkout.** ctrlyoke has
   supported running several non-worktree workflows in parallel for a long time
   (`shared-native` execution leases explicitly allow this). Two such workflows
   editing the same repository at the same time have exactly the same silent
   last-writer-wins problem as (1). It has simply gone unaddressed for longer,
   because it predates the parallel-steps feature and nobody framed it as the
   same bug.

These are **the same problem with the same fix**, once stated correctly: any
two agents that can write to the same execution root need a channel. The
scoping unit is not "run" and not "workflow" — it is **execution root**, the
concept `WORKTREE_SUPPORT_PLAN.md` already defines precisely for a different
purpose (execution leases): the worktree-specific absolute Git directory when
the root is inside a linked worktree, or the canonical execution-root path
otherwise.

The previous revision of this plan scoped the board to `run-<timestamp>/`
inside one lineage's run directory. That accidentally solves problem (1) (all
members of a group share a run) but cannot solve problem (2) at all — two
sibling workflows have different `workflowKey`/`runRef` values and no shared
run directory to write a board into. Rescoping to the execution root solves
both with one mechanism and no new concept.

Today, coordination options are:

- `global_status` (`src/mcp-server.ts`) is read-only and, per a live audit on
  2026-09-10, actually broken: it returns **every workflow lineage that has
  ever run in the workspace** (1,205 entries in this repository, ~948,000
  characters — enough to blow past the calling agent's own output limit),
  filtered by nothing. Only 2 of those 1,205 were actually `running`. It
  cannot see sibling parallel-group steps at all, and it is not scoped to "what
  can actually collide with me" (it spans every worktree in the workspace, most
  of which are filesystem-isolated from the caller by design).
- Prior context and sessions are resolved from a join-boundary snapshot
  (`PARALLEL_STEPS_PLAN.md` Decision 5), so `read_output` deliberately cannot
  show a group member what a sibling produced.
- The ctrlyoke MCP server is **hard-blocked inside a group**:
  `ParallelGroupPreflight.ts:234` raises
  `PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.DYNAMIC_QUEUE` for any non-script
  member where `hasCtrlYokeServer(resolvedProperties)` is true. A group member
  cannot call _any_ ctrlyoke tool.
- Separate ordinary workflows have never had a coordination channel of any
  kind beyond the now-broken `global_status`.

So the design question is not "which tool do we extend for parallel steps" —
it is "what is the right coordination primitive for anything sharing an
execution root, and how does it reach a process that today either has no
ctrlyoke tools at all (group members) or only a workspace-wide firehose
(ordinary steps)".

## The unifying insight: scope by execution root, not run

Everything below follows from one substitution: replace "per run" with "per
execution-root identity" everywhere the previous revision said "per run".

This is a good scoping unit, not an arbitrary wider one, because it is exactly
the boundary that determines whether two agents can actually collide on a
file:

- Parallel-group members always share an execution root (worktree is
  workflow-level, so a group can never span two worktrees). "Coordinate with my
  group siblings" becomes a filtered read of "coordinate with everyone sharing
  my execution root" — no separate mechanism needed.
- Two `shared-native` ordinary workflows in the main checkout share an
  execution root and can genuinely collide — they get the same channel for
  free.
- Two workflows in **different** worktrees (managed, named, or one worktree
  vs. the main checkout) do not share an execution root and structurally
  cannot collide on files — `exclusive-worktree` leases guarantee at most one
  occupant per worktree at a time. A path-claim/note board scoped there would
  answer a question nobody has. This is why cross-worktree coordination stays
  out of scope for the board (see `global_status` below for what that case
  actually needs).
- A managed worktree's directory is removed at the end of a run, but its
  Git **common directory** is not — worktrees share the object store and refs
  with the source checkout. Storing the board under the common directory
  (exactly where execution leases already live) means it survives worktree
  removal the same way a managed branch does, and remains inspectable
  alongside future runs against that same repository.

## How other systems solve this

Unchanged from the previous revision — restated because it still narrows the
design the same way, just applied to a wider "who" than just group siblings.

| Primitive                      | Who uses it                                                              | Verdict for ctrlyoke                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Shared task list + deps**    | Claude Code Agent Teams; most orchestrators                              | **Already ours.** The workflow definition _is_ the task list; `append_step`/`edit_step`/`reorder_steps` are its mutation API. Do not rebuild it. |
| **Mailbox / peer messaging**   | Agent Teams (`inboxes/{agent}.json`), cross-session messaging            | **Take it**, but as a filtered read of one board rather than N files.                                                                            |
| **Blackboard / shared board**  | Blackboard architectures; L2MAC; shared-KV "Shared File System Protocol" | **Take it.** One append-only artifact, indirect coordination, no rendezvous.                                                                     |
| **File locking / ownership**   | Agent Teams file locks; per-agent file scope                             | **Take it, advisory and non-blocking** (see Decision 3).                                                                                         |
| **Per-agent worktree + merge** | Agent Teams best practice; manual worktree workflows                     | **Rejected here** — worktrees stay workflow-level (see Not In Scope).                                                                            |
| **Observation-driven / CRDT**  | CodeCRDT and similar research                                            | Too speculative for a first release.                                                                                                             |

The consistent finding across the product write-ups is that **the coordination
primitive is the cheap part; getting agents to use it is the expensive part**.
That shapes staging below: the prompt preamble matters at least as much as the
tools.

## Decisions

### 1. One append-only board per execution root, not per run and not per member

Storage root: reuse the exact identity `ExecutionRootLeaseManager`'s
(currently private) `resolveLeaseScope(executionRoot)` already computes for
execution leases — extract it into a shared helper (e.g.
`src/core/orchestration/ExecutionRootScope.ts`, consumed by both the lease
manager and the coordination board) rather than duplicating the git-common-dir
resolution and non-git fallback:

```text
<git-common-dir>/ctrlyoke/coordination/<scope-hash>/board.jsonl        (Git roots)
<executionRoot>/.ctrlyoke/coordination/board.jsonl                     (non-Git fallback)
```

This sits next to `<git-common-dir>/ctrlyoke/execution-leases/<scope-hash>/`
by design: both are keyed by the same canonical identity, both need the same
"does this scope record match, or is this a collision" guard
(`verifyScopeRecord`'s pattern), and a caller resolving "who else is here and
what have they said" wants one lookup, not two independently-derived paths
that could drift.

One file, not a mailbox per member and not a file per run, because:

- a directed message is just an entry with a `to` field, so a mailbox is a
  filtered read and needs no second storage mechanism;
- broadcast is the dominant case here (members mostly need to announce, not
  ask);
- one file means one lock, one cursor model, one size cap;
- ordering across every agent that can actually collide is well-defined, which
  per-mailbox or per-run files cannot give once the "who" spans workflows.

Entry shape (draft — belongs in `src/types/` beside the timeline types).
Compare to the previous revision: identity is now a full run-addressed tuple,
not a bare step index, because step indices collide constantly across
workflows (every workflow has a "step 0").

```typescript
interface CoordinationEntry {
  seq: number; // monotonic within the execution-root scope
  at: string; // ISO timestamp
  kind: "note" | "claim" | "release";
  /** Author's run address. Never author-supplied — see Decision 4. */
  from: {
    workflowKey: WorkflowKey;
    runRef: RunRef;
    stepIndex: number;
    stepName?: string;
    parallelGroupId?: string;
  };
  /** note: optional directed recipients. Absent = broadcast to the scope. */
  to?: Array<{ workflowKey: WorkflowKey; runRef: RunRef; stepIndex: number }>;
  text?: string; // note
  paths?: string[]; // claim / release, workspace-relative
  reason?: string; // claim
}
```

Appends go through `withFileLock` (`src/utils/FileLockUtils.ts`) on the board
path, exactly as `RunContinuationService` already establishes for
run-directory mutations from the MCP server; `seq` is assigned inside the
lock.

Current claim ownership is a **fold over the log**, not stored state — same
rule `ParallelGroupDefinition` follows for topology and the parallel plan
applied to group status: never store mutable status next to durable identity.
A claim is released by an explicit `release` entry, by the owner's step
reaching a terminal `_runtime`, or (for group members) at the join.

### 2. Four MCP tools, available to any step in the scope — not just group members

| Tool            | Shape                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `post_note`     | `{ text, to?: Array<{ workflowKey, runRef, stepIndex }> }` → `{ seq }`                              |
| `read_notes`    | `{ since?: number, from?: Array<{ workflowKey, runRef, stepIndex? }> }` → `{ entries, nextCursor }` |
| `claim_paths`   | `{ paths: string[], reason? }` → `{ granted: string[], denied: [{ path, owner }], claims }`         |
| `release_paths` | `{ paths: string[] }` → `{ released: string[] }`                                                    |

`claim_paths` returns the full current ownership map, so a separate
`list_claims` tool is unnecessary. `paths` are workspace-relative and
validated through `PathSecurity` like every other path input; globs are
matched literally against other claims (overlap detection is string/glob
comparison, not filesystem walking — the point is intent, not enforcement).

**This is the load-bearing change from the previous revision:** these tools are
not parallel-group-specific. Any sequential workflow step gets them too,
subject to the same per-step `mcpServers` opt-in every other MCP tool already
uses. This answers Open Question #4 from the previous revision ("should the
board be exposed to a sequential workflow's steps too?") as yes — it costs
nothing extra once the scope key is the execution root rather than the run,
and it is what makes problem (2) above (sibling ordinary workflows) solvable
at all.

These join `MCP_TOOL_DEFINITIONS` and `MCP_WORKFLOW_TOOL_NAMES` in
`src/utils/McpToolDefinitions.ts`, which automatically flows them into the
generated `ctrlyoke-mcp-tools` skill (`McpToolSkillGenerator.MCP_TOOL_SKILL_TOOL_NAMES`)
and into `CommitMessageGenerator`'s `deniedTools` list. Handlers live in
`CtrlYokeMCPServer` and route through `queueOperation()` for the write paths,
same as every other mutating tool.

### 3. Claims are advisory and never block

`claim_paths` returns immediately. A denied claim reports the owning run
address so the agent can post a note to that step, pick different files, or
report the contention in its own output for a human or synthesis step to
resolve.

This is deliberate. A blocking lock inside an agent turn is a deadlock that
costs real money: two agents each holding one path and wanting the other's
would stall until the workflow execution timeout. Non-blocking advisory claims
cannot deadlock, and the failure mode (an agent proceeds anyway) is exactly
today's behavior — so the feature is strictly an improvement even when agents
ignore it.

A bounded `wait_for_release` is a plausible later addition. It is not in v1.

### 4. Identity comes from the CLI process environment, not the MCP config — and it now has to include a root the MCP server doesn't currently receive

This was already the load-bearing constraint in the previous revision for
group membership, and it gets one addition: the MCP server today has no
notion of "execution root" at all, only "state root".

Per `WORKTREE_SUPPORT_PLAN.md`'s role table, `CTRLYOKE_WORKSPACE` (the env var
`CliMcpConfigGenerator` sets, `src/core/harness/shared/CliMcpConfigGenerator.ts:339,516`)
is the **state** root, not the execution root — they differ precisely in
worktree mode, which is exactly the case this plan cares about. A new env var
is required, e.g. `CTRLYOKE_EXECUTION_ROOT`, threaded the same additive way
`CliProviderUtils.buildMcpConfigAdditionalEnv` already threads
`CTRLYOKE_MAX_QUEUE_SIZE`/`CTRLYOKE_HOME`/etc (`src/core/harness/shared/CliProviderUtils.ts:529`)
— the `ExecutionWorkspace.executionRoot` is already available at that call
site via `workflowContext`, so this is additive plumbing, not new
architecture.

Per-step identity still cannot live in that same MCP `env` block, for the
reason the previous revision already established:

- `CliMcpConfigGenerator.getConfigFilePath()` derives the config filename from
  the **working file's basename**. Every member of a group — and, in the
  widened scope, every concurrently running step of any kind — shares one
  working file per run, so concurrent steps of the same run would overwrite
  each other's identity in that file.
- Worse for `buildSettingsJsonMcpEntries()` harnesses (Qwen, Antigravity,
  OpenCode): the MCP block lives in a **shared workspace settings file**,
  ref-counted across workflows by `SettingsJsonMcpTracker`. There is exactly
  one env block for the whole workspace.

The workable path remains the **CLI process environment**, which a stdio MCP
server inherits as a child process. `CliExecutionRunner`'s unconditional
`headlessEnv` (`CTRLYOKE_RUN_ID`, `CTRLYOKE_NOTIFY_DIR`, …, around line 351) is
where `CTRLYOKE_STEP_INDEX` / `CTRLYOKE_STEP_NAME` / `CTRLYOKE_PARALLEL_GROUP_ID`
belong, and it is already unconditional for every step of every workflow —
sequential or grouped — so extending coordination identity to ordinary steps
needs no new conditional path here, only the fields themselves. Note
`CTRLYOKE_PROMPT_INDEX` already exists but is **conditional** —
`buildHookEnvVars()` returns `{}` when no notification hook events are enabled
— so it cannot be reused as-is.

Two caveats that Stage 0 exists to settle (unchanged from the previous
revision):

- Env inheritance for stdio MCP servers is **client behavior**, not
  spec-guaranteed. It must be verified per harness, not assumed.
- The interactive/terminal path merges only `buildHookProcessEnv()`, not
  `headlessEnv`. Parallel groups already refuse interactive multiplexing
  (`PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INTERACTIVE_MULTIPLEX`), but an
  ordinary interactive sequential step now also wants coordination tools, so
  this gap should be closed rather than only documented as acceptable.

If a harness turns out not to propagate env, it does not get coordination
tools — surfaced as a new preflight diagnostic rather than as a silent
misattribution. Identity is never taken from a tool argument; that is the same
rule `requireRunAddress()` already applies to run addressing, and for the same
reason.

### 5. Split the `DYNAMIC_QUEUE` preflight ban per tool, and filter `ListTools` — for every step, not only group members

The current ban is all-or-nothing and is scoped to group membership. It
becomes a **tool-availability mode** that applies uniformly, whether or not
the calling step is part of a `parallel:` group:

| Tool                                                       | Inside a parallel group                                                                                                                                                                | Ordinary sequential step     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `post_note`, `read_notes`, `claim_paths`, `release_paths`  | allowed                                                                                                                                                                                | allowed                      |
| `workflow_status`, `capabilities`, `global_status`         | allowed (read-only)                                                                                                                                                                    | allowed (unchanged)          |
| `read_output`                                              | allowed, but restricted to steps before the group's start boundary — matching Decision 5 of `PARALLEL_STEPS_PLAN.md`, so sibling output stays an explicit note, never an implicit read | unchanged                    |
| `append_step`, `edit_step`, `remove_step`, `reorder_steps` | **still refused** — they would race the coordinator's join and topology invariants                                                                                                     | unaffected (already allowed) |

The `DYNAMIC_QUEUE` diagnostic narrows to "this member enables queue-mutating
MCP tools while inside a group", and group members that only want coordination
stop failing preflight. Ordinary sequential steps were never subject to this
ban and are unaffected except for gaining the four new tools.

**`ListTools` must be filtered, not just `CallTool` rejected.** `setupHandlers()`
returns `this.getToolDefinitions()` unconditionally today. An agent that sees
`append_step` in a group will call it, burn a turn on the refusal, and often
derail. `getToolDefinitions()` takes the calling context (group membership,
if any) and returns the permitted subset.

### 6. Notes are untrusted content

A note is text written by another AI agent — possibly running a different
workflow entirely, authored by a different user session. It is data, never
instruction, and never permission. Whether it is injected into a sibling's
context or rendered in the dashboard, it carries explicit attribution and
framing ("from `<workflow> · step 3`, untrusted"). A note must not be able to
grant an action a member was otherwise not allowed to take. This mirrors how
Claude Code Agent Teams treats inter-agent messages and how this repo already
treats MCP-read run content.

Caps, enforced at append: max entry text length, max entries in the scope, max
total board bytes. A chatty agent in a loop, or many workflows over a long
session in one checkout, must not be able to write an unbounded file. Over-cap
appends fail with a clear message rather than truncating silently. See
Decision 8 for why the cap policy itself changes shape once the board is no
longer bounded by one run's lifetime.

### 7. Visible in the dashboard — but now potentially cross-workflow

Coordination that the user cannot see is worse than none — a deferred edit
looks identical to a lazy agent. For entries authored by the currently open
run, project the board into the chronological activity timeline the parallel
plan already built (`OutputPane`, `useOutputRowsModel`, `outputRows.ts`), as a
distinct row kind rendered under the group header (or inline for a sequential
step).

This is new relative to the previous revision: because the board can now
contain entries from a **different** run than the one currently open (a
sibling ordinary workflow sharing the checkout), the per-run timeline is not
the only place this needs to surface. A workspace-level surface — plausibly a
small "who else is in this checkout" panel fed by the same fixed
`global_status` (below) cross-referenced with the board — is needed for that
case. This plan does not design that panel; it flags that Stage 5 must decide
between (a) a minimal read-only note strip outside the per-run timeline, or
(b) deferring cross-workflow visibility to a later pass and shipping only the
same-run projection first. Leaning toward (b) for v1: the same-run projection
covers the parallel-group case completely and the cross-workflow case is
lower-frequency; ship it once real usage data from (b) exists.

Read the board from `coordination.jsonl`-equivalent storage directly rather
than adding a `TIMELINE_EVENT_TYPES` entry: the MCP server writes from a
**separate process**, so a `TimelineRecorder` call is not available to it, and
the extension has to watch the file regardless. `ExternalRunWatchSession`
already establishes the watcher shape for run-directory artifacts; watching an
execution-root-scoped path instead of a run-scoped one is the same mechanism
pointed at a different (now longer-lived) file. This also avoids a
`TIMELINE_SCHEMA_VERSION` bump.

### 8. Retention changes shape: a size/age ring buffer, not "the run ends"

The previous revision's caps (Decision 6 there) still apply, but the
justification changes. A run-scoped board was naturally bounded by run
lifetime even before any cap was enforced. An execution-root-scoped board is
not bounded by anything — the main checkout's board could accumulate entries
across months of unrelated workflows.

Enforce, at append time, whichever the scope config sets first:

- max total entries in the board (oldest entries trimmed);
- max total board bytes;
- max entry age (entries older than N days dropped on next append/compaction).

Trimming a `note` entry is safe once its authoring run is no longer
addressable as "current" context for a live agent (i.e., once it's not needed
for `read_notes { since }` continuity of any run still executing). Trimming
must never drop a `claim` entry whose corresponding `release` (explicit,
terminal-`_runtime`, or join) has not yet been folded, or the claim-ownership
fold would silently un-deny a still-held path. Compact by folding: replace a
long prefix of settled claim/release pairs with nothing (they cancel out) and
only then trim remaining notes by count/age.

## `global_status`: fix, keep, and clearly separate from the board

An audit run on 2026-09-10 against this repository confirmed the concern that
motivated this whole rewrite: `global_status` returns **every workflow lineage
that has ever run in the workspace**, not "what's currently running."

- `handleGlobalStatus()` calls `lineageRepository.listLineageKeys()`, which is
  a `readdir` over the entire `.runs/` directory tree — every lineage, live or
  finished, with no execution-state filter of any kind (`WorkflowLineageRepository.ts:495`).
- For each lineage it reports `descriptor.latestRunRef`'s `_runtime.executionState`,
  which answers "what did this lineage's most recent run end up as", not "is
  anything happening right now."
- Live result: **1,205 workflows**, ~948,000 characters, 18,858 lines — the
  call itself exceeded the calling agent's output-token limit before any agent
  could read the answer. Breakdown of what came back:

  | State       | Count |
  | ----------- | ----- |
  | completed   | 1,139 |
  | stopped     | 34    |
  | idle        | 25    |
  | error       | 5     |
  | **running** | **2** |

  Only 2 of 1,205 entries were the signal the tool's own description promises
  ("List the other ctrlyoke workflows in this workspace and what they are
  doing... so you can leave files another workflow is working on alone").

**Decision: keep `global_status`, and keep it deliberately workspace-wide
(cross-worktree), but filter it to currently-live executions.**

This is not the same job as the coordination board, and should not become the
same tool:

- The board answers "who shares my execution root and can literally collide
  with my file writes" — necessarily scoped to one execution root, because
  claims on paths only mean something against files you can actually write to.
- `global_status` answers "what else is happening anywhere in this workspace,
  including other worktrees" — a coarser, read-only radar. This stays useful
  specifically **because** worktrees isolate filesystems but not everything
  else: two workflows in different worktrees can still contend on a shared dev
  server, a shared port, a shared external service, or a shared CI status, and
  an agent debugging an unexpected build failure benefits from knowing "oh,
  workflow X is also running, that's probably it" even though it cannot have
  touched this agent's files.

Fix, without widening scope:

1. **Filter to non-terminal `executionState`.** Only report lineages whose
   latest run is currently `running` (and arguably `idle`/mid-pause states
   that represent live, resumable work — decide the exact
   `EXECUTION_STATES` cutoff during implementation, but `completed`/`stopped`/`error`
   are unambiguously excluded). This alone would have cut the live result from
   1,205 to 2.
2. **Keep the existing `workflowKey`/`runRef` narrowing filters** (`parseOtherWorkflowSelector`)
   unchanged — they already let a caller ask about one specific sibling by
   name, which remains useful for the "explicit runRef" case regardless of the
   default-listing fix.
3. **Add a hard result cap as defense in depth** (e.g. a few dozen entries)
   even after the state filter, so a workspace with an unusually large number
   of simultaneously live workflows cannot regress this the same way. Report
   truncation explicitly rather than silently dropping entries.
4. **No scope change.** Do not restrict `global_status` to the caller's own
   execution root or worktree — that would remove the one thing it is for.
   Do not add path/note data to it — that would blur it into the board.

This is a small, independent fix and does not need to wait on the rest of this
plan; it can ship as Stage 0.5 (see below) ahead of the coordination board.

## Schema, settings, and types

- `schemas/settings-schema.json` + `CtrlYokeGlobalSettings.queue`: add
  `coordination` caps (`maxNoteLength`, `maxEntries`, `maxBoardBytes`, `maxEntryAgeDays`)
  next to `maxParallelSteps` (`src/types/CtrlYokeSettings.ts:185`). These are
  now workspace/repository-level concerns (the board spans workflows), so
  consider whether they belong under `queue` (consistent with the previous
  revision) or a new top-level `coordination` settings group parallel to
  `worktrees` — `worktrees` is exactly precedent for "settings that describe a
  cross-workflow, repository-scoped mechanism" and may be the better home.
  Decide during Stage 1. `settingsSchemaUiParity.integration.test.ts` requires
  a settings-UI control for every schema key either way.
- Regenerate `schemas/workflow-schema.yaml` only if the workflow schema
  changes — it should not; this feature adds no authored syntax.
- No change to `ParallelGroupDefinition`, `WorkflowStep`, or step numbering.
- New env var `CTRLYOKE_EXECUTION_ROOT` (Decision 4) needs a constant
  alongside the existing `CTRLYOKE_WORKSPACE`/`CTRLYOKE_WORKING_FILE` names,
  and documentation in `src/mcp-server.ts`'s environment-variable log/comment
  block.

## Implementation stages

**Stage 0 — Identity spike (blocking).** Verify per harness that a stdio MCP
server child inherits the CLI process env, for both group members and
ordinary sequential steps. Result decides whether Decision 4's env path works
everywhere, works for the `--mcp-config` harnesses only, or needs a
per-member/per-step config path. Everything else is wasted if this is wrong.

**Stage 0.5 — `global_status` fix (independent, ship first).** Filter to
non-terminal `executionState`, add the hard result cap, add tests asserting
the filtered/capped shape. No dependency on the rest of this plan.

**Stage 1 — Storage.** Extract `resolveLeaseScope`'s canonical-identity
resolution into a shared helper consumed by both `ExecutionRootLeaseManager`
and the new coordination board; `board.jsonl` path derivation, entry types,
locked append, cursor read, claim fold, retention/compaction (Decision 8).
Pure and unit-testable with no MCP involvement.

**Stage 2 — Identity plumbing.** `CTRLYOKE_EXECUTION_ROOT` into the MCP
`additionalEnv` path (`CliProviderUtils.buildMcpConfigAdditionalEnv`);
`CTRLYOKE_STEP_INDEX` / `CTRLYOKE_STEP_NAME` / `CTRLYOKE_PARALLEL_GROUP_ID` into
`CliExecutionRunner`'s unconditional headless env for every step, sequential or
grouped; MCP server resolves and validates them against the run file.

**Stage 3 — Tools and gating.** Four tool definitions, handlers, per-context
`ListTools` filtering (group and non-group), the generalized `DYNAMIC_QUEUE`
preflight narrowing, `read_output` boundary restriction (group members only),
caps.

**Stage 4 — Prompt preamble.** Steps with coordination tools enabled get a
preamble naming their own run address, describing the coordination protocol,
and — for group members specifically — naming siblings. Without this the
tools will not be used. Belongs with the existing context-assembly path
(`CliPromptPreparer`), not bolted onto the prompt text.

**Stage 5 — UI and release at join.** Same-run timeline rows (Decision 7),
claim release on member/run settlement and at join, contention summary
available to a synthesis step, docs. Cross-workflow board visibility
explicitly deferred per Decision 7 unless Stage 5 usage data says otherwise.

## Edge cases

- **Member or sibling workflow fails or is cancelled mid-claim** — claims
  released at settlement by the group coordinator (group case) or by the
  workflow's own terminal transition (sequential case); readers additionally
  treat a claim whose owner run/step has terminal `_runtime` as released, so a
  crashed agent cannot hold a path forever.
- **`failFast` cancels un-started group members** — no claims exist for them;
  nothing to release.
- **Recovery / resumed run** — the board is append-only and scope-durable, so
  a recovered run re-reads it and sees its own prior entries. Re-claiming a
  path it already owns succeeds (idempotent).
- **`maxParallelSteps: 1`** — groups run sequentially; the board still works
  and becomes a plain handoff log, now potentially interleaved with entries
  from sibling ordinary workflows in the same checkout.
- **Script members / script steps** — no MCP server. They cannot post or
  claim. Document it; do not fake it.
- **Two unrelated workflows in the main checkout, months apart** — both land
  in the same board file by scope identity. This is intended (that is the
  point of the rescoping) but means `read_notes { since }` cursoring and the
  retention policy (Decision 8) need to handle "the entries since my last read
  belong to a workflow I've never heard of" gracefully — surface them with
  full run-address attribution, never assume the reader recognizes the author.
- **Managed worktree directory removed after landing** — the board (under the
  Git common directory) survives exactly like the branch and ownership record
  do; a later run against the same repository can still read prior entries.
- **Non-Git execution root** — falls back to `<executionRoot>/.ctrlyoke/coordination/`,
  same as the lease manager's non-Git fallback; no cross-run durability beyond
  that directory's own lifetime, which is acceptable since there is no
  "common directory" concept to persist it against anyway.
- **Two members/workflows claim overlapping globs** — first append inside the
  lock wins; the second gets `denied` with the owner's full run address.
- **Board grows past cap** — appends fail with a clear message once retention
  compaction (Decision 8) cannot make room without dropping an unresolved
  claim; reads keep working; the run does not fail.

## Not in scope

- **Per-member or per-workflow worktrees as a substitute for coordination.**
  Worktrees stay workflow-level. Real isolation plus auto-merge is the only
  thing that removes file contention outright, and it is a much larger
  feature (merge conflicts, per-member checkouts, N× disk). Coordination is
  complementary to that, not a substitute — if per-member worktrees ever ship,
  the board is still the channel for contracts and findings within whatever
  execution root each member gets.
- **A second shared task list.** ctrlyoke's step queue is the task list.
- **Cross-execution-root (cross-worktree) coordination.** Structurally
  impossible to collide on files, so no board is needed there;
  `global_status` (fixed) is the complete answer for "what's running
  elsewhere in the workspace."
- **Blocking waits / rendezvous / barriers.** See Decision 3.
- **DAG scheduling, `dependsOn`, partial joins.** Explicitly deferred by
  `PARALLEL_STEPS_PLAN.md` and unchanged here.
- **Nested parallel groups.**
- **Enforceable claims** (a pre-edit hook that rejects a write to a path
  another member owns). See Open Question #3.

## Open questions

1. ~~Does every harness's MCP client propagate the parent CLI's env to a
   stdio server?~~ Still open — Stage 0 answers this and may reduce v1 to the
   `--mcp-config` harnesses (Claude, Copilot, Codex).
2. Should a directed note _interrupt_ the recipient, or only be visible on its
   next `read_notes` call? Interrupt requires steering mid-turn
   (see [`STEER_MESSAGE_PLAN.md`](./STEER_MESSAGE_PLAN.md)) and is a much
   bigger change; polling is the v1 assumption, but polling only happens if
   the preamble tells agents to poll.
3. Should claims be enforceable — a pre-edit hook that rejects a write to a
   path another member owns — rather than advisory? Enforcement is far
   stronger and far more disruptive, and it needs per-harness hook support.
   Advisory first; revisit with real usage data.
4. ~~Should the board be exposed to a **sequential** workflow's steps too?~~
   **Resolved: yes** — this revision makes that the default rather than an
   open question, since scoping by execution root makes it free.
5. Does `queue.maxParallelSteps` need a per-group override once members
   actually contend? Out of scope here, but contention data from this feature
   is what would justify it.
6. **New:** should the settings for coordination caps live under `queue` or
   under a new top-level group parallel to `worktrees`? See _Schema,
   settings, and types_ above.
7. **New:** does cross-workflow board visibility in the dashboard (Decision 7)
   justify its own UI surface, or should v1 ship same-run-only and revisit
   once Stage 5 usage data exists for the sequential/cross-workflow case?

## Sources

- [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) — mailbox files, shared task list, file locking on task claims, inter-agent messages treated as untrusted input.
- [The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) — file ownership, peer messaging, worktree isolation, and the failure modes.
- [CodeCRDT: Observation-Driven Coordination for Multi-Agent LLM Code Generation](https://arxiv.org/pdf/2510.18893) — observation-driven alternative to explicit messaging.
- [Beyond Self-Talk: A Communication-Centric Survey of LLM-Based Multi-Agent Systems](https://arxiv.org/pdf/2502.14321) — blackboard architectures and shared-state protocols.
- [Jcode Swarm: many coding agents in one repository](https://jcode.sh/swarm) — shared context and native conflict handling in one repo.
