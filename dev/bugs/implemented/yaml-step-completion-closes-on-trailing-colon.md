# `$step:` completion closes in a plain YAML value

- **Found:** 2026-10-19 by Claude Code while scripting the "Build visually or edit as YAML" clip (`media/shots/visual-or-yaml.capture.ts`)
- **Area:** workflow YAML completions in the workspace viewer (`src/ui/webview-react/utils/workflowFileSupport/`)
- **Resolution:** fixed in this commit

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

YAML reads `prompt: Fix the README bug from $step:` as a compact nested mapping:
`prompt: {"Fix the README bug from $step": null}`. That is an error on a single line, but the
tolerant parser still builds the node. The AST walk in `WorkflowLocationYaml.ts` descended into
that mapping and reported a key/value of an unknown object, not prompt text. The prompt
completion source therefore returned nothing. `getYamlTextSpans` likewise produced no prompt
span, so `getWorkflowPromptCompletionContext` had no step list to offer. In a block scalar the
colon is ordinary text, which is why `prompt: |` worked. A digit after the colon (`$step:4`)
stops the line from being a mapping, which is why the list survived once it was open.

## Fix

`compactBlockMapText` recognises a block mapping that starts on its key's own line and returns
the plain value's source range, up to the end of the line and before any comment.
`locateInAst` defers such a value to the existing line scan, which already reads it as a plain
`prompt` value. `getYamlTextSpans` emits a plain-text span over that range for text fields, so
the completion context lists the earlier steps. The VS Code `PromptCompletionProvider` goes
through the same location module, so it is fixed too.
