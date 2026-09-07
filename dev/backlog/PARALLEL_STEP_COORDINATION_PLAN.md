# Parallel Step Coordination Plan

> **Status:** Backlog / design proposal. Nothing here is implemented.
>
> **Depends on:** [`PARALLEL_STEPS_PLAN.md`](../implemented/PARALLEL_STEPS_PLAN.md)
> (shipped). This plan adds a coordination channel _between_ members of one
> `parallel:` group; it does not change fork/join scheduling, topology, or the
> workflow-level worktree model.

## Problem

`parallel:` group members run concurrently in **one execution root**. Worktrees are
a workflow-level property and stay that way, so every member of a group edits the
same checkout at the same time.

That is fine for the shape the feature was designed around — each member writes a
plan to its own file and a later step synthesizes them. It is not fine for what
users will actually author, because we don't control the prompts. Two members told
to "implement the API layer" and "implement the client layer" will both touch shared
types; two members told to refactor "different parts of the codebase" will disagree
about where the boundary is. Today the failure is silent: last writer wins, and
neither agent ever learns the other existed.

Members currently have **no channel of any kind**:

- `global_status` (`src/mcp-server.ts`) is workflow-level, read-only, and answers
  "what other _workflows_ are running" — it cannot see sibling steps at all.
- Prior context and sessions are resolved from a join-boundary snapshot
  (`PARALLEL_STEPS_PLAN.md` Decision 5), so `read_output` deliberately cannot show a
  member what a sibling produced.
- The ctrlyoke MCP server is **hard-blocked inside a group**:
  `ParallelGroupPreflight.ts:234` raises
  `PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.DYNAMIC_QUEUE` for any non-script
  member where `hasCtrlYokeServer(resolvedProperties)` is true, and
  `throwIfParallelGroupPreflightFailed` turns that into a group-level error. A
  member cannot call _any_ ctrlyoke tool.

So the design question is not "which tool do we extend" — it is "what is the right
coordination primitive, and how does it reach a process that currently has no
ctrlyoke tools at all".

## How other systems solve this

Worth stating, because it narrows the design fast. The multi-agent-on-one-repo
products and papers converge on a small set of primitives:

| Primitive                      | Who uses it                                                              | Verdict for ctrlyoke                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Shared task list + deps**    | Claude Code Agent Teams; most orchestrators                              | **Already ours.** The workflow definition _is_ the task list; `append_step`/`edit_step`/`reorder_steps` are its mutation API. Do not rebuild it. |
| **Mailbox / peer messaging**   | Agent Teams (`inboxes/{agent}.json`), cross-session messaging            | **Take it**, but as a filtered read of one board rather than N files.                                                                            |
| **Blackboard / shared board**  | Blackboard architectures; L2MAC; shared-KV "Shared File System Protocol" | **Take it.** One append-only artifact, indirect coordination, no rendezvous.                                                                     |
| **File locking / ownership**   | Agent Teams file locks; per-agent file scope                             | **Take it, advisory and non-blocking** (see Decision 3).                                                                                         |
| **Per-agent worktree + merge** | Agent Teams best practice; manual worktree workflows                     | **Rejected here** — worktrees stay workflow-level (see Not In Scope).                                                                            |
| **Observation-driven / CRDT**  | CodeCRDT and similar research                                            | Too speculative for a first release.                                                                                                             |

The consistent finding across the product write-ups is that **the coordination
primitive is the cheap part; getting agents to use it is the expensive part**. Agent
Teams' own docs still lead with "break the work so each teammate owns a different set
of files" — the locks are a backstop, not the plan. That shapes staging below:
the prompt preamble (Stage 4) matters at least as much as the tools.

## Decisions

### 1. One append-only board per run, not N mailboxes

Storage: `run-<timestamp>/coordination.jsonl` in the run directory, resolved with a
new `WorkflowPaths.coordinationPath()` alongside `eventsPath()`. It sits with
`events.jsonl` and `manifest.json` because it is durable run history: it must survive
the run, be visible in the dashboard afterwards, and be readable by the synthesis
step. It must **not** live under `.ctrlyoke/temp/` — `TempFileManager` deletes those
as soon as the consuming turn ends.

One file, not a mailbox per member, because:

- a directed message is just an entry with a `to` field, so a mailbox is a filtered
  read and needs no second storage mechanism;
- broadcast is the dominant case here (members mostly need to announce, not ask);
- one file means one lock, one cursor model, one UI projection, one size cap;
- ordering across the whole group is well-defined, which per-mailbox files cannot give.

Entry shape (draft — belongs in `src/types/` beside the timeline types):

```typescript
interface CoordinationEntry {
  seq: number; // monotonic within the run
  at: string; // ISO timestamp
  kind: "note" | "claim" | "release";
  /** Author's zero-based workflow step index. Never author-supplied — see Decision 4. */
  fromStep: number;
  fromName?: string;
  parallelGroupId?: string;
  /** note: optional directed recipients, zero-based step indices. Absent = broadcast. */
  to?: number[];
  text?: string; // note
  paths?: string[]; // claim / release, workspace-relative
  reason?: string; // claim
}
```

Appends go through `withFileLock` (`src/utils/FileLockUtils.ts`) on the board path.
`fs.appendFile` is not atomic across processes on Windows, and `RunContinuationService`
already establishes `withFileLock` as the cross-process pattern for run-directory
mutations from the MCP server. `seq` is assigned inside the lock.

Current claim ownership is a **fold over the log**, not stored state — same rule the
parallel plan applied to group status: `ParallelGroupDefinition` holds topology,
never mutable status. A claim is released by an explicit `release` entry, by the
owner's step reaching a terminal `_runtime`, or at the join.

### 2. Four MCP tools

| Tool            | Shape                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `post_note`     | `{ text, to?: number[] }` → `{ seq }`                                                                      |
| `read_notes`    | `{ since?: number, from?: number[] }` → `{ entries, nextCursor }`                                          |
| `claim_paths`   | `{ paths: string[], reason? }` → `{ granted: string[], denied: [{ path, ownerStep, ownerName }], claims }` |
| `release_paths` | `{ paths: string[] }` → `{ released: string[] }`                                                           |

`claim_paths` returns the full current ownership map, so a separate `list_claims`
tool is unnecessary. `paths` are workspace-relative and validated through
`PathSecurity` like every other path input; globs are matched literally against
other claims (overlap detection is string/glob comparison, not filesystem walking —
the point is intent, not enforcement).

These join `MCP_TOOL_DEFINITIONS` and `MCP_WORKFLOW_TOOL_NAMES` in
`src/utils/McpToolDefinitions.ts`, which automatically flows them into the generated
`ctrlyoke-mcp-tools` skill (`McpToolSkillGenerator.MCP_TOOL_SKILL_TOOL_NAMES`) and
into `CommitMessageGenerator`'s `deniedTools` list. Handlers live in
`CtrlYokeMCPServer` and route through `queueOperation()` for the write paths.

### 3. Claims are advisory and never block

`claim_paths` returns immediately. A denied claim reports the owning step so the
agent can post a note to that step, pick different files, or report the contention in
its own output for the synthesis step to resolve.

This is deliberate. A blocking lock inside an agent turn is a deadlock that costs
real money: two members each holding one path and wanting the other's would stall
until the workflow execution timeout. Non-blocking advisory claims cannot deadlock,
and the failure mode (an agent proceeds anyway) is exactly today's behavior — so the
feature is strictly an improvement even when agents ignore it.

A bounded `wait_for_release` is a plausible later addition. It is not in v1.

### 4. Member identity comes from the process environment, not the MCP config

This is the load-bearing constraint, and it is not obvious from reading the code.

A coordination tool must know **which step is calling it**. The natural place would
be the MCP server's `env` block, next to `CTRLYOKE_WORKING_FILE`. That does not work:

- `CliMcpConfigGenerator.getConfigFilePath()` (line 297) derives the config filename
  from the **working file's basename**. Every member of a group shares one working
  file, so every member writes and reads the _same_
  `.ctrlyoke/temp/mcp-config-<harness>-workflow.json`. Today the content is
  identical so the race is benign; the moment the env carries a per-member step
  index, concurrent members overwrite each other's identity.
- Worse for `buildSettingsJsonMcpEntries()` harnesses (Qwen, Antigravity, OpenCode):
  the MCP block lives in a **shared workspace settings file**, ref-counted across
  workflows by `SettingsJsonMcpTracker`. There is exactly one env block for the whole
  workspace. Per-member env is structurally impossible there.

The workable path is the **CLI process environment**, which a stdio MCP server
inherits as a child process. `CliExecutionRunner` already builds an unconditional
`headlessEnv` (`CTRLYOKE_RUN_ID`, `CTRLYOKE_NOTIFY_DIR`, …) around line 349, so
`CTRLYOKE_STEP_INDEX` / `CTRLYOKE_STEP_NAME` / `CTRLYOKE_PARALLEL_GROUP_ID` belong
there. Note that `CTRLYOKE_PROMPT_INDEX` already exists but is **conditional** —
`buildHookEnvVars()` returns `{}` when no notification hook events are enabled — so
it cannot be reused as-is.

Two caveats that Stage 0 exists to settle:

- Env inheritance for stdio MCP servers is **client behavior**, not spec-guaranteed.
  It must be verified per harness, not assumed.
- The interactive/terminal path merges only `buildHookProcessEnv()` (line 482), not
  `headlessEnv`. Parallel groups already refuse interactive multiplexing
  (`PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INTERACTIVE_MULTIPLEX`), so this is
  acceptable for group members, but the gap should be closed or documented.

If a harness turns out not to propagate env, it does not get coordination tools —
surfaced as a new preflight diagnostic rather than as a silent misattribution.
Identity is never taken from a tool argument; that is the same rule
`requireRunAddress()` already applies to run addressing, and for the same reason.

### 5. Split the `DYNAMIC_QUEUE` preflight ban per tool, and filter `ListTools`

The current ban is all-or-nothing. It should become a **tool-availability mode**:

| Tool                                                       | Inside a parallel group                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `post_note`, `read_notes`, `claim_paths`, `release_paths`  | allowed                                                                                                                                                                         |
| `workflow_status`, `capabilities`, `global_status`         | allowed (read-only)                                                                                                                                                             |
| `read_output`                                              | allowed, but restricted to steps before the group's start boundary — matching Decision 5 of the parallel plan, so sibling output stays an explicit note, never an implicit read |
| `append_step`, `edit_step`, `remove_step`, `reorder_steps` | **still refused** — they would race the coordinator's join and topology invariants                                                                                              |

The `DYNAMIC_QUEUE` diagnostic narrows to "this member enables queue-mutating MCP
tools", and members that only want coordination stop failing preflight.

**`ListTools` must be filtered, not just `CallTool` rejected.** `setupHandlers()`
returns `this.getToolDefinitions()` unconditionally today. An agent that sees
`append_step` in a group will call it, burn a turn on the refusal, and often derail.
`getToolDefinitions()` takes the group context and returns the permitted subset.

### 6. Notes are untrusted content

A note is text written by another AI agent. It is data, never instruction, and never
permission. Whether it is injected into a sibling's context or rendered in the
dashboard, it carries explicit attribution and framing ("from step 3, untrusted").
A note must not be able to grant an action a member was otherwise not allowed to
take. This mirrors how Claude Code Agent Teams treats inter-agent messages and how
this repo already treats MCP-read run content.

Caps, enforced at append: max entry text length, max entries per run, max total board
bytes. A chatty agent in a loop must not be able to write an unbounded file into run
history. Over-cap appends fail with a clear message rather than truncating silently.

### 7. Visible in the dashboard

Coordination that the user cannot see is worse than none — a deferred edit looks
identical to a lazy agent. The board is projected into the chronological activity
timeline the parallel plan already built (`OutputPane`, `useOutputRowsModel`,
`outputRows.ts`), as a distinct row kind rendered under the group header.

Read it from `coordination.jsonl` directly rather than adding a
`TIMELINE_EVENT_TYPES` entry: the MCP server writes from a **separate process**, so a
`TimelineRecorder` call is not available to it, and the extension has to watch the
file regardless. `ExternalRunWatchSession` already establishes the watcher shape for
run-directory artifacts. This also avoids a `TIMELINE_SCHEMA_VERSION` bump.

## Schema, settings, and types

- `schemas/settings-schema.json` + `CtrlYokeGlobalSettings.queue`: add
  `coordination` caps (`maxNoteLength`, `maxEntries`) next to `maxParallelSteps`
  (`src/types/CtrlYokeSettings.ts:185`). `settingsSchemaUiParity.integration.test.ts`
  requires a settings-UI control for every schema key.
- Regenerate `schemas/workflow-schema.yaml` only if the workflow schema changes — it
  should not; this feature adds no authored syntax.
- No change to `ParallelGroupDefinition`, `WorkflowStep`, or step numbering.

## Implementation stages

**Stage 0 — Identity spike (blocking).** Verify per harness that a stdio MCP server
child inherits the CLI process env. Result decides whether Decision 4's env path
works everywhere, works for the `--mcp-config` harnesses only, or needs a per-member
config path. Everything else is wasted if this is wrong.

**Stage 1 — Storage.** `WorkflowPaths.coordinationPath()`, entry types, locked
append, cursor read, claim fold. Pure and unit-testable with no MCP involvement.

**Stage 2 — Identity plumbing.** `CTRLYOKE_STEP_INDEX` / `CTRLYOKE_STEP_NAME` /
`CTRLYOKE_PARALLEL_GROUP_ID` into `CliExecutionRunner`'s unconditional headless env;
MCP server resolves and validates them against the run file.

**Stage 3 — Tools and gating.** Four tool definitions, handlers, per-context
`ListTools` filtering, `DYNAMIC_QUEUE` preflight narrowing, `read_output` boundary
restriction, caps.

**Stage 4 — Prompt preamble.** Group members get a preamble naming their step, their
siblings, the shared execution root, and the coordination protocol. Without this the
tools will not be used. Belongs with the existing context-assembly path
(`CliPromptPreparer`), not bolted onto the prompt text.

**Stage 5 — UI and release at join.** Timeline rows, claim release on member
settlement and at join, contention summary available to the synthesis step, docs.

## Edge cases

- **Member fails or is cancelled mid-claim** — claims released at settlement by the
  coordinator; readers additionally treat a claim whose owner has terminal `_runtime`
  as released, so a crashed member cannot hold a path forever.
- **`failFast` cancels un-started members** — no claims exist for them; nothing to
  release.
- **Recovery / resumed run** — the board is append-only and run-scoped, so a recovered
  member re-reads it and sees its own prior entries. Re-claiming a path it already owns
  succeeds (idempotent).
- **`maxParallelSteps: 1`** — groups run sequentially; the board still works and
  becomes a plain handoff log.
- **Script members** — script steps have no MCP server. They cannot post or claim.
  Document it; do not fake it.
- **Reading the board after the join** — the synthesis step is a normal sequential
  step and gets the full board through `read_notes`. This is the intended way for
  contention to reach a human-visible decision.
- **Two members claim overlapping globs** — first append inside the lock wins; the
  second gets `denied` with the owner's step number and name.
- **Board grows past cap mid-run** — appends fail with a clear message; reads keep
  working; the run does not fail.

## Not in scope

- **Per-member worktrees.** Worktrees stay workflow-level. Real isolation plus
  auto-merge is the only thing that removes file contention outright, and it is a much
  larger feature (merge conflicts, per-member checkouts, N× disk). Coordination is
  complementary to that, not a substitute — if per-member worktrees ever ship, the
  board is still the channel for contracts and findings.
- **A second shared task list.** ctrlyoke's step queue is the task list.
- **Cross-workflow coordination.** The board is pinned to one run by
  `CTRLYOKE_WORKING_FILE`, exactly like every other tool. `global_status` remains the
  cross-workflow answer; a workspace-scoped board is a separate proposal.
- **Blocking waits / rendezvous / barriers within a group.** See Decision 3.
- **DAG scheduling, `dependsOn`, partial joins.** Explicitly deferred by the parallel
  plan and unchanged here.
- **Nested groups.**

## Open questions

1. Does every harness's MCP client propagate the parent CLI's env to a stdio server?
   Stage 0 answers this and may reduce v1 to the `--mcp-config` harnesses (Claude,
   Copilot, Codex).
2. Should a directed note _interrupt_ the recipient, or only be visible on its next
   `read_notes` call? Interrupt requires steering mid-turn
   (see [`STEER_MESSAGE_PLAN.md`](./STEER_MESSAGE_PLAN.md)) and is a much bigger
   change; polling is the v1 assumption, but polling only happens if the preamble tells
   agents to poll.
3. Should claims be enforceable — a pre-edit hook that rejects a write to a path
   another member owns — rather than advisory? Enforcement is far stronger and far
   more disruptive, and it needs per-harness hook support. Advisory first; revisit
   with real usage data.
4. Should the board be exposed to a **sequential** workflow's steps too? It costs
   almost nothing (it is run-scoped, not group-scoped) and gives a step a durable
   scratchpad for later steps. Leaning yes, but it widens the surface.
5. Does `queue.maxParallelSteps` need a per-group override once members actually
   contend? Out of scope here, but contention data from this feature is what would
   justify it.

## Sources

- [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) — mailbox files, shared task list, file locking on task claims, inter-agent messages treated as untrusted input.
- [The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) — file ownership, peer messaging, worktree isolation, and the failure modes.
- [CodeCRDT: Observation-Driven Coordination for Multi-Agent LLM Code Generation](https://arxiv.org/pdf/2510.18893) — observation-driven alternative to explicit messaging.
- [Beyond Self-Talk: A Communication-Centric Survey of LLM-Based Multi-Agent Systems](https://arxiv.org/pdf/2502.14321) — blackboard architectures and shared-state protocols.
- [Jcode Swarm: many coding agents in one repository](https://jcode.sh/swarm) — shared context and native conflict handling in one repo.
