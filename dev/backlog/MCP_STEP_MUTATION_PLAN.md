# MCP/CLI Step Mutation Plan

**Status:** Proposed
**Priority:** P2

Grew out of a discussion of [`MCP_OUTPUT_PAGING_PLAN.md`](MCP_OUTPUT_PAGING_PLAN.md) and the
rejected [`MCP_CONTROL_SURFACE_PLAN.md`](../rejected/MCP_CONTROL_SURFACE_PLAN.md). Like the paging
plan, this is a read/write-path fill-in on tools that already exist, not a lifecycle-control
surface — it does not touch the standing constraint in
`.github/instructions/extension.instructions.md` (no MCP tool targets a workflow other than its own
run; no tool starts/pauses/cancels).

Also covers renaming all of ctrlyoke's MCP tools (see "Naming" below) — bundled here because
pre-release is the right time to do it, and because the new tools this plan adds should ship with
their final names rather than launching and immediately being renamed.

## Problem

A workflow step can only *append* to its own run's queue (`ctrlyoke_append_queue`). It cannot edit,
remove, or reorder a step that has already been queued but hasn't run yet. In practice this comes up
constantly in long orchestrator-driven runs (e.g.
[`spec-driven-loop.ctrlyoke.yaml`](../../src/templates/workflows/spec-driven-loop.ctrlyoke.yaml)):
the orchestrator queues a plan, then later wants to insert a correction step, drop a step that
turned out to be unnecessary, or reorder the remaining work — and today the only tool available is
"add more steps at the end (or next)."

Separately, driving ctrlyoke from *outside* a workflow (the CLI, used by an external automation
agent) can start a run, resume it, or append to it (`ctrlyoke run`, `ctrlyoke run --run <ref>`,
`ctrlyoke run --run <ref> --append`), but has no way to edit, remove, or reorder a run's pending
steps from outside. An agent supervising a long run has no way to insert a fix without waiting for
the run to reach a point where it can append.

## What already exists

The underlying primitive is already built, already cross-process safe, and already in production —
it's just never been wired up to MCP or the CLI. It currently serves only the dashboard's own step
editor.

- `WorkingFileManager` (`src/core/WorkingFileManager.ts`) has the full addressed CRUD set for a
  run's step list: `insertStepAtRun` (`:1263`), `updateStepAtRun` (`:1331`), `deleteStepAtRun`
  (`:1450`), `reorderStepsAtRun` (`:1503`) — each addressed by `(workspaceFolderPath, workflowKey,
  runRef, ..., expectedDefinitionRevision)`, lock-safe via the same `mutateRunDefinition` helper
  `appendStepsToRun`-style writes already use.
- `WorkflowOrchestrator.prepareDefinitionMutation` (`:3564-3616`) already branches on run ownership:
  a **resident** run (this process holds the lineage lock / is executing it) is edited in-place
  against the live in-memory queue; a **non-resident** run (idle, or owned by a different process —
  the code's own comment names this case explicitly: *"reaching here with the lock on this run means
  a non-resident (e.g. CLI) owner"*, `RunContinuationService.ts:123`) goes through
  `RunContinuationService.validateContinuationTarget(..., "edit")`.
- That `"edit"` action is deliberately more permissive than `"append"`/`"continue"`: it's allowed on
  an idle run even while a *different* run in the same lineage is executing, and is blocked only
  when the lock names *this exact* run and isn't held by the calling process
  (`RunContinuationService.ts:114-134`).
- `PromptQueue.assertEditableDuringExecution` (`:2443-2461`) — the same boundary
  `immutablePrefixLength` (`RunContinuationService.ts:314-322`) mirrors for the cross-process path —
  only blocks two things: a step with `completedAt` already set, and the one step currently in
  flight. **Everything from `currentIndex + 1` onward is editable while the workflow keeps running**,
  because the write goes through the same file lock the executor uses to advance.

The consequence worth stating plainly: **editing the pending suffix of a run never requires pausing
it.** A non-resident (CLI) caller can safely mutate future steps of an actively-executing run today,
in the dashboard, without touching its execution state at all. This plan reuses that same guarantee
for MCP and CLI callers instead of introducing anything new.

## Scope

### MCP — same-run only, unchanged trust boundary

Add three tools alongside `ctrlyoke_append_queue`, all scoped through the existing
`resolveRun()`/`requireRunAddress()` path (`src/mcp-server.ts`) — no new addressing, no change to
what a workflow step can reach. This is the same trust class `ctrlyoke_append_queue` already has
today; it only fills out the missing CRUD verbs.

- **Edit a step's prompt/config** — wraps `WorkingFileManager.updateStepAtRun`.
- **Remove a step** — wraps `WorkingFileManager.deleteStepAtRun`.
- **Reorder pending steps** — wraps `WorkingFileManager.reorderStepsAtRun`.
- Consider exposing `insertStepAtRun`'s arbitrary-index insert directly rather than only through
  `ctrlyoke_append_queue`'s coarser `next`/`end` position enum, now that precise addressing is
  already needed for edit/remove.

All three reject an index outside the pending region (`< currentIndex` or the in-flight step),
mirroring `assertEditableDuringExecution` — this is enforcement `WorkingFileManager`'s primitives
already carry, not new logic to write.

### CLI — named-run, external caller

`cli.ts`'s `CLI_RUN_OPERATION_KINDS` (`:144-149`) currently has `run`, `rerun`, `append`, `continue`
only — no edit/remove/reorder, even though `validateCliContinuationTarget` (`cli.ts:1389-1408`)
already plumbs into the same `RunContinuationService`, just with action `"continue"` instead of
`"edit"`.

Add `ctrlyoke queue edit|remove|reorder --run <ref> ...` subcommands that validate with
`action: "edit"` and call the same `WorkingFileManager` primitives above. This is the direct answer
to "an external agent should be able to correct a run it started without waiting for a natural
append point" — and it requires no MCP change, no loosening of the auto-approval boundary, and no
new security surface: it's a normal CLI invocation, gated by whatever permission model the calling
agent's own harness already enforces on shell commands.

## Naming — drop the redundant `ctrlyoke_` prefix, and `queue` → `step`/`steps`

Pre-release, no users, no back-compat constraint — this is the time to fix this, and doing it
alongside the new tools below means the new tools ship with their final names directly instead of
needing a second rename later.

**Why the prefix is redundant.** Every MCP client namespaces tool calls as `mcp__<server>__<tool>`
— that's the server boundary, not the tool name. Other MCP servers don't self-prefix: playwright's
tools are `browser_click`, `browser_navigate`, not `playwright_browser_click`; cclsp's are
`find_definition`, not `cclsp_find_definition`. ctrlyoke's own tools being named `ctrlyoke_append_queue`
means the fully-qualified call is `mcp__ctrlyoke__ctrlyoke_append_queue` — doubled for no reason.

**Why it's safe to change now.** Verified across all 6 harness providers
(`src/core/harness/{claude,copilot,codex,antigravity,qwen,opencode}/*ToolPermissionMapper.ts`,
`IToolPermissionMapper.ts`, `CliMcpConfigGenerator.ts`): none of them reference individual ctrlyoke
tool names. Every one operates on generic patterns (`shell(git:*)`, `tools: ["*"]`) or the fixed
**server** key `"ctrlyoke"` — never a tool name. `ClaudeCliProvider.ts:310`'s
`--allowed-tools mcp__ctrlyoke` is a server-level wildcard, unaffected by what the tools inside are
called. A rename touches zero permission/auto-approval logic on any harness.

**Collision risk is a non-issue.** Since names are namespaced per-server at the client
(`mcp__<server>__<tool>`), a generic name like `append_step` cannot collide with another attached
MCP server's tool of the same name — the server prefix already disambiguates them structurally.

### Proposed names

| Current                          | Proposed               |
| --------------------------------- | ----------------------- |
| `ctrlyoke_queue_status`           | `workflow_status`       |
| `ctrlyoke_append_queue`           | `append_step`           |
| `ctrlyoke_capabilities`           | `capabilities`          |
| `ctrlyoke_read_output`            | `read_output`           |
| `ctrlyoke_global_status`          | `global_status`         |
| `ctrlyoke_submit_commit_message`  | `submit_commit_message` |
| *(new, this plan)* edit           | `edit_step`             |
| *(new, this plan)* remove         | `remove_step`           |
| *(new, this plan)* reorder        | `reorder_steps`         |

Consider folding arbitrary-index insert into `append_step` (accept a numeric index alongside
`'next'`/`'end'` in its `position` field) rather than adding a fifth new tool — `insertStepAtRun`
already supports it, so this is a schema addition, not new logic.

`workflow_status` over `step_status`: the old name's "queue" never specifically meant *the step
queue* as opposed to *the workflow* — `ctrlyoke_append_queue` already used "queue" loosely to mean
"the workflow," and this tool reports the whole workflow's state (harness, model, execution state,
every step), not just a step-level view. "Workflow" is the accurate noun here; the new edit/remove
tools below are what "step" actually refers to.

### Single-source every tool name as a constant

Today only 2 of the 6 names have an exported constant (`MCP_COMMIT_MESSAGE_TOOL_NAME`,
`MCP_APPEND_QUEUE_TOOL_NAME`); the other 4 are bare string literals inline in
`MCP_TOOL_DEFINITIONS`, and the audit below found 3 more files that hold their own independent
literal copies rather than importing anything. Fix both as one piece of this change:

- Export one named constant per tool in `McpToolDefinitions.ts` — the 6 renamed existing tools plus
  the 3 new ones this plan adds (`edit_step`, `remove_step`, `reorder_steps`) — and have every
  `name:` field in `MCP_TOOL_DEFINITIONS` reference its constant instead of a bare literal, matching
  the pattern `MCP_APPEND_QUEUE_TOOL_NAME` already established.
- Update the 3 duplicate-literal files found in the blast-radius audit
  (`CommitMessageGenerator.ts:345-349`, `McpRegistryFileManager.ts:255`,
  `McpServersEditor.tsx:36-56`) to import these constants instead of holding their own copies. This
  is what actually closes the drift risk the audit flagged — renaming the strings without also
  fixing these three would just relocate the duplication under new names.
- `MCP_QUEUE_TOOL_NAMES` should be rebuilt from the same constants (and likely renamed itself, since
  "queue" is going away as a concept here too — e.g. `MCP_WORKFLOW_TOOL_NAMES`).

### Blast radius (audited)

`src/utils/McpToolDefinitions.ts` (`MCP_COMMIT_MESSAGE_TOOL_NAME`, `MCP_APPEND_QUEUE_TOOL_NAME`,
`MCP_QUEUE_TOOL_NAMES`, and the inline `name:` literals) is the single source of truth and should be
edited first.

- **Duplicate literal arrays that will silently drift if missed** (these do not import the source of
  truth — real risk, independent of the rename):
  - `src/git/CommitMessageGenerator.ts:345-349` — own literal array of all 5 queue-tool names.
  - `src/utils/McpRegistryFileManager.ts:255` — own literal 2-name array.
  - `src/ui/webview-react/components/shared/McpServersEditor.tsx:36-56` — own literal `id:` list;
    plausibly legitimate as a separate copy since `McpToolDefinitions.ts` is Node-only and not meant
    for the webview bundle, but still needs manual updating on rename.
- **Doc-comment/example references only** (cosmetic, low-risk, still worth fixing for accuracy):
  `CodexToolBuilder.ts:214,294`; `schemas/workflow-schema.json:1487` /
  `schemas/workflow-schema.yaml:1380` (the `mcpServers[].deniedTools` field description uses
  `"ctrlyoke_append_queue"` as an example string); `src/types/CtrlYokeTypes.ts:106,790`.
- **Hand-written docs needing manual update:** `docs/reference/mcp-tools.md`, `README.md:12,190`.
- **Auto-generated, no action needed:** `McpToolSkillGenerator` reads `MCP_TOOL_DEFINITIONS` at
  runtime and regenerates its skill text from the source of truth.
- **Functional prose the AI reads — must update or shipped agents call tools that no longer exist:**
  `src/templates/workflows/spec-driven-loop.ctrlyoke.yaml` (lines 23, 34, 53, 64),
  `.ctrlyoke/templates/yoke-driven-loop.ctrlyoke.yaml` (33, 60 — a separate template, not a copy),
  `src/templates/agents/spec-orchestrator.agent.md` (3, 13, 16, 25, 43, 49),
  `src/templates/agents/ctrlyoke-workflow-composer.agent.md` (81).
- **Tests to update:** `McpServer.test.ts`, `McpToolSkillGenerator.test.ts`, `SkillDiscovery.test.ts`,
  `HarnessFileManager.test.ts`, `mcp.harness.test.ts`, `inline-config.harness.test.ts`,
  `CliEventMapper.test.ts` (asserts the literal split of `mcp__ctrlyoke__ctrlyoke_append_queue`),
  `LogParsers.test.ts`.
- **Do not touch:** `dev/implemented/*.md`, `dev/rejected/*.md` — historical record, confirmed not
  imported or parsed by any code.

## Non-goals

- No pause/resume/cancel. Editing the pending suffix of a run was never gated on pausing it (see
  "What already exists" above) — there is no reason to solve that separate, harder problem
  (signaling a live foreground CLI process cross-process) to close this gap.
- No cross-workflow or cross-run addressing for MCP tools. The CLI subcommands are addressed by
  `--run <ref>` the same way `ctrlyoke run --run <ref> --append` already is today; MCP tools remain
  pinned to `CTRLYOKE_WORKING_FILE` exactly as they are now.
- No change to the standing MCP constraint recorded in
  `.github/instructions/extension.instructions.md`.

## Acceptance criteria

- A workflow step can edit, remove, or reorder any not-yet-executed step in its own run via MCP.
- An external caller can edit, remove, or reorder any not-yet-executed step of a named run via the
  CLI, including while that run is actively executing (as long as the target step is not the one in
  flight).
- Neither surface can touch a completed step or the step currently in flight — enforced by the
  existing `WorkingFileManager` primitives, not reimplemented.
- No new lifecycle control (start/pause/cancel) is introduced on either surface.
- All 6 existing MCP tools are renamed per the table above, every reference site in the audited
  blast radius is updated, and no harness's auto-approval/permission behavior regresses.
