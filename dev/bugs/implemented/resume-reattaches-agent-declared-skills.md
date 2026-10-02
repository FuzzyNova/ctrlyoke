# Resumed sessions re-attach agent-declared skills that were already sent

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli)
- **Area:** `src/core/harness/shared/CliPromptPreparer.ts`, `src/utils/ResumeAttachmentResolver.ts`, `src/core/harness/shared/CliPromptRuntimeCoordinator.ts`
- **Resolution:** fixed in this commit

## Symptom

`general.omitPreviouslyAttachedAgentsSkillsOnResume` (on by default)
is supposed to stop a resumed session from receiving the same agent/skill
instructions twice. Skills that come from an agent's `skills:` frontmatter
(added in de00dc98d) bypass it, so they are re-sent on every resumed step. A
built-in skill such as `ctrlyoke-syntax` lives outside the trusted roots, so
the whole `SKILL.md` body is embedded again each time.

## Steps to Reproduce

1. Step 1: `agent: spec-orchestrator` (bundled; declares `skills: [ctrlyoke-syntax]`).
2. Step 2: `resumeSession: true`, `agent: test-repair` (bundled; also declares
   `ctrlyoke-syntax`).
3. Step 2's prompt embeds the `ctrlyoke-syntax` skill again, even though the
   resumed session already holds it.

Variant: step 1 `agent: test-repair`; step 2 `resumeSession: true`,
`skills: [ctrlyoke-syntax]`, no agent. Step 2 re-attaches the skill.

## Root Cause

- `ResumeAttachmentResolver.resolve` (`src/utils/ResumeAttachmentResolver.ts:43-44`)
  filters the current skills against `previousRuntime.skills`.
- `previousRuntime.skills` only ever holds the step's resolved `skills`
  property: `CliPromptRuntimeCoordinator` writes
  `params.resolvedProperties?.skills` (lines ~39/56 and ~89/109).
- Agent-declared skills are added later, inside `buildPromptSections` →
  `HarnessIntegration` (~605, `AgentExpander.resolveEffectiveSkills`), after
  resume filtering has already run (`CliPromptPreparer.ts` ~200-275). They are
  never filtered and never recorded.
- Inline `/skill:` names are also merged in after resume filtering
  (`CliPromptPreparer.ts` ~235) and are not recorded either.

## Suggested Fix

In `CliPromptPreparer`, compute the **effective** skill list (step skills, plus
the current agent's declared skills via `AgentExpander.resolveEffectiveSkills`,
plus inline `/skill:` names) _before_ resume filtering. Run
`ResumeAttachmentResolver` over that full list. Pass the already-final list to
`buildPromptSections` so it does not add agent skills a second time.
`resolveEffectiveSkills` stays the single place that knows about agent
`skills:`. Record the effective attached list in `_runtime.skills`, so the next
resume can see what the session actually holds.

Check `replyToStep.ts:66`, which copies `runtime.skills` into a reply step;
recording effective skills there is harmless because they are deduped. Keep the
dry-run preview (`ExecutionPreviewService.ts` ~542) on the same helper, so it
lists the inline `/skill:` names a run attaches.

Also correct the `skills` schema description in `schemas/workflow-schema.json`.
It says "Use null to explicitly disable inherited skills", but an agent's
declared skills still attach with `skills: null`, as
`docs/workflows/agents-and-skills.md` already documents. Then run
`npm run schema:update`.
