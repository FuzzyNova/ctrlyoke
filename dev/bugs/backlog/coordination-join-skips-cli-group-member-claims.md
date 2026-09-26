# Parallel-group join does not release claims held by skill/CLI members

- **Found:** 2026-09-26 by claude-cli while fixing `coordination-cli-participant-identity-not-stable`
- **Area:** `src/core/orchestration/ExecutionRootCoordination.ts` (`releaseClaimsForGroup`, `closeAttestedGroupParticipants`, `closeAttestedParticipants`)
- **Severity:** medium: stale claims can deny the next step's paths for up to the CLI TTL (30 min)

## Symptom

When a parallel group joins, `WorkflowExecutor` asks the registry to release the members'
claims and close their leases. This only takes effect for members that reached the board
through the live MCP server. With `mcpAvailability: "disabled"`, members coordinate through
the `ctrlyoke-coordination-tools` skill. Their claims survive the join and keep denying the
same paths to later steps. That lasts until `coordination.cliParticipantTtlMinutes` expires,
unless the agent remembered to call `release_paths` before finishing.

Sequential steps in skill mode have the same gap: `closeAttestedParticipants` never closes
their leases at settlement.

## Steps to Reproduce

1. Run a workflow with `mcpAvailability: "disabled"` and a parallel group whose members each
   call `claim_paths` through the skill CLI, then finish without calling `release_paths`.
2. After the join, a later step claims one of those paths.
3. The claim is denied, and the owner named is the finished group member.

## Root Cause

All three settlement helpers filter on `participant.attested`. Skill/CLI participants are
always registered with `attested: false` (Decision 12), so the filters skip them, even though
they carry the same validated run address.

## Suggested Fix

Key settlement on the run address rather than attestation: match `kind === ctrlyoke-step` and
the `workflowKey`/`runRef` (plus `parallelGroupId`/`stepIndex` where the helpers already
narrow on them), whether or not the participant is attested. The address is validated
against the live run at registration (`resolveCoordinationContext`), and attestation is an
accuracy signal rather than a security boundary (Decision 1). Now that CLI participants keep
one identity per address, this releases the right claims.
