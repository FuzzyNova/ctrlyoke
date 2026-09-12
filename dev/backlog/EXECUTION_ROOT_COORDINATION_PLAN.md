# Execution-Root Coordination Plan

> **Status:** Backlog / design proposal. Nothing here is implemented.
>
> **Supersedes:** `PARALLEL_STEP_COORDINATION_PLAN.md`, which scoped a coordination
> board to one workflow run and only made it reachable from inside a `parallel:`
> group.
>
> **Depends on:** [`PARALLEL_STEPS_PLAN.md`](../implemented/PARALLEL_STEPS_PLAN.md)
> (shipped, adds fork/join scheduling and topology — unchanged by this plan),
> [`WORKTREE_SUPPORT_PLAN.md`](../implemented/WORKTREE_SUPPORT_PLAN.md) (shipped,
> defines the execution-workspace model and execution-lease scope identity this
> plan reuses directly), and
> [`MCP_AS_SKILL_PLAN.md`](../implemented/MCP_AS_SKILL_PLAN.md) (shipped, defines
> the `mcpAvailability: "disabled"` mode in which ctrlyoke's MCP tools are
> delivered as a built-in skill instead of a live MCP server — every tool here
> needs a working answer in that mode, see Decision 12).
>
> **Revision history.** 2026-09-10 rescoped the board from one run to one
> execution root and folded in the `global_status` fix. **2026-09-11 (this
> revision) restructures the whole design around a single primitive — the
> _participant_ rather than the _step_ — after an audit showed that the previous
> revision's identity model was both more plumbing than the feature needs and too
> narrow to admit a participant class that genuinely collides on files: an
> external agent session the user is running in the same checkout.**
>
> A code audit later the same day corrected four claims below against the current
> tree: `CTRLYOKE_EXECUTION_ROOT` is required rather than optional (Decision 6),
> step-index plumbing already exists and the stale-index hazard is live today
> (Decision 7), `global_status` currently refuses external callers outright
> (Decision 8), and open questions 5 and 6 are resolved.

## Problem

Agents write to the same files concurrently and have no channel to say so.
Three classes of participant, one problem:

1. **Members of one `parallel:` group.** Worktree is a workflow-level property
   (`WORKTREE_SUPPORT_PLAN.md`), so every member of a group edits the same
   execution root at the same time by construction. Two members told to
   "implement the API layer" and "implement the client layer" will both touch
   shared types; today the failure is silent — last writer wins, and neither
   agent ever learns the other existed.
2. **Separate ordinary workflows sharing the main checkout.** ctrlyoke has
   supported running several non-worktree workflows in parallel for a long time
   (`shared-native` execution leases explicitly allow this). Two such workflows
   editing the same repository have exactly the same silent last-writer-wins
   problem as (1). It predates the parallel-steps feature and nobody framed it as
   the same bug.
3. **An agent session the user is driving directly.** A Claude Code, Copilot, or
   Codex session open in the same checkout while a ctrlyoke workflow runs
   collides exactly as much as (1) or (2) do. ctrlyoke itself is developed this
   way. The previous revision excluded this class by construction, which was a
   mistake: the collision boundary is the filesystem, not ctrlyoke's process
   tree.

These are **the same problem with the same fix**: any two agents that can write
to the same execution root need a channel. The scoping unit is not "run" and not
"workflow" — it is **execution root**, the concept `WORKTREE_SUPPORT_PLAN.md`
already defines precisely for execution leases: the worktree-specific absolute
Git directory when the root is inside a linked worktree, or the canonical
execution-root path otherwise.

Today, coordination options are:

- `global_status` (`src/mcp-server.ts`) is read-only and, per a live audit on
  2026-09-10, actually broken: it returns **every workflow lineage that has ever
  run in the workspace** (1,205 entries in this repository, ~948,000 characters —
  enough to blow past the calling agent's own output limit), filtered by nothing.
  Only 2 of those 1,205 were actually `running`.
- Prior context and sessions are resolved from a join-boundary snapshot
  (`PARALLEL_STEPS_PLAN.md` Decision 5), so `read_output` deliberately cannot show
  a group member what a sibling produced.
- The ctrlyoke MCP server is **hard-blocked inside a group**:
  `ParallelGroupPreflight.ts:234` raises
  `PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.DYNAMIC_QUEUE` for any non-script
  member where `hasCtrlYokeServer(resolvedProperties)` is true — except in
  `mcpAvailability: "disabled"` mode, where the ban silently does not fire at all
  (see Decision 8).
- An external agent session has no ctrlyoke channel of any kind. `requireRunAddress()`
  refuses every tool when no run is attached.

## The design in one move: the primitive is a participant, not a step

Everything below follows from one substitution. The previous revision modelled a
board entry's author as a _ctrlyoke step address_ and derived liveness from that
step's `_runtime`. This revision models it as a **participant holding a lease on
an execution-root scope**. A ctrlyoke step is then just a participant with
richer attestation and a better liveness signal — not a separate code path.

This is a smaller design, not a bigger one, and it fixes three things at once:

- **It matches identity granularity to concurrency granularity.** Identity only
  has to distinguish agents that run _at the same time_. Separate runs always
  can; parallel-group members within a run can; sequential steps within a run
  never can. So run-level identity is sufficient for correctness and
  step-within-run identity is needed only for group members — which collapses
  most of the previous revision's env plumbing into "nice for attribution."
- **It gives liveness one rule instead of two.** A claim is held iff its owner's
  lease is live. Terminal `_runtime` becomes an optimisation that closes an
  attested lease promptly, not the mechanism.
- **It admits external agents without a second design.** They are participants
  with weaker attestation, reaped by the same PID-based stale-owner rule ctrlyoke
  already applies to runner locks and execution leases.

## How other systems solve this

| Primitive                      | Who uses it                                                              | Verdict for ctrlyoke                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Shared task list + deps**    | Claude Code Agent Teams; most orchestrators                              | **Already ours.** The workflow definition _is_ the task list; `append_step`/`edit_step`/`reorder_steps` are its mutation API. Do not rebuild it. |
| **Mailbox / peer messaging**   | Agent Teams (`inboxes/{agent}.json`), cross-session messaging            | **Take it**, but as a filtered read of one board rather than N files.                                                                            |
| **Blackboard / shared board**  | Blackboard architectures; L2MAC; shared-KV "Shared File System Protocol" | **Take it.** One append-only artifact, indirect coordination, no rendezvous.                                                                     |
| **File locking / ownership**   | Agent Teams file locks; per-agent file scope                             | **Take it, advisory and non-blocking** (see Decision 5).                                                                                         |
| **Lease liveness**             | Every distributed lock; ctrlyoke's own execution leases and runner locks | **Reuse ours verbatim** — `isOwnerStale` (PID + heartbeat), not a new TTL. See Decision 2.                                                       |
| **Per-agent worktree + merge** | Agent Teams best practice; manual worktree workflows                     | **Rejected here** — worktrees stay workflow-level (see Not In Scope).                                                                            |
| **Observation-driven / CRDT**  | CodeCRDT and similar research                                            | Too speculative for a first release.                                                                                                             |

The consistent finding across the product write-ups is that **the coordination
primitive is the cheap part; getting agents to use it is the expensive part**.
That is why Decision 11 (visibility) and the prompt preamble matter at least as
much as the tools.

## Decisions

### 1. Participants, attestation, and the address

```typescript
interface CoordinationParticipant {
  /** Server-assigned, stable for the lifetime of the lease. */
  participantId: string;
  kind: "ctrlyoke-step" | "external";
  /**
   * True iff the server derived this identity itself (from its own environment
   * or the run file), rather than accepting it from the caller.
   */
  attested: boolean;
  /** Always present. For external participants, caller-supplied. */
  label: string;
  /** Which delivery path registered this participant — decides its liveness rule. */
  via: "mcp" | "cli";
  /** Present when kind is "ctrlyoke-step". */
  address?: {
    workflowKey: WorkflowKey;
    runRef: RunRef;
    /** Best-effort attribution only — never consulted by the claim fold. */
    stepIndex?: number;
    stepName?: string;
    parallelGroupId?: string;
  };
  /**
   * Liveness, mirroring `ExecutionLease` so `isOwnerStale` applies unchanged.
   * Present when `via` is "mcp" — the stdio server's own process.
   */
  pid?: number;
  lastHeartbeat?: number;
  /** Present only when `via` is "cli", which has no durable process to watch. */
  leaseExpiresAt?: number;
}
```

The liveness fields deliberately mirror `ExecutionLease`
(`ExecutionRootLeaseManager.ts:20-33`) field-for-field so the shared stale-owner
predicate applies with no adapter — see Decision 2.

**`stepIndex` is optional, and that is load-bearing.** Correctness — claim
ownership, reaping, denial — keys on the participant lease, which is run-level.
The step index is attribution: it makes timeline rows and notes readable, and
nothing else depends on it. So it is populated where it is stable and omitted
where it would be stale, and no code path may treat its absence as an error.

**Attestation is an accuracy signal, not a security boundary.** State this
plainly wherever it is surfaced. An agent that can call these tools can also run
a shell, and an agent that can run a shell can append to the board file directly
or edit the files a claim was meant to protect. Refusing caller-supplied identity
would not prevent impersonation; it would only prevent honest use by participants
ctrlyoke did not launch. What attestation buys is that the common case is correct
without the agent having to self-report accurately — and that the dashboard can
say which entries came with provenance.

This also resolves an inconsistency in the previous revision, which justified
mandatory env-derived identity by analogy to `requireRunAddress()`.
**`requireRunAddress()` is correct for tools that act on a run and irrelevant for
tools that act on a scope.** Its actual purpose is blast radius: the queue tools
mutate one specific workflow's execution, so accepting a run address from
arguments would let an agent append steps to somebody else's workflow. Appending
a note to a shared board is not that. Run-addressed tools keep requiring a run
address; board tools never needed one.

### 2. Liveness reuses the existing stale-owner rule — PID first, TTL only as a backstop

One rule: **a claim is held iff its owner's lease is live.** "Live" is not a new
concept: ctrlyoke already has exactly one staleness model, shared by runner locks
and execution leases, and this must not introduce a second.

```typescript
// src/utils/LockSafetyPrimitives.ts
isOwnerStale(pid, lastHeartbeat) =
  !isProcessAlive(pid) || isHeartbeatStale(lastHeartbeat);
// HEARTBEAT_INTERVAL_MS = 5_000, STALE_HEARTBEAT_MS = 30_000
```

`ExecutionRootLeaseManager.isProcessAlive` exists specifically to "expose the
process check without creating another staleness model" (`:446-449`). Take that
at its word — a participant record carries `pid` and `lastHeartbeat` and is
reaped by `isOwnerStale`, exactly like an `ExecutionLease`.

This works better than a pure TTL because the process whose liveness we care
about is one we can observe: the **stdio MCP server** registered the participant
and lives exactly as long as the agent session that owns it.

| Participant                    | Primary signal                                                  | Backstop                         |
| ------------------------------ | --------------------------------------------------------------- | -------------------------------- |
| `ctrlyoke-step`, MCP-delivered | orchestrator closes the lease at step settlement / at the join  | `isOwnerStale` on the server PID |
| `external`, MCP-delivered      | server PID — dies with the agent session                        | heartbeat staleness              |
| either, skill/CLI-delivered    | **no durable process** — each call is a fresh `node` invocation | TTL (below) is the only signal   |

The PID path reaps a crashed agent in milliseconds rather than after a timeout,
and — more importantly — it never reaps a participant that is alive but quiet,
which is the failure mode a bare TTL gets wrong. An agent that claims a path and
then thinks for twenty minutes keeps its claim, because its process is still
there.

**The TTL therefore only governs skill/CLI-delivered participants**, which have no
observable process. Because it covers a narrow case and claims are advisory
anyway, the exact value is low-stakes. Recommended: **30 minutes**, refreshed by
any board call. It must comfortably exceed a plausible silent working period —
`STALE_HEARTBEAT_MS` (30s) is far too short here, since a CLI-mode participant has
no daemon to heartbeat and only refreshes when the agent happens to call a tool.

Current ownership is a **fold over the append-only log**, not stored mutable
state — the same rule `ParallelGroupDefinition` follows for topology: never store
mutable status next to durable identity. A claim is released by an explicit
`release` entry, by its participant's lease closing, or by staleness.

Because claims are advisory and non-blocking (Decision 5), a wrong liveness
answer degrades to exactly today's behaviour. That is the argument against any
more elaborate protocol.

### 3. One append-only board per execution root

Storage root: reuse the exact identity `ExecutionRootLeaseManager`'s (currently
private) `resolveLeaseScope(executionRoot)` already computes for execution leases
(`src/core/orchestration/ExecutionRootLeaseManager.ts:177`) — extract it into a
shared helper (e.g. `src/core/orchestration/ExecutionRootScope.ts`) consumed by
both, rather than duplicating the git-common-dir resolution and non-Git fallback:

```text
<git-common-dir>/ctrlyoke/coordination/<scope-hash>/board.jsonl        (Git roots)
<executionRoot>/.ctrlyoke/coordination/board.jsonl                     (non-Git fallback)
```

This sits next to `<git-common-dir>/ctrlyoke/execution-leases/<scope-hash>/` by
design: both are keyed by the same canonical identity, both need the same "does
this scope record match, or is this a collision" guard (`verifyScopeRecord`'s
pattern at `:229`), and a caller resolving "who else is here and what have they
said" wants one lookup, not two independently-derived paths that could drift.

A managed worktree's directory is removed at the end of a run but its Git
**common directory** is not, so the board survives worktree removal exactly like
a managed branch does and remains inspectable by later runs against the same
repository.

One file, not a mailbox per participant and not a file per run, because:

- a directed message is just an entry with a `to` field, so a mailbox is a
  filtered read and needs no second storage mechanism;
- broadcast is the dominant case (participants mostly announce, not ask);
- one file means one lock, one cursor model, one size cap;
- ordering across every agent that can actually collide is well-defined, which
  per-mailbox or per-run files cannot give once the "who" spans workflows and
  external sessions.

```typescript
interface CoordinationEntry {
  seq: number; // monotonic within the execution-root scope
  at: string; // ISO timestamp
  kind: "note" | "claim" | "release" | "join" | "leave";
  /** Author. Never accepted from the caller for attested participants. */
  from: {
    participantId: string;
    /** Denormalised so a reader never has to resolve a departed participant. */
    label: string;
    attested: boolean;
    address?: CoordinationParticipant["address"];
  };
  /** note: optional directed recipients, by participantId. Absent = broadcast. */
  to?: string[];
  text?: string; // note
  paths?: string[]; // claim / release, execution-root-relative
  reason?: string; // claim
  /** Which delivery path wrote this — live MCP server or the skill's CLI entry. */
  via: "mcp" | "cli";
}
```

`from` is denormalised deliberately: a reader must be able to attribute an entry
whose participant lease has long since expired and been compacted away.

Appends go through `withFileLock` (`src/utils/FileLockUtils.ts`) on the board
path, exactly as `RunContinuationService` already establishes for run-directory
mutations from the MCP server; `seq` is assigned inside the lock. Nothing here
assumes a long-lived server process, which is what lets the skill-mode CLI path
(Decision 12) use the identical storage with no variant.

**Decision 3 implementation (2026-09-11):** `resolveExecutionRootScope` and
`scopeStorageRoot` in `src/core/orchestration/ExecutionRootScope.ts` are the
shared identity/path helpers; `verifyScopeRecord` in that module owns the
scope-record guard. `ExecutionRootLeaseManager` consumes those helpers, and
`ExecutionRootCoordinationStore` in
`src/core/orchestration/ExecutionRootCoordinationStore.ts` owns board resolution,
append, and paged reads (`appendCoordinationEntry` and
`readCoordinationEntries` are its stateless convenience functions). The shared
contracts are `CoordinationParticipant` and `CoordinationEntry` in
`src/types/CtrlYokeTypes.ts`.

**Decisions 1 and 2 implementation (2026-09-11):**
`CoordinationParticipantRegistry` and `foldCoordinationEntries` in
`src/core/orchestration/ExecutionRootCoordination.ts` own participant leases,
join/leave/heartbeat entries, advisory claims, and the liveness-aware ownership
fold. `COORDINATION_CLI_LEASE_TTL_MS` is the 30-minute CLI backstop. The store's
`CoordinationBoardTransaction`/`transaction` API keeps fold-and-append claim
decisions under the board lock.

### 4. Four tools, each returning the scope snapshot

| Tool            | Shape                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| `post_note`     | `{ text, to?: string[] }` → `{ seq, scope }`                                             |
| `read_notes`    | `{ since?: number, from?: string[] }` → `{ entries, nextCursor, scope }`                 |
| `claim_paths`   | `{ paths: string[], reason? }` → `{ granted, denied: [{ path, owner }], claims, scope }` |
| `release_paths` | `{ paths?: string[] }` — omitted means "all mine" → `{ released, scope }`                |

Every response carries a compact `scope` snapshot — the live participants and a
claim summary. That is deliberate: it makes orientation free after any call,
removes the need for a separate "who else is here" tool that agents would forget
to call, and means an agent always acts on fresh state. Full claim maps come back
from the claim tools; the note tools carry participants plus counts.

`paths` are execution-root-relative and validated through `PathSecurity` like
every other path input. Globs are matched literally against other claims (overlap
detection is string/glob comparison, not filesystem walking — the point is
intent, not enforcement).

`release_paths` with no arguments releasing everything the caller holds is the
common case at a step boundary and should be the documented default.

These join `MCP_TOOL_DEFINITIONS` in `src/utils/McpToolDefinitions.ts`. Handlers
live in `CtrlYokeMCPServer` and route through `queueOperation()` for the write
paths, same as every other mutating tool.

Adding them, however, exposes a conflation in `MCP_WORKFLOW_TOOL_NAMES` that has
to be fixed first rather than worked around. That one hand-maintained list does
two unrelated jobs:

- it is the tool subset the built-in `ctrlyoke-mcp-tools` skill documents
  (`McpToolSkillGenerator.MCP_TOOL_SKILL_TOOL_NAMES` is literally
  `= MCP_WORKFLOW_TOOL_NAMES`, `McpToolSkillGenerator.ts:88-89`), and
- it is the deny-list `CommitMessageGenerator` hands the commit-message run
  (`deniedTools: [...MCP_WORKFLOW_TOOL_NAMES]`, `CommitMessageGenerator.ts:347`).

Those jobs disagree the moment a tool exists that belongs in neither the queue
skill nor a commit-message run — which is exactly what the coordination tools
are. The list currently holds 8 of the 9 tool-name constants: every tool except
`submit_commit_message`. So its second consumer does not want "workflow tools" at
all, it wants _"everything except the commit tool"_, and it happens to be correct
only because those two sets coincide today.

Keeping a third parallel list and remembering to union it at the deny site would
re-arm the same trap for the tenth tool. Since nothing is released, fix the
structure instead:

- **Derive the commit-run deny-list by exclusion** — every name in
  `MCP_TOOL_DEFINITIONS` except `MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME`. The intent
  is an allow-list of one; it is expressed as a denial only because
  `McpServerConfig` offers `deniedTools` and no `allowedTools`
  (`src/types/CtrlYokeTypes.ts:104-110`), matching what harnesses accept as deny
  patterns. Derived, it stays correct for every tool added later without anyone
  remembering anything.
- **Rename the remaining list `MCP_QUEUE_TOOL_NAMES`** so it has exactly one job:
  what the queue skill documents. Its current name invites precisely the
  "everything workflow-ish" reading that caused the overload.
- **Drop `MCP_TOOL_SKILL_TOOL_NAMES`**, which is now a pure alias of that list;
  the generator can consume it directly.
- Then add `MCP_COORDINATION_TOOL_NAMES` for the new tools, with no union
  bookkeeping anywhere.

The live consequence of _not_ doing this: follow the instruction to keep
coordination tools out of `MCP_WORKFLOW_TOOL_NAMES`, forget the deny-site union,
and a commit-message run silently gains the ability to post to the board.

### 5. Claims are advisory and never block

`claim_paths` returns immediately. A denied claim reports the owning participant
so the agent can post a directed note, pick different files, or report the
contention in its own output for a human or a synthesis step to resolve.

A blocking lock inside an agent turn is a deadlock that costs real money: two
agents each holding one path and wanting the other's would stall until the
workflow execution timeout. Non-blocking advisory claims cannot deadlock, and the
failure mode (an agent proceeds anyway) is exactly today's behaviour — so the
feature is strictly an improvement even when agents ignore it.

A bounded `wait_for_release` is a plausible later addition. It is not in v1.

### 6. Scope resolution needs no configuration, for either participant kind

- **Attested (`ctrlyoke-step`).** Derived by the server. `CTRLYOKE_WORKING_FILE`
  is already set for every run and yields `workflowKey`/`runRef` via
  `WorkflowPaths.parseWorkingFileAddressFromPath`.

  **`CTRLYOKE_EXECUTION_ROOT` is required, not an optimisation.** An earlier
  revision said the server could fall back to "the workspace root it already
  holds". It cannot: `this.workspaceRoot` comes from `CTRLYOKE_WORKSPACE`, which
  `CliMcpConfigGenerator.buildCtrlyokeStdioServerEntry` sets to
  `stateRoot ?? workspaceRoot` — the **state** root, which in the default user
  mode is `<ctrlyokeStateHome>/projects/<slug>-<hash12>` and has nothing to do
  with the checkout being edited. Using it as the execution root would put the
  board in the wrong scope for every user-mode run. Resolve in this order:
  `CTRLYOKE_EXECUTION_ROOT` → the run file's
  `WorkingFileWorktreeRuntime.executionRoot` (worktree runs) → `process.cwd()`.
  The env var is added in exactly one place, now that the single env-block
  builder has landed.

- **External.** `process.cwd()` of the stdio server the external harness spawned,
  resolved to its Git common directory by the same shared helper.

So an external agent lands in the correct scope by adding the ctrlyoke MCP server
to its own config and nothing else — no paths, no tokens, no workflow. That
zero-configuration property is most of why supporting external participants is
cheap, and it should be protected in review.

### 7. What identity plumbing is actually required

Far less than the previous revision assumed, because of Decision 1's granularity
rule. Ordered by necessity:

| Value                    | Needed for                                                                         | Source                                                      |
| ------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `workflowKey` / `runRef` | participant identity; letting the orchestrator close the right lease at settlement | **already free** — `CTRLYOKE_WORKING_FILE`                  |
| execution root           | scope selection                                                                    | `CTRLYOKE_EXECUTION_ROOT`, **required** (Decision 6)        |
| `stepIndex` / `stepName` | attribution only                                                                   | **already free** — `CTRLYOKE_PROMPT_INDEX` / `_PROMPT_NAME` |
| `parallelGroupId`        | releasing member claims at the join                                                | the only genuinely new variable; group members only         |

Only one new variable is needed. An earlier revision assumed step identity had to
be added; it is already there. `CliExecutionRunner.buildHookEnvVars()` sets
`CTRLYOKE_PROMPT_INDEX` and `CTRLYOKE_PROMPT_NAME` from the execution context, and
both spawn paths already spread it — `headlessEnv` for headless runs and
`terminalEnv` for the interactive PTY. So step-level attribution costs nothing but
reading two variables the runner already exports, and the new plumbing reduces to
`CTRLYOKE_PARALLEL_GROUP_ID` for **parallel-group members** — the one participant
class where two agents share a run and therefore cannot be told apart by run
address alone.

**That discovery makes the stale-index hazard below a live bug rather than a
hypothetical.** `CTRLYOKE_PROMPT_INDEX` is _already_ frozen at the spawning step's
value on every inject path, so a server that naively trusted it today would
misattribute board entries from the first prompt injected into a reused PTY. The
mitigation is not optional hardening; it is a precondition for reading the
variable at all.

Identity travels on the **CLI process environment**, which the stdio MCP server
inherits as a child process. Two properties of that channel matter:

- **Per-harness MCP config shape is irrelevant to it.** The concern that a
  workspace-global, ref-counted `settings.json` MCP block (Qwen, Antigravity,
  OpenCode) versus a per-workflow `--mcp-config` file (Claude, Copilot, Codex)
  would force different designs applies only to the config `env` block — a file
  two concurrent steps can overwrite. The process environment is never serialised,
  so there is nothing for a sibling to clobber, and every harness is spawned
  through the same `CliTransportCoordinator` seam.
- **Env inheritance is client behaviour, not spec-guaranteed.** An MCP client may
  launch a stdio server with a sanitised environment — `PATH`/`HOME` plus the
  config's own `env` — which is a defensible default rather than a bug. Verify it
  per harness. A harness that sanitises loses _step-level attribution for group
  members only_; it keeps the board, because run-level identity still arrives via
  `CTRLYOKE_WORKING_FILE` in the config `env` block. That is a far softer failure
  than the previous revision's "no coordination tools for that harness."

**Never read a stale step index.** `CTRLYOKE_PROMPT_INDEX` and
`CTRLYOKE_PARALLEL_GROUP_ID` are trustworthy only on spawn-per-step
paths. An injected follow-up prompt reuses an already-running PTY
(`CliExecutionRunner.ts:105-110`), so its env is frozen at the spawning step's
values; such a prompt must carry run-level identity with no step index rather than
the wrong one. This costs nothing — injected prompts are sequential, and
sequential steps never needed step identity for correctness.

**The server detects this itself; no new spawn-time flag is needed.** It already
reads the run file to resolve the address, and that file's
`_runtime.currentIndex` is authoritative. Accept `CTRLYOKE_PROMPT_INDEX` only when
it agrees with `currentIndex`, and drop it to `undefined` otherwise. A frozen
index from an earlier step disagrees and is discarded; a group member disagrees
too (the run's `currentIndex` is the group's start index), which is precisely why
group members need the explicit `CTRLYOKE_PARALLEL_GROUP_ID` and carry their own
index alongside it. Since `stepIndex` is attribution-only (Decision 1), dropping
it is always safe.

The one case where that is not enough is a parallel-group member that would
inject into a PTY left behind by an earlier sequential step (legal: preflight
refuses interactive members only when `interactiveIndices.length > 1 && !supportsConcurrentInteractiveSessions`,
`ParallelGroupPreflight.ts:267`). A group member does need its step index. Handle
it with the mechanism ctrlyoke already has for spawn-time changes: add a clause to
`getInjectIncompatibilityReason()` (`src/core/harness/CliIntegration.ts:597-646`)
so the prompt is inject-incompatible and the existing path retires the PTY and
respawns with `--resume` (`CliIntegration.ts:1134-1139`). The conversation
continues; only the process is new. Note the clause is a presence test, not a
`prev`/`curr` comparison like its neighbours — two coordination-enabled steps have
identical `ResolvedProperties` and would compare equal while still needing
different identities.

Finally, a naming hazard worth settling in the same commit: `CTRLYOKE_WORKSPACE`
(state root, MCP config `env`), `CTRLYOKE_WORKSPACE_ROOT` (also the state root,
hook env, `CliExecutionRunner.ts:524-527`), and any new `CTRLYOKE_EXECUTION_ROOT`
are three similar names for two different roots. Document them together in
`src/mcp-server.ts`'s environment-variable comment block.

### 8. Tool availability: two server modes, filtered `ListTools`

The server's mode is decided by whether ctrlyoke launched it, which is exactly
the question `requireRunAddress()` already answers.

| Tool                                                       | Attested, ordinary step | Attested, group member                     | External |
| ---------------------------------------------------------- | ----------------------- | ------------------------------------------ | -------- |
| `post_note`, `read_notes`, `claim_paths`, `release_paths`  | yes                     | yes                                        | yes      |
| `global_status`                                            | yes                     | yes                                        | yes      |
| `workflow_status`, `capabilities`                          | yes                     | yes                                        | no       |
| `read_output`                                              | yes                     | yes, bounded by the group's start boundary | no       |
| `append_step`, `edit_step`, `remove_step`, `reorder_steps` | yes                     | **no** — they race the coordinator's join  | no       |

`read_output`'s boundary restriction for group members matches Decision 5 of
`PARALLEL_STEPS_PLAN.md`, so sibling output stays an explicit note and never an
implicit read.

**`ListTools` must be filtered, not just `CallTool` rejected.** `setupHandlers()`
returns `this.getToolDefinitions()` unconditionally today. An agent that sees
`append_step` in a group will call it, burn a turn on the refusal, and often
derail. `getToolDefinitions()` takes the calling context and returns the permitted
subset.

**Live hole to close as a prerequisite: the group ban does not fire at all when
MCP is disabled.** The preflight check is
`!isScriptStep(step) && hasCtrlYokeServer(resolvedProperties)`
(`src/core/ParallelGroupPreflight.ts:234`), and `hasCtrlYokeServer` returns `false`
whenever `mcpAvailability === "disabled"` (`CliProviderUtils.ts:52-56`) — correct
in itself, since no MCP server is attached in that mode. But the MCP-as-skill work
then attaches `ctrlyoke-mcp-tools` **unconditionally**
(`ExecutionPropertyResolver.ts:272-276` appends it whenever `mcpAvailability` is
disabled, without checking whether the step asked for the ctrlyoke server at all).
So today, with MCP disabled, every parallel-group member silently receives a
document explaining how to call `append_step`/`edit_step`/`reorder_steps` through
`node out/mcp-server.js --tool …`, and preflight raises nothing. Two fixes:

1. **Gate the skill swap on the same condition as the server** — only where
   `hasCtrlYokeServer` would have been true before the disable. Ungated attachment
   also wastes prompt budget on every step that never wanted queue tools.
2. **Make the ban mode-independent** — check "does this member end up with
   queue-mutating tools by _any_ delivery mechanism". The shared
   `hasCtrlYokeQueueTools` predicate next to `hasCtrlYokeServer` keeps the
   preflight, the `ListTools` filter, and the skill selector from drifting apart.

### 9. Notes are untrusted content, and attestation is part of the framing

A note is text written by another AI agent — possibly a different workflow,
possibly a session belonging to a different user. It is data, never instruction,
and never permission. Whether injected into another participant's context or
rendered in the dashboard, it carries explicit attribution _and its attestation
state_: "from `<label>` (unattested external session), untrusted". A note must
never grant an action the reader was otherwise not allowed to take.

External participants raise the stakes rather than changing the rule: their label
is self-chosen, so a note claiming to be "from the orchestrator" is exactly the
prompt-injection shape this framing exists to defuse. Render the attestation flag
everywhere the label appears; never let a label alone imply authority.

### 10. Retention: caps plus fold-based compaction

An execution-root board is not bounded by a run's lifetime — the main checkout's
board accumulates across months of unrelated workflows and external sessions.

**The binding constraint is the reader's context window, not disk.** Board
content is read into an agent's prompt, and `global_status` has already
demonstrated this exact failure at scale: 948,000 characters returned in one call,
exceeding the calling agent's own output limit before anything could be read. Size
the caps from "what can an agent consume in one call", not from storage.

That makes the response cap the primary protection and the storage caps hygiene:

| Cap                    | Recommended | Why                                                                                                                               |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `read_notes` page      | 50 entries  | Always paged with `nextCursor`, never unbounded. This is the cap that actually prevents the `global_status` failure.              |
| `maxNoteLength`        | 2,000 chars | Enough for a paragraph plus a path list; small enough that a full page costs roughly 25K characters rather than an entire window. |
| `maxEntries` per scope | 1,000       | Post-compaction. At realistic entry sizes this is well under a megabyte.                                                          |
| `maxBoardBytes`        | 5 MB        | Hard ceiling, hygiene only — compaction should keep the file far below it.                                                        |
| `maxEntryAgeDays`      | 7           | A coordination note older than a week has no value; claims are reaped by liveness long before this matters.                       |

Compact by folding: settled `claim`/`release` pairs cancel out and a long prefix
of them can be replaced with nothing, and only then are remaining notes trimmed.
**Trimming must never drop a `claim` whose release has not been folded**, or the
ownership fold would silently un-deny a held path. Over-cap appends fail with a
clear message rather than truncating silently; reads keep working and the run does
not fail. Readers must tolerate gaps in `seq`, since compaction is not contiguous.

**Evict by largest contributor, not strictly oldest.** External participants get
the same per-entry caps as ctrlyoke steps — a separate, stricter budget would be
arbitrary, and an unattended ctrlyoke workflow in a retry loop is just as capable
of flooding the board as an external agent. The real risk is not that a chatty
participant evicts itself (harmless, self-correcting) but that it evicts everyone
else's notes. Trimming the largest contributor first makes the board
self-balancing under contention and removes any need to special-case participant
kind. This is the only place the design treats a scope as a shared budget, and it
is why external participants can be admitted by default without a separate quota.

### 11. Visibility: a scope-level surface is required, not deferred

Coordination the user cannot see is worse than none — a deferred edit looks
identical to a lazy agent.

Two surfaces, and the second is no longer optional:

- **Same-run timeline rows.** For entries authored by the currently open run,
  project the board into the chronological activity timeline the parallel plan
  already built (`OutputPane`, `useOutputRowsModel`, `outputRows.ts`) as a distinct
  row kind, under the group header or inline for a sequential step.
- **An execution-root activity panel.** Live participants plus recent entries for
  the scope. The previous revision deferred this; the participant model makes it
  mandatory, because an external participant has no run timeline to appear in and
  would otherwise be invisible while holding claims against the user's own files.

Read the board file directly rather than adding a `TIMELINE_EVENT_TYPES` entry:
the writer is a separate process, so a `TimelineRecorder` call is unavailable to
it and the extension has to watch the file regardless. `ExternalRunWatchSession`
already establishes the watcher shape for run-directory artifacts; watching an
execution-root-scoped path is the same mechanism pointed at a longer-lived file.
This also avoids a `TIMELINE_SCHEMA_VERSION` bump.

### 12. Skill-mode parity: a third built-in skill

With `mcpAvailability: "disabled"` no MCP server is attached and a built-in skill
teaches the agent to shell out to `node "<mcp-server.js>" --tool <name> …`,
dispatching through the same `invokeTool` (`src/mcp-server.ts:1292-1315`).
Enterprise deployments that block MCP by policy run entirely in that mode, so the
coordination tools need an answer there or they do not exist for those users.

**Add a third built-in skill, `ctrlyoke-coordination-tools`
(`MCP_SKILL_NAMES.COORDINATION`), scoped to the four tools.** Do not extend
`ctrlyoke-mcp-tools`. The deciding argument: **in skill mode the set of attached
skills _is_ the tool listing.** Decision 8 turns on filtering `ListTools` so a
group member never sees `append_step`; skill mode has no `ListTools`, so the same
gating can only be expressed by attaching a different document. A combined skill
makes the group-member case inexpressible. Supporting reasons: it mirrors the
existing `ctrlyoke-commit-message-tool` split, the two skills have different
attachment conditions, and coordination's prose carries protocol guidance that
should not land on every step that merely wanted `append_step`.

The participant model keeps this cheap. Scope comes from `process.cwd()` and
run-level identity from the `--working-file` flag the CLI entry already accepts,
so **no new identity flags are needed for the sequential case** — only group
members need `--step-index`/`--parallel-group-id`. Entries written this way are
stamped `via: "cli"`.

The two prerequisite fixes below are correctness improvements independent of
the coordination feature:

- **Generated skills emit placeholders, not values** — landed 2026-09-11.
  `McpToolSkillGenerator` now accepts the shared optional
  `McpToolSkillRunContext`; execution passes the MCP server path, state root,
  working-file path, and commit-output path where applicable, so the two
  existing built-in skills contain usable literal CLI arguments.
- **Export stays placeholder-form** — also landed 2026-09-11. The export call
  intentionally passes no run context, because Phase 5 of
  `MCP_AS_SKILL_PLAN.md` creates a click-time snapshot and a live run address
  would be stale immediately (and its flags would hard-error against
  `parseMcpToolCliArgs`, which rejects unknown options).

Skill-mode callers are unattested even when ctrlyoke launched the step, since the
address arrives as argv. Validate it — reject an address that does not resolve to
a live step of a real run in this scope — but treat that as drift protection, not
security, per Decision 1. Note also that every skill-mode call is a fresh process
paying Node startup plus `initializeMcpStorage`, so the prose must direct agents
to read at step boundaries rather than poll in a loop.

## `global_status`: fix, keep, and clearly separate from the board

An audit on 2026-09-10 confirmed `global_status` returns every lineage that has
ever run, not what is currently running: `handleGlobalStatus()` calls
`lineageRepository.listLineageKeys()`, a `readdir` over the entire `.runs/` tree
with no execution-state filter (`WorkflowLineageRepository.ts:494`), then reports
each lineage's `latestRunRef` state — which answers "how did this lineage's last
run end", not "is anything happening now."

| State       | Count |
| ----------- | ----- |
| completed   | 1,139 |
| stopped     | 34    |
| idle        | 25    |
| error       | 5     |
| **running** | **2** |

**Keep it, keep it workspace-wide (cross-worktree), and filter it to live
executions.** It is a different question from the board and must not merge into
one:

- The board answers "who shares my execution root and can literally collide with
  my writes" — necessarily one scope, because a path claim only means something
  against files you can both reach.
- `global_status` answers "what else is happening anywhere in this workspace,
  including other worktrees" — a coarser read-only radar. It stays useful
  _because_ worktrees isolate filesystems but not everything else: two workflows
  in different worktrees still contend on a dev server, a port, an external
  service, or CI, and "workflow X is also running, that's probably it" is real
  diagnostic value.

Fix: filter to non-terminal `executionState` (which alone would have cut 1,205 to
2); keep the existing `workflowKey`/`runRef` narrowing filters
(`parseOtherWorkflowSelector`); add a hard result cap as defence in depth,
reporting truncation explicitly; change no scope and add no path/note data, which
would blur it into the board. Share the run-address type with the board so the two
read consistently.

**Also drop its `requireRunAddress` gate.** `handleGlobalStatus` opens with
`this.requireRunAddress(MCP_GLOBAL_STATUS_TOOL_NAME)` and therefore refuses every
external caller today, which contradicts Decision 8's table. The gate is
vestigial here: the tool reads nothing run-scoped — it scans the lineage
repository under `this.workspaceRoot` — so per Decision 1 it is a scope tool, not
a run-addressed one, and the blast-radius argument that justifies the gate on the
queue tools does not apply. Keep the gate on `workflow_status`, `read_output`, and
every queue tool, which genuinely act on one run.

## Schema, settings, and types

- New top-level `coordination` settings group in `schemas/settings-schema.json` +
  `src/types/CtrlYokeSettings.ts`, parallel to `worktrees` rather than nested under
  `queue`. `worktrees` is exactly the precedent for "settings describing a
  cross-workflow, repository-scoped mechanism", and the board now spans workflows
  _and_ external sessions, which `queue` does not describe at all. Keys: the
  retention caps and page size (Decision 10), the CLI-participant TTL (Decision 2),
  and whether external participants are admitted at all.
  `settingsSchemaUiParity.integration.test.ts` requires a settings-UI control per
  schema key. Note what does **not** belong here: the PID/heartbeat staleness
  thresholds stay in `LockSafetyPrimitives`, shared with runner locks and execution
  leases. Making them configurable per-scope would fork the one staleness model the
  codebase deliberately single-sources.
- `MCP_SKILL_NAMES` (`src/types/DashboardConstants.ts:3686-3689`) gains
  `COORDINATION: "ctrlyoke-coordination-tools"`. The existing comment already warns
  these names are workflow-referenced and must stay stable.
- `src/utils/McpToolDefinitions.ts`: **the Decision 4 structural fix landed** —
  the queue skill/UI list is now `MCP_QUEUE_TOOL_NAMES`, coordination has an
  empty reserved `MCP_COORDINATION_TOOL_NAMES` list, and
  `MCP_COMMIT_MESSAGE_DENIED_TOOL_NAMES` derives every definition except the
  commit tool for `CommitMessageGenerator`'s `deniedTools`. The
  `MCP_TOOL_SKILL_TOOL_NAMES` alias was removed, and coverage now asserts that
  the derived deny-list plus the commit tool exactly covers
  `MCP_TOOL_DEFINITIONS`. The coordination skill and its generator branch remain
  future work for the coordination-tool implementation.
- New bundled `src/templates/skills/ctrlyoke-coordination-tools/SKILL.md`.
  `esbuild.js`'s `copy-templates` plugin already globs the directory.
- `parseMcpToolCliArgs` gains `--step-index` / `--parallel-group-id` (and
  optionally `--execution-root`). Since it rejects unknown options outright, the
  accepted flag set is effectively public API for exported snapshots — pin it with
  a test.
- No change to `ParallelGroupDefinition`, `WorkflowStep`, or step numbering. No
  authored workflow syntax, so `schemas/workflow-schema.yaml` does not regenerate.

## Prerequisite fixes

[`MCP_SURFACE_CLEANUP_PLAN.md`](../implemented/MCP_SURFACE_CLEANUP_PLAN.md) covers the rest of
the prerequisite work — the `capabilities` → `list_harnesses` rename plus eight
structural fixes to the existing MCP surface. Two of those matter directly to this
plan: schema-driven argument validation (so the four new tools cannot drift from
their advertised shape) and extracting the single MCP env-block builder (so
Decision 7's `CTRLYOKE_EXECUTION_ROOT` is added once rather than in three places,
where missing one would silently misattribute board entries for one harness
family). **Both have landed** — that plan is fully implemented and now lives in
`dev/implemented/`, so this prerequisite is satisfied.

The three below are specific to this plan's own subject matter, and each is a
correctness fix on its own:

1. **The disabled-mode preflight hole** (Decision 8) — landed 2026-09-11. A
   shared `hasCtrlYokeQueueTools` predicate now gates the skill replacement and
   applies the group ban regardless of whether queue tools arrive through MCP
   or the built-in skill.
2. **Placeholder substitution in generated skills** (Decision 12) — landed
   2026-09-11. Execution-time expansion substitutes the run's literal paths and
   export-time snapshots retain placeholders.
3. **`global_status` filtering and capping** — landed 2026-09-11. It now uses
   `ACTIVE_EXECUTION_STATES`, caps responses at 100 workflows, reports
   truncation explicitly, and works for callers without an attached run.
4. **Decision 4 MCP tool-list separation** — landed 2026-09-11. Queue-tool
   membership is separate from the derived commit-run denial list, with an
   empty coordination-tool list reserved for the later tool definitions.

No decisions in this plan were changed. The implementation keeps the existing
workspace-wide, cross-worktree scope and leaves path and note data to the
coordination board.

## Edge cases

- **Participant crashes mid-claim** — its PID is gone, so `isOwnerStale` reports
  it dead on the next read and its claims fold as released, with no timeout to
  wait out. For attested participants the orchestrator closes the lease at
  settlement anyway, so this is strictly the crash path.
- **Participant alive but silent for a long turn** — keeps its claims, because the
  process is still there. This is the case a bare TTL gets wrong and the reason
  Decision 2 leads with PID liveness.
- **`failFast` cancels un-started group members** — no claims exist for them.
- **Recovered / resumed run** — the board is append-only and scope-durable, so a
  recovered run re-reads it and sees its own prior entries. Re-claiming a path it
  already owns succeeds (idempotent).
- **`maxParallelSteps: 1`** — groups run sequentially; the board still works as a
  handoff log, interleaved with sibling and external entries.
- **Script steps** — no MCP server and no skill; they cannot post or claim.
  Document it, do not fake it.
- **Injected interactive prompt** — carries run-level identity with no step index
  (Decision 7). Coordination works; only attribution granularity is lost.
- **Group member that would be injected** — inject-incompatible, so it respawns
  with `--resume` (Decision 7).
- **Two participants claim overlapping globs** — first append inside the lock
  wins; the second is denied with the owner's label and attestation state.
- **External agent in a checkout with no ctrlyoke run** — the board still exists
  and still works; the scope simply has one participant. This is the "I'm about to
  start a workflow, is anything else in here" case.
- **External agent in a non-Git directory** — falls back to
  `<executionRoot>/.ctrlyoke/coordination/`, same as the lease manager's non-Git
  fallback.
- **Managed worktree removed after landing** — the board survives under the Git
  common directory exactly as the branch does.
- **Two unrelated workflows months apart** — both land in the same board by scope
  identity. Intended, but `read_notes { since }` and retention must handle "these
  entries belong to a workflow I've never heard of" gracefully: always surface full
  attribution, never assume the reader recognises the author.
- **Board over cap** — appends fail clearly once compaction cannot make room
  without dropping an unresolved claim; reads keep working; the run does not fail.

## Not in scope

- **Per-member or per-workflow worktrees as a substitute for coordination.**
  Worktrees stay workflow-level. Real isolation plus auto-merge is the only thing
  that removes contention outright and is a much larger feature; coordination is
  complementary, not a substitute.
- **A second shared task list.** ctrlyoke's step queue is the task list.
- **Cross-execution-root coordination.** Structurally impossible to collide on
  files; fixed `global_status` is the complete answer for "what's running
  elsewhere."
- **Blocking waits / rendezvous / barriers.** See Decision 5.
- **Enforceable claims** (a pre-edit hook rejecting a write to another's path).
  See Open Question 4.
- **DAG scheduling, `dependsOn`, partial joins, nested groups.** Unchanged from
  `PARALLEL_STEPS_PLAN.md`.
- **Authenticating external participants.** Attestation is an accuracy signal, not
  a security boundary (Decision 1). Anyone who can write the checkout can write the
  board.

## Open questions

1. ~~What lease TTL?~~ **Resolved (Decision 2):** reuse `isOwnerStale` — PID
   liveness plus the shared 30s heartbeat — for every MCP-delivered participant,
   and apply a 30-minute TTL only to skill/CLI-delivered participants, which have
   no observable process. No new staleness model.
2. ~~What caps, and do external participants get the same ones?~~ **Resolved
   (Decision 10):** size from the reader's context window, page `read_notes` at 50
   entries, cap notes at 2,000 characters, and evict by largest contributor so the
   same caps can apply to every participant kind.
3. Should a directed note _interrupt_ the recipient, or only appear on its next
   `read_notes`? Interrupt requires mid-turn steering (see
   [`STEER_MESSAGE_PLAN.md`](./STEER_MESSAGE_PLAN.md)) and is a much bigger change.
   Polling is the v1 assumption — but polling only happens if the preamble says to
   poll, and skill mode makes each poll a process spawn.
4. Should claims ever be enforceable — a pre-edit hook rejecting a write to another
   participant's path? Far stronger, far more disruptive, and needs per-harness hook
   support. Advisory first; revisit with usage data.
5. ~~Should external participants be admitted by default?~~ **Resolved: yes.**
   `coordination.allowExternalParticipants` defaults `true`. The conservative
   reading — "a process ctrlyoke did not launch can write a file under `.git/`" —
   does not survive Decision 1: any process that can reach the execution root can
   already write the board file, the claimed files, and `.git/` itself, so
   defaulting off buys no safety and costs the zero-configuration property that is
   most of why external participants are cheap to support. The setting exists so a
   user who wants ctrlyoke-only coordination can have it, not as a default posture.
6. ~~Authorable `coordination: true|false`, or implied by `mcpServers:
["ctrlyoke"]`?~~ **Resolved: implied.** No new workflow-schema surface. The
   case that motivated an explicit flag — wanting coordination without queue
   mutation — is the parallel-group case, and Decision 8 already answers it by
   filtering `ListTools` rather than by authoring. Outside a group the gap is
   theoretical and no usage data justifies the surface yet; revisit if it appears.
7. Does `queue.maxParallelSteps` need a per-group override once members actually
   contend? Out of scope here; contention data from this feature is what would
   justify it.

## Sources

- [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) — mailbox files, shared task list, file locking on task claims, inter-agent messages treated as untrusted input.
- [The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) — file ownership, peer messaging, worktree isolation, and the failure modes.
- [CodeCRDT: Observation-Driven Coordination for Multi-Agent LLM Code Generation](https://arxiv.org/pdf/2510.18893) — observation-driven alternative to explicit messaging.
- [Beyond Self-Talk: A Communication-Centric Survey of LLM-Based Multi-Agent Systems](https://arxiv.org/pdf/2502.14321) — blackboard architectures and shared-state protocols.
- [Jcode Swarm: many coding agents in one repository](https://jcode.sh/swarm) — shared context and native conflict handling in one repo.
