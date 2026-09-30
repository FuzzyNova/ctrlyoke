# Reply banner stays up after switching the draft to a Script step

- **Found:** 2026-09-30 by bug-backlog final step (claude-cli, code review + scratch vitest)
- **Area:** `src/ui/webview-react/store/editorStore.ts`, `src/ui/webview-react/components/layout/EditorSection.tsx`
- **Severity:** low

## Symptom

After **Reply to Step**, switching the new-prompt editor from Prompt to Script leaves the
banner reading "Replying to Claude Code session … (Step N)". Clicking Add then queues a
script step, which has no harness and no session. The banner claims something that is no
longer true. `dev/implemented/REPLY_TO_STEP_PLAN.md` §5 says: "Once the draft isn't a reply
any more, the banner shouldn't claim it is."

## Steps to Reproduce

1. Right-click a completed prompt step and choose **Reply to Step**. The info banner
   appears.
2. Switch the editor's step type to **Script**.
3. The banner is still shown, above a script editor.

## Root Cause

`setStepType` (`editorStore.ts` ~l.880) only flips `stepType`. The banner in
`EditorSection.tsx` (~l.380) is gated only on the new-prompt target and a non-null
`replyContext`, and never checks `stepType`.

## Suggested Fix

Hide the banner while `stepType === STEP_TYPES.SCRIPT`, and keep `replyContext` so that
switching back to Prompt restores the reply. `setStepType` already preserves prompt state
for that round trip on purpose. Make sure a script step submitted from that state does not
carry reply fields. The alternative is to clear `replyContext` in `setStepType(SCRIPT)`.
Either way, add a vitest for EditorSection or editorStore.
