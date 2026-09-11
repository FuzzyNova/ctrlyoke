# MCP/CLI Step Mutation Plan

**Status:** Corrections 1–5 addressed 2026-09-05; MCP and CLI scopes implemented 2026-09-05
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

A workflow step can only _append_ to its own run's queue (`append_step`). It cannot edit,
remove, or reorder a step that has already been queued but hasn't run yet. In practice this comes up
constantly in long orchestrator-driven runs (e.g.
[`spec-driven-loop.ctrlyoke.yaml`](../../src/templates/workflows/spec-driven-loop.ctrlyoke.yaml)):
the orchestrator queues a plan, then later wants to insert a correction step, drop a step that
turned out to be unnecessary, or reorder the remaining work — and today the only tool available is
"add more steps at the end (or next)."

Separately, driving ctrlyoke from _outside_ a workflow (the CLI, used by an external automation
agent) can start a run, resume it, or append to it (`ctrlyoke run`, `ctrlyoke run --run <ref>`,
`ctrlyoke run --run <ref> --append`), but has no way to edit, remove, or reorder a run's pending
steps from outside. An agent supervising a long run has no way to insert a fix without waiting for
the run to reach a point where it can append.

## What already exists

The dashboard's underlying primitives are already built and cross-process safe, but they are not the
Node-only entry point needed by MCP or the CLI. The shared Node-only continuation layer now provides
the addressed edit/remove/reorder/insert transactions those later surfaces will consume.

- `WorkingFileManager` (`src/core/WorkingFileManager.ts`) has the full addressed CRUD set for a
  run's step list: `insertStepAtRun` (`:1263`), `updateStepAtRun` (`:1331`), `deleteStepAtRun`
  (`:1450`), `reorderStepsAtRun` (`:1503`) — each addressed by `(workspaceFolderPath, workflowKey,
runRef, ..., expectedDefinitionRevision)`, lock-safe via the same `mutateRunDefinition` helper
  `appendStepsToRun`-style writes already use.
- `WorkflowOrchestrator.prepareDefinitionMutation` (`:3564-3616`) already branches on run ownership:
  a **resident** run (this process holds the lineage lock / is executing it) is edited in-place
  against the live in-memory queue; a **non-resident** run (idle, or owned by a different process —
  the code's own comment names this case explicitly: _"reaching here with the lock on this run means
  a non-resident (e.g. CLI) owner"_, `RunContinuationService.ts:123`) goes through
  `RunContinuationService.validateContinuationTarget(..., "edit")`.
  **`WorkflowOrchestrator` imports `vscode`, so neither `mcp-server.ts` nor `cli.ts` can reuse this
  branching — see "Corrections" below.**
- That `"edit"` action is deliberately more permissive than `"append"`/`"continue"`: it's allowed on
  an idle run even while a _different_ run in the same lineage is executing, and is blocked only
  when the lock names _this exact_ run and isn't held by the calling process
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

**Implemented 2026-09-05.** The MCP surface now supports editing, removing, and
reordering pending steps, plus arbitrary-index insertion through `append_step`.
The CLI surface below remains proposed.

Add three tools alongside `append_step`, all scoped through the existing
`resolveRun()`/`requireRunAddress()` path (`src/mcp-server.ts`) — no new addressing, no change to
what a workflow step can reach. This is the same trust class `append_step` already has
today; it only fills out the missing CRUD verbs.

- **Edit a step's prompt/config** — wraps `WorkingFileManager.updateStepAtRun`.
- **Remove a step** — wraps `WorkingFileManager.deleteStepAtRun`.
- **Reorder pending steps** — wraps `WorkingFileManager.reorderStepsAtRun`.
- Consider exposing `insertStepAtRun`'s arbitrary-index insert directly rather than only through
  `append_step`'s coarser `next`/`end` position enum, now that precise addressing is
  already needed for edit/remove.

All three must reject an index outside the pending region (`< currentIndex` or the in-flight step),
mirroring `assertEditableDuringExecution`. The shared Node-only continuation layer enforces this
boundary — see Corrections 1 and 2.

### CLI — named-run, external caller

**Implemented 2026-09-05.**

`cli.ts` has no step-mutation surface today: `validateCliContinuationTarget` (`cli.ts:1389-1408`)
already plumbs into the same `RunContinuationService`, but only with action `"continue"`.

Add `ctrlyoke step edit|remove|reorder --run <ref> ...` subcommands that validate with
`action: "edit"` and call the shared mutation primitives above. **These are non-executing commands
and must not be added to `CLI_RUN_OPERATION_KINDS` — see Correction 4.** This is the direct answer
to "an external agent should be able to correct a run it started without waiting for a natural
append point" — and it requires no MCP change, no loosening of the auto-approval boundary, and no
new security surface: it's a normal CLI invocation, gated by whatever permission model the calling
agent's own harness already enforces on shell commands.

## Naming — drop the redundant `ctrlyoke_` prefix, and `queue` → `step`/`steps`

**Status:** Implemented 2026-09-05

Pre-release, no users, no back-compat constraint — this is the time to fix this, and doing it
alongside the new tools below means the new tools ship with their final names directly instead of
needing a second rename later.

**Why the prefix is redundant.** Every MCP client namespaces tool calls as `mcp__<server>__<tool>`
— that's the server boundary, not the tool name. Other MCP servers don't self-prefix: playwright's
tools are `browser_click`, `browser_navigate`, not `playwright_browser_click`; cclsp's are
`find_definition`, not `cclsp_find_definition`. ctrlyoke's own tools being named `append_step`
means the fully-qualified call is `mcp__ctrlyoke__append_step` — doubled for no reason.

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

### Final names

| Tool purpose                | Implemented name                         |
| --------------------------- | ---------------------------------------- |
| Workflow status             | `workflow_status`                        |
| Append a step               | `append_step`                            |
| Capabilities                | `capabilities`                           |
| Read output                 | `read_output`                            |
| Global status               | `global_status`                          |
| Submit commit message       | `submit_commit_message`                  |
| Edit a step's prompt/config | `edit_step` — implemented 2026-09-05     |
| Remove a pending step       | `remove_step` — implemented 2026-09-05   |
| Reorder pending steps       | `reorder_steps` — implemented 2026-09-05 |

Consider folding arbitrary-index insert into `append_step` (accept a numeric index alongside
`'next'`/`'end'` in its `position` field) rather than adding a fifth new tool — `insertStepAtRun`
already supports it, so this is a schema addition, not new logic.

`workflow_status` over `step_status`: this tool reports the whole workflow's state (harness, model,
execution state, every step), not just a step-level view. "Workflow" is the accurate noun here; the
new edit/remove tools below are what "step" actually refers to.

### Single-source every tool name as a constant

All 6 existing names now have an exported constant in `McpToolDefinitions.ts`, and the audit below
found 3 more files that held their own independent literal copies rather than importing anything.
Fixing both closes the drift risk:

- Export one named constant per existing tool in `McpToolDefinitions.ts` and have every `name:` field
  in `MCP_TOOL_DEFINITIONS` reference its constant instead of a bare literal. The three new tool
  constants (`edit_step`, `remove_step`, `reorder_steps`) belong to the later mutation step.
- Update the 3 duplicate-literal files found in the blast-radius audit
  (`CommitMessageGenerator.ts:345-349`, `McpRegistryFileManager.ts:255`,
  `McpServersEditor.tsx:36-56`) to import these constants instead of holding their own copies. This
  is what actually closes the drift risk the audit flagged — renaming the strings without also
  fixing these three would just relocate the duplication under new names.
- `MCP_WORKFLOW_TOOL_NAMES` is rebuilt from the same five workflow-tool constants; the commit-message
  tool remains in its separate skill subset.

### Blast radius (audited)

`src/utils/McpToolDefinitions.ts` (the six exported tool-name constants, `MCP_WORKFLOW_TOOL_NAMES`,
and the `name:` fields) is the single source of truth and should be edited first.

- **Duplicate literal arrays that will silently drift if missed** (these do not import the source of
  truth — real risk, independent of the rename):
  - `src/git/CommitMessageGenerator.ts:345-349` — own literal array of all 5 queue-tool names.
  - `src/utils/McpRegistryFileManager.ts:255` — own literal 2-name array.
  - `src/ui/webview-react/components/shared/McpServersEditor.tsx:36-56` — own literal `id:` list;
    it now imports the shared constants because `McpToolDefinitions.ts` is safe for the webview bundle.
- **Doc-comment/example references only** (cosmetic, low-risk, still worth fixing for accuracy):
  `CodexToolBuilder.ts:214,294`; `schemas/workflow-schema.json:1487` /
  `schemas/workflow-schema.yaml:1380` (the `mcpServers[].deniedTools` field description uses
  `"append_step"` as an example string); `src/types/CtrlYokeTypes.ts:106,790`.
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
  `CliEventMapper.test.ts` (asserts the literal split of `mcp__ctrlyoke__append_step`),
  `LogParsers.test.ts`.
- **Additional live reference sites the original audit missed** (verified 2026-09-05 by grepping all
  six current tool names across the repo — 185 occurrences in 47 files):
  - `.github/instructions/extension.instructions.md` (3) and `.github/instructions/git.instructions.md`
    (1) — instruction files are functional prose agents read; a stale tool name here misleads
    every future session.
  - `manual-test/dynamic-queue-basic-example.ctrlyoke.json` (2),
    `manual-test/final-step-mcp-test.ctrlyoke.json` (1), `manual-test/README.md` (2) — live
    fixtures whose prompts instruct the model to call the tool by name. They break silently.
  - `dev/active/DOCUMENTATION_STRATEGY_PLAN.md` (1), `dev/backlog/MCP_RUN_PATH_FIELDS_PLAN.md` (6),
    `dev/backlog/COMMIT_MESSAGE_GENERATION_VISIBILITY_PLAN.md` (1) — unlike `dev/implemented/` and
    `dev/rejected/`, `dev/active/` and `dev/backlog/` describe work that is still going to happen,
    so they must be updated or they will hand the next agent dead names.
  - This plan and `MCP_OUTPUT_PAGING_PLAN.md` themselves.
- **Do not touch:** `dev/implemented/*.md`, `dev/rejected/*.md` — historical record, confirmed not
  imported or parsed by any code.

## Corrections (orchestration review, 2026-09-05)

Five defects found while validating this plan against the code. Each was confirmed by reading the
cited source; the Scope sections above have been amended to match.

### 1. ✅ Addressed — the pending-region guard is load-bearing

The plan asserted the boundary check was "enforcement `WorkingFileManager`'s primitives already
carry." It was not. `updateStepAtRun` (`:1352`), `deleteStepAtRun` (`:1473`) and `insertStepAtRun`
(`:1285`) still validate their own dashboard inputs against the array length, while the new
`RunContinuationService` transactions also consult `_runtime.completedAt` and
`_runtime.currentIndex` before writing an executing run.

The two real guards live elsewhere and neither covers this path:

- `PromptQueue.assertEditableDuringExecution` (`:2443`) is **private** and called only from
  `PromptQueue`'s own in-memory mutators (`:1657`, `:2053`, `:2101`, `:2139`). It never runs for an
  addressed cross-process write.
- `immutablePrefixLength` (`RunContinuationService.ts:314`) is exported but has exactly two callers:
  `appendStepsToRun` (`:254`, as a **clamp**, not a rejection) and `PromptQueue.mergeDiskSteps`
  (`:1391-1392`).

Today nothing reaches these primitives except `WorkflowOrchestrator`'s dashboard handlers
(`:4121`, `:4188`, `:4233`, `:4296`, `:4325`), which are gated upstream by the dashboard's own UI
rules and, for a resident run, by `PromptQueue`. Opening the same primitives to MCP and the CLI
removes that gating.

This matters more than a normal input-validation gap, because `PromptQueue.mergeDiskSteps`'s
correctness argument depends on it. Its comment (`:1394-1402`) states plainly that completed steps
and the running step are index-stable _because_ "`RunContinuationService` clamps every cross-process
splice past the completed boundary, and the positions MCP can request resolve to either `next` ... or
`end`. Nothing can renumber the running step." A `remove_step` or arbitrary-index insert that lands
before the execution head falsifies that premise directly: the merge would reattach the running
step's `_runtime` (session ID, `startedAt`) and its `results` entry to a _different_ step, and
`manifest.json`/`events.jsonl` — which address recorded attempts by array index — would
re-attribute recorded output. Corrupt run history, not just a rejected call.

**Fix landed:** the shared Node-only mutation transactions enforce the boundary, rejecting rather
than clamping, with tests that assert a completed-step and an in-flight-step target both throw.

### 2. ✅ Addressed — add the Node-only wrapper for edit/remove/reorder

`WorkflowOrchestrator` imports `vscode`, so `prepareDefinitionMutation`'s resident/non-resident
branching is unreachable from `mcp-server.ts` (which `extension.instructions.md` forbids from
importing `vscode`) and from `cli.ts`. `handleAppendQueue` does not call it either — it calls
`RunContinuationService.appendStepsToRun` (`mcp-server.ts:456`), a Node-only method that does its own
descriptor lock → run-file lock → revision check → boundary-aware atomic write, entirely
independent of `WorkingFileManager.mutateRunDefinition`.

The missing equivalent was **added as sibling methods to `RunContinuationService`**, mirroring
`appendStepsToRun`: `editStepAtRun`, `removeStepAtRun`, `reorderPendingStepsAtRun`, and the explicit
`insertStepAtRun` transaction. Both MCP and the CLI will consume those, and the boundary rule from
Correction 1 is written once, in one place.

### 3. ✅ Addressed — `validateContinuationTarget(..., "edit")` permits the intended caller

The EDIT bypass at `RunContinuationService.ts:114-134` skips the "another run is executing" error
only when `action === EDIT && !lockNamesTarget`. An MCP tool edits **its own** run, so
`lockNamesTarget` is `true` and the call throws. `handleAppendQueue` escapes this by passing
`allowActiveTargetAppend: true` (`mcp-server.ts:378-385`), but that flag is hard-gated to
`action === "append"` in the signature (`:62-63`, `:78-80`).

**Fix landed:** the flag is now `allowActiveTargetOperation`, admitting both `append` and `edit`,
rather than adding a parallel code path. The semantics are "the caller _is_ the run that holds the
lock," which was never append-specific.

### 4. The CLI subcommands are non-executing and do not belong in `CLI_RUN_OPERATION_KINDS`

`CLI_RUN_OPERATION_KINDS` (`cli.ts:144-149`) is not a general command registry — it is the operation
discriminator passed into `runCommand`, which resolves an execution mode, builds a
`ResolvedCliConfig`, and **starts a harness**. `append`, `continue` and `rerun` are all execution
commands for that reason.

Step mutation executes nothing: it validates, writes the run file, and exits. Adding it to that enum
would drag it through `runCommand`'s harness/PTY/permission-mode setup for no reason. The correct
precedent is `ctrlyoke history` (`src/cli/HistoryCommandDefinitions.ts` +
`HistoryCommands.ts`) — a parent command with non-executing subcommands, registered separately from
`registerRunScopedCommands`. Follow that: new `src/cli/StepCommandDefinitions.ts` and
`src/cli/StepCommands.ts`.

### 5. CLI naming should be `step`, not `queue`

The Scope section said `ctrlyoke queue edit|remove|reorder` while the Naming section simultaneously
retires "queue" as a concept. Resolved in favour of `ctrlyoke step edit|remove|reorder`, consistent
with the `edit_step`/`remove_step`/`reorder_steps` MCP names.

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

- [x] A workflow step can edit, remove, or reorder any not-yet-executed step in its own run via MCP.
      The three tools use the shared addressed transactions and remain pinned to the server's own run.
- [x] An external caller can edit, remove, or reorder any not-yet-executed step of a named run via
      the CLI, including while that run is actively executing (as long as the target step is not the one
      in flight). `ctrlyoke step` resolves `--run` through `CliRunSelector`, validates with `action:
"edit"`, and writes without starting a harness.
- [x] Neither surface can touch a completed step or the step currently in flight. The shared
      `RunContinuationService` methods enforce this once; CLI tests cover both rejection cases.
- [x] No new lifecycle control (start/pause/cancel) is introduced on either surface. CLI step
      mutations are registered outside `CLI_RUN_OPERATION_KINDS` and never call `runCommand`.
- [x] All 6 existing MCP tools are renamed per the table above, every reference site in the audited
      blast radius is updated, and no harness's auto-approval/permission behavior regresses. The MCP
      and harness test suites already cover this implemented scope.
