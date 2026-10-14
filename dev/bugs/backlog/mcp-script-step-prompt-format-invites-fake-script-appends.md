# MCP tools show script steps as `(script) <cmd>` prompts, which models copy into `append_step`

- **Found:** 2026-10-14 by Claude Code (capturing D26 for `docs/workflows/dynamic-workflows.md`)
- **Area:** `src/mcp-server.ts`
- **Severity:** low

## Symptom

A finalStep asked Claude Code (Haiku) to append a script step running `npm run build`.
`append_step` can't append script steps (documented in `docs/reference/mcp-tools.md`), so the
model copied the format `workflow_status` uses for script steps and called:

```json
{ "steps": [{ "name": "Build", "prompt": "(script) npm run build" }] }
```

ctrlyoke accepted it as an ordinary prompt step. Claude then ran `npm run build` itself, with
`--dangerously-skip-permissions`, as a full AI turn. The steps panel showed a Claude Code
prompt step named Build, and the next `workflow_status` call listed it exactly like a real script
step, so the model went on to report that a "Build script step" existed.

## Steps to Reproduce

1. Run a workflow with a script step and a finalStep that has `mcpServers: [ctrlyoke]` and a
   prompt such as "If no step named Build exists, append a script step named Build that runs
   `npm run build`" (the demo project's `docs-append` workflow).
2. Inspect the run's `events.jsonl`: the `append_step` call has
   `"prompt": "(script) npm run build"`.
3. Step 2 runs as an AI prompt, not a script.

## Root Cause

`workflow_status` (`src/mcp-server.ts:1066`) and `read_output` (`:1665`) put script steps into
the `prompt` field as `` `(script) ${p.script}` ``. A model reading that output sees a "prompt"
whose text is the script marker and reasonably reuses the shape. `append_step` doesn't reject
the marker, and the status output can't distinguish a real script step from a prompt step whose
text starts with `(script) `.

## Suggested Fix

- Report script steps with explicit fields (`type: "script"`, `script: "<cmd>"`) instead of
  overloading `prompt`, in both `workflow_status` and `read_output`. Update
  `docs/reference/mcp-tools.md` (the `steps[]` bullet) to match.
- In `append_step`/`edit_step`, refuse a prompt that starts with `(script) ` with an error
  saying script steps can't be appended, so the model gets a clear signal instead of a
  silently wrong step.
- Optionally, say "script steps cannot be appended" in the `append_step` tool description
  itself, not only in the docs.
- Related: the dashboard's rendering of a `workflow_status` result lists a **Harness** of
  "Claude Code" for the `npm test` script step, which has no harness. Show "Script" (or
  nothing) for script steps there.
