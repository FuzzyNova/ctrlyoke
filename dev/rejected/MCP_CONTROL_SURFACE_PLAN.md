# MCP Workflow Control Surface Plan

> **Status: REJECTED (2026-07-31).** The MCP server is deliberately scoped to the
> single run that spawned it. A cross-workflow lifecycle surface would break that
> scoping while adding a second execution control plane that the CLI already owns.
> Two pieces were harvested rather than discarded — see "Disposition" below.

## Why this was rejected

### 1. The ctrlyoke MCP server is blanket auto-approved

`ClaudeCliProvider.ts` passes `--allowed-tools mcp__ctrlyoke`, and the other
providers grant the built-in server equivalent standing. This is necessary —
unattended workflows cannot stop at a tool-approval prompt — but it means the
built-in server does **not** go through the `autoApprove` config, the tool
permission mappers, or any human-in-the-loop check that governs every other MCP
server.

That inverts the cost of adding a tool here. A new tool is not "a capability the
user can opt into"; it is an unprompted capability granted to every step of every
workflow, permanently. `ctrlyoke_start_workflow` under that grant lets any
prompt-injected file a step reads spawn arbitrary billable harness runs, with no
approval gate anywhere in the path.

The run-scoping enforced by `requireRunAddress`/`resolveRun` in
`src/mcp-server.ts` — which resolves every tool against the single run named by
`CTRLYOKE_WORKING_FILE`, accepts no target from the caller at all, and refuses
outright when no run is attached — is what makes blanket auto-approval
defensible. It is a security boundary, not an incidental limitation.

### 2. It duplicates a control plane the CLI already owns

`dev/implemented/AUTOMATION_API_PLAN.md` had already deferred `ctrlyoke_run_workflow`
indefinitely for exactly this reason: it "would create a second lifecycle,
locking, cancellation, and workspace control plane." `ctrlyoke_start_workflow`
was the same tool under a different name.

The external-automation use case — an editor assistant or CI bot driving ctrlyoke
— is served by `ctrlyoke run --headless --json`. Any agent that could call an MCP
tool also has a shell. Routing it through MCP instead would only bypass the
harness's own shell-permission prompt, which is a security downgrade, not a
feature.

### 3. Composition and stop-for-approval already have better answers

- **Sub-workflow composition** belongs in `dev/backlog/WORKFLOW_STEP_PLAN.md`
  (`type: "workflow"`): a declared, deterministic queue step with real lineage,
  visible in the workflow file. Not a model-judgment call at runtime.
- **Stopping to wait for a human** already ships deterministically via
  pre-condition `stopWorkflow` / `skipPrompt` actions, `endCondition.onFail:
"stopWorkflow"`, and script-step `onPass`/`onFail`. Where model judgment should
  drive the decision, the step writes a sentinel file and an end-condition script
  gates on it — author-opted-in, declared in the workflow, and auditable.

  A `ctrlyoke_pause_workflow` tool would instead let any step halt a run on a
  whim, which is precisely the false-positive-stop risk that motivates the
  guardrail in the first place. The "but the model needs to interrupt mid-step"
  objection does not hold: the model can stop doing the thing and report, the
  step ends, and the gate fires at the boundary.

## Disposition

| Proposed capability                                    | Outcome                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctrlyoke_start_workflow`                              | Rejected. Superseded by `WORKFLOW_STEP_PLAN.md` for composition, CLI for external automation.                                                                          |
| `ctrlyoke_cancel_workflow`                             | Rejected. An auto-approved cross-workflow cancel is a DoS primitive against sibling runs.                                                                              |
| `ctrlyoke_pause_workflow` / `ctrlyoke_resume_workflow` | Rejected. Existing condition actions cover the case deterministically.                                                                                                 |
| `ctrlyoke_list_workflows` / `list_runs` / `get_run`    | Rejected as new tools. `ctrlyoke_global_status` already covers workspace-level reads.                                                                                  |
| Cursor-based output/event reads (Phase 3)              | **Harvested** → `dev/backlog/MCP_OUTPUT_PAGING_PLAN.md`.                                                                                                               |
| Shared `WorkflowControlService`                        | **Harvested** as a note. Its real consumers are `STANDALONE_SERVER_PLAN.md` and `WORKFLOW_SCHEDULING_PLAN.md`, not MCP. Design it there, driven by those requirements. |

## Standing constraint

The non-goal this decision establishes is recorded in
`.github/instructions/extension.instructions.md`: **no tool on the built-in MCP
server may target a workflow other than the run it was launched for, and no tool
may start, cancel, or pause a run.** `ctrlyoke_global_status` remains the single
read-only exception. Re-proposing a lifecycle surface requires first solving the
auto-approval posture, not just the API shape.

The same decision settles the caller question: this server exists to serve one
ctrlyoke run, so it has no "external client" mode to design an API for. Driving
ctrlyoke from outside a workflow is the CLI's job
(`dev/implemented/AUTOMATION_API_PLAN.md`).

---

## Original proposal (retained as record)

**Status:** Proposed
**Priority:** High — post-launch foundation

### Problem

`ctrlyoke-mcp` currently exposes status, queue append, output read, and global
status. An external agent can inspect or extend a workflow, but it cannot perform
the complete lifecycle: start a workflow, pause it, resume it, cancel it, or list
and inspect historical runs.

That makes the MCP server useful inside a run but incomplete as an automation
API. The product should have one typed control surface shared by the VS Code LM
tools, the standalone MCP binary, and the future standalone server.

### Product Decision

Build a small workflow-control service in the core orchestration layer and make
every transport delegate to it. Do not implement lifecycle semantics separately
in `src/mcp-server.ts`, `src/extension.ts`, and the hosted server.

The first complete surface is:

- `ctrlyoke_start_workflow`
- `ctrlyoke_list_workflows`
- `ctrlyoke_get_run`
- `ctrlyoke_list_runs`
- `ctrlyoke_pause_workflow`
- `ctrlyoke_resume_workflow`
- `ctrlyoke_cancel_workflow`
- existing queue, status, and output tools

Every mutating call must target an explicit workflow/run identifier and remain
scoped to the open workspace. Ambiguous "current workflow" behavior may remain
as a convenience only when exactly one valid target exists.

### Phase 1 — Shared application service

- Add a platform-neutral `WorkflowControlService` over the existing
  orchestrator, lineage repository, lock manager, and run-output resolver.
- Define request/response contracts once in `src/types/`.
- Return structured failure codes for invalid target, busy workflow, stale run,
  unauthorized path, validation failure, and unsupported host capability.
- Reuse the workflow schema and parser for start requests; never accept an
  unvalidated ad hoc workflow object.

### Phase 2 — MCP and VS Code LM parity

- Register the complete tool set in `ctrlyoke-mcp`.
- Expose the same applicable tools through VS Code's Language Model Tool API.
- Generate tool descriptions and input schemas from the shared contracts.
- Keep read tools safe by default and make the effects of mutating tools explicit
  in their descriptions and results.

### Phase 3 — History and streaming follow-up

- Add cursor-based output/event reads so callers do not repeatedly fetch an
  entire run.
- Add stable run references to every lifecycle response.
- Let a future HTTP/WebSocket or SDK surface wrap the same service instead of
  creating a second API model.

### Security and correctness

- Resolve all paths through the existing workspace/file-access policies.
- Do not permit a tool argument to choose an arbitrary run-storage root.
- Preserve lock and stale-run recovery semantics; MCP must not bypass them.
- Keep tokens, prompt contents, and file paths out of error telemetry.
- Add integration tests proving that every transport produces equivalent
  lifecycle state transitions and rejects cross-workspace targets.

### Acceptance criteria

- An MCP client can start, observe, pause, resume, cancel, and inspect a workflow
  without using the dashboard.
- Tool schemas and lifecycle contracts have one source of truth.
- Existing queue-append and output tools retain compatibility with the shared
  run-reference model.
- All mutations are workspace-scoped and covered by lock/concurrency tests.
