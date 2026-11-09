# `ctrlyoke continue` / `rerun` header says `Running: <inline prompt>` for a workflow run

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/cli.ts` (`printRunHeader` in `runCommand`, around lines 1085–1125)
- **Severity:** low

## Symptom

Continuing or rerunning a workflow file run prints a header that says the run
is an inline prompt:

```
ctrlyoke CLI v0.5.2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Running: <inline prompt>
Harness: claude-cli (opus)
```

The run is the workflow `g` from `g.ctrlyoke.yaml`. `ctrlyoke run g.ctrlyoke.yaml`
prints `Running: g.ctrlyoke.yaml` for the same workflow.

## Steps to Reproduce

```sh
export CTRLYOKE_HOME=/tmp/cyb/home; mkdir -p /tmp/cyb/ws && cd /tmp/cyb/ws && git init -q
cat > g.ctrlyoke.yaml <<'EOF'
name: g
steps:
  - type: script
    script: test -f ok.flag
EOF
ctrlyoke run g.ctrlyoke.yaml --headless   # Running: g.ctrlyoke.yaml, ends in error
touch ok.flag
ctrlyoke continue --workflow g --run 1    # Running: <inline prompt>
ctrlyoke rerun --workflow g               # Running: <inline prompt>
```

## Root Cause

`printRunHeader` builds the `Running:` line from `resolvedFile` only:
`resolvedFile ? path.basename(resolvedFile) : "<inline prompt>"`. `rerun` and
`continue` address a workflow lineage (`--workflow`) and pass no file, so
`resolvedFile` is undefined and the header falls back to the inline-prompt
label. For `append`, `resolvedFile` is the file of steps being appended, so
the header names that file rather than the workflow it is appended to.

The header is printed from `executeAddressedCliOperation`'s
`onWorkflowLoaded` callback, so the bound workflow (its `name`, and the
lineage's `workflowKey`/`runRef`) is already available there.

## Suggested Fix

Only use the inline-prompt label for `ctrlyoke run --prompt`. For the
addressed operations (`rerun`, `continue`, `append`), name the bound workflow,
for example `Running: g (run-2026-11-09T06-16-25-776Z)`, using the loaded
workflow's `name` (falling back to the workflow key). Keep `run <file>`
unchanged. Add a test that drives the header for a `continue` operation and
asserts it does not say `<inline prompt>`.
