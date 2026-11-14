# Dashboard says named-worktree setup runs only when the worktree is created

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing 096fd5047
- **Area:** `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx`, `src/ui/webview-react/components/settings/settingsCatalog.ts`
- **Resolution:** fixed in this commit

## Symptom

Since 096fd5047, a named worktree's `setup` runs at the start of every run and
is skipped only when the same run resumes or continues. The schema
(`worktree.setup` description), `docs/workflows/worktrees.md` and the
CHANGELOG say so. Two dashboard strings still describe the old behavior:

- Workflow properties panel, Worktree → **Setup** (shown for both managed and
  named mode): "Optional command run after a new worktree is created…".
- Settings → Defaults, named mode `setup` in `WORKTREE_MODE_DESCRIPTIONS.named`:
  "Optional command run after creating a named worktree…".

## Steps to Reproduce

1. Open the workflow properties panel, choose Worktree → Named.
2. Read the Setup field's description. Do the same on Settings → Defaults.

## Root Cause

096fd5047 changed `WorktreeManager`'s named setup to run per run and updated
the schema and docs, but not these two hand-written UI strings.

## Suggested Fix

Give named mode its own description that matches the schema: take it from
`SCHEMA_DESCRIPTIONS` as the Defaults page already does for `directory`, or
add a mode-specific string. Keep the managed-mode text (setup runs when a new
managed worktree is created). Update the React tests that assert these strings.
