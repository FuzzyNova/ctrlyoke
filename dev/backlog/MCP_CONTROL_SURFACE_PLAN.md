# MCP Workflow Control Surface Plan

**Status:** Proposed  
**Priority:** High — post-launch foundation

## Problem

`ctrlyoke-mcp` currently exposes status, queue append, output read, and global
status. An external agent can inspect or extend a workflow, but it cannot perform
the complete lifecycle: start a workflow, pause it, resume it, cancel it, or list
and inspect historical runs.

That makes the MCP server useful inside a run but incomplete as an automation
API. The product should have one typed control surface shared by the VS Code LM
tools, the standalone MCP binary, and the future standalone server.

## Product Decision

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

## Phase 1 — Shared application service

- Add a platform-neutral `WorkflowControlService` over the existing
  orchestrator, lineage repository, lock manager, and run-output resolver.
- Define request/response contracts once in `src/types/`.
- Return structured failure codes for invalid target, busy workflow, stale run,
  unauthorized path, validation failure, and unsupported host capability.
- Reuse the workflow schema and parser for start requests; never accept an
  unvalidated ad hoc workflow object.

## Phase 2 — MCP and VS Code LM parity

- Register the complete tool set in `ctrlyoke-mcp`.
- Expose the same applicable tools through VS Code's Language Model Tool API.
- Generate tool descriptions and input schemas from the shared contracts.
- Keep read tools safe by default and make the effects of mutating tools explicit
  in their descriptions and results.

## Phase 3 — History and streaming follow-up

- Add cursor-based output/event reads so callers do not repeatedly fetch an
  entire run.
- Add stable run references to every lifecycle response.
- Let a future HTTP/WebSocket or SDK surface wrap the same service instead of
  creating a second API model.

## Security and correctness

- Resolve all paths through the existing workspace/file-access policies.
- Do not permit a tool argument to choose an arbitrary run-storage root.
- Preserve lock and stale-run recovery semantics; MCP must not bypass them.
- Keep tokens, prompt contents, and file paths out of error telemetry.
- Add integration tests proving that every transport produces equivalent
  lifecycle state transitions and rejects cross-workspace targets.

## Acceptance criteria

- An MCP client can start, observe, pause, resume, cancel, and inspect a workflow
  without using the dashboard.
- Tool schemas and lifecycle contracts have one source of truth.
- Existing queue-append and output tools retain compatibility with the shared
  run-reference model.
- All mutations are workspace-scoped and covered by lock/concurrency tests.
