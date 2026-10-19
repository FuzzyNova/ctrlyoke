# `$step:` completion closes in a plain YAML value

- **Found:** 2026-10-19 by Claude Code while scripting the "Build visually or edit as YAML" clip (`media/shots/visual-or-yaml.capture.ts`)
- **Area:** workflow YAML completions in the workspace viewer (`src/ui/webview-react/utils/workflowFileSupport/`)
- **Severity:** low

## Symptom

In a workflow file opened in the workspace viewer, typing `prompt: Fix the README bug from $step:`
on a plain (unquoted, single-line) value shows no completion list once the colon is typed, so the
step picker never appears. In a block scalar (`prompt: |`) the same text lists every earlier step.
Typing `$ste` first, so the list is already open, and then `p:4` keeps it open.

## Steps to Reproduce

1. Open `.ctrlyoke/workflows/bug-sweep.ctrlyoke.yaml` (demo-app) in the workspace viewer.
2. At the end of the file add `  - name: Fix doc bug` and `    prompt: Fix the README bug from $step:`.
3. No list appears.

## Root Cause

Not yet confirmed. A plain scalar that ends in `: ` or `:` is parsed as a nested mapping key, so
the cursor is probably no longer inside a `prompt` value when the completion source asks the YAML
document where it is.

## Suggested Fix

Resolve the completion context from the line text when the parse puts the cursor in an
unexpected key, or treat a trailing `$step:` token as reference text before handing the line to
the YAML parser.
