# Resume attachment omission misses earlier session history (chains and other runs)

- **Found:** 2026-10-17 by Nathan (observed), traced by Claude
- **Area:** `src/utils/ResumeAttachmentResolver.ts`, `src/core/harness/shared/CliPromptPreparer.ts` (~L205-251), `src/core/harness/shared/CliPromptRuntimeCoordinator.ts` (~L92-114), `src/ui/webview-react/utils/replyToStep.ts`
- **Severity:** medium

## Symptom

With `general.omitPreviouslyAttachedAgentsSkillsOnResume: true` (the default), a step that resumes a
session still gets the agent and skill instructions that session already received, in two cases:

1. **Reply to step in a new workflow.** Reply to step on a step from another workflow's run creates a
   step with that session's `sessionId` and the source step's agent and skills. Its first prompt
   attaches all of them again.
2. **Three or more steps on one session, inside one run.** Step A attaches skill X. Step B resumes the
   session and correctly omits X. Step C resumes too and attaches X again; D omits it, E attaches it,
   and so on. Skills alternate. The agent is not affected.

Each re-attachment costs tokens and repeats instructions the harness already has.

## Steps to Reproduce

Case 1:

1. Run workflow W1 with a step that declares an agent and skills, so its session receives them.
2. Create a new workflow W2 and use Reply to step on W1's step.
3. Run it. The prompt's categorized references list the agent and skills again.

Case 2:

1. One workflow, three steps on the same harness, all `resumeSession: true`, each declaring skill X.
2. Run it. Step 2's prompt omits X; step 3's prompt includes X again.

## Root Cause

`ResumeAttachmentResolver.findPreviousRuntime` looks only at earlier steps in the current run's
`allPrompts`, and stops at the single most recent completed step whose `_runtime.sessionId` matches.

- **Case 1:** the steps that used the session live in another run's working copy, so nothing matches
  and the resolver falls back to attaching everything.
- **Case 2:** `_runtime.skills` records what was actually sent (`attachedSkills`, the filtered
  `effectiveSkills` from `CliPromptPreparer.planPrompt`), not what the session holds. Step B records
  `skills: []`, so step C compares against B alone, sees nothing attached, and re-sends X.
  `_runtime.agent` stores the declared agent (`resolvedProperties.agent`), not the filtered one, which
  is why the agent does not alternate.

## Suggested Fix

1. **In-run chains (small, do first):** compute the session's attachments as the union over _every_
   completed earlier step with the same harness and `sessionId`, rather than the most recent one.
   Keep `_runtime.skills` as "what this step sent", since the output pane and history read it that way.
   Add the three-step case to `ResumeAttachmentResolver.test.ts`.
2. **Sessions from other runs:** the resolver needs history that outlives the run. The more general
   option is a small per-project ledger keyed by harness and session ID, recording the agent and
   skills sent into each session. It would be written when a prompt's runtime is persisted, and
   read when no in-run step matches. It would also cover CLI and MCP resumes with an explicit
   `sessionId`. The narrower option is for Reply to step to carry the source session's accumulated
   attachments onto the new step, which needs a persisted field and only covers that one entry point.
   Either way, decide how stale entries are pruned (for example, with run retention).
