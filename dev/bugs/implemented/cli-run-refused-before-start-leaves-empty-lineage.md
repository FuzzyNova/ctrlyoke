# `ctrlyoke run` refused before its first step leaves an empty draft lineage

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/cli.ts` (`run` operation, around lines 1459–1517; `mergeCliVarsIntoWorkflow`), `src/core/WorkflowInstance.ts` (`loadPromptFile`)
- **Resolution:** fixed in this commit

## Symptom

Some `ctrlyoke run <file>` invocations exit 2 "before the run starts". Each one
still creates a new workflow lineage, holding only `workflow.json` and
`draft/workflow.ctrlyoke.json`. These lineages pile up in `ctrlyoke history list`
with `RUNS 0`, and they show up in the dashboard's workflow list as never-run
drafts:

```
KEY                        NAME  RUNS  LATEST            STATE
g-2026-11-09T10-50-53-541  g     1     2026-11-09 10:50  completed
g-2026-11-09T10-50-47-264  g     0     —                 —
g-2026-11-09T10-50-53-217  g     0     —                 —
j-2026-11-09T10-51-38-438  j     0     —                 —
```

Reproduced triggers:

- A `--var` whose name differs only in case from a workflow `vars` key
  (`Error: Invalid workflow variables: Variable names must not differ only by case ("MODULE")`).
- A workflow whose secret grants are not yet approved, run without a TTY
  (`Error: these have not been approved. Run ctrlyoke trust-secret-grants …`).
  This one is the CI case. Every retried CI job leaves another empty lineage
  until someone runs the trust command.
- By the same code path, also expected: refusing the workflow
  `trustedExternalRoots` gate (`exitUnlessTrustDecided(workflowExternalRootsTrustRequest(...))`).

Failures detected before loading (an invalid `vars` block in the file, or a
malformed `--var` such as `bad-name=1`) correctly leave nothing behind.

## Steps to Reproduce

1. In a scratch git repo, save:

   ```yaml
   # g.ctrlyoke.yaml
   name: g
   vars:
     module: src/parser
   steps:
     - type: script
       script: echo hi
   ```

2. `ctrlyoke run g.ctrlyoke.yaml --var MODULE=x` (exits 2).
3. `ctrlyoke history list` lists a new `g-…` lineage with 0 runs.
4. Repeat with a step that declares `secrets: [SOME_UNAPPROVED_NAME]`, run with
   `</dev/null`. Each invocation adds another empty lineage.

## Root Cause

In the `CLI_RUN_OPERATION_KINDS.RUN` branch of `src/cli.ts`,
`instance.loadPromptFile(resolvedFile)` runs first. That call allocates the
lineage and writes its draft definition. The pre-start checks run after it:
the external-roots trust gate, `mergeCliVarsIntoWorkflow` (which throws on a
case-only clash), and the secret-grants trust gate (which calls `process.exit(2)`
through `exitUnlessTrustDecided`). Nothing removes the lineage that load just
created when one of these refuses. The dry-run path (around line 1893) parses
without a lineage, so it doesn't leak.

## Suggested Fix

Make every pre-dispatch refusal leave no persisted state behind:

- Validate the merged `--var` set before any lineage exists, against the
  parsed workflow's `vars`. Either parse the file first (as the dry-run path
  does), or check right after parse and before the lineage is allocated.
- For the trust gates, which need the loaded workflow, either run them on the
  parsed workflow before `loadPromptFile`, or delete the lineage this
  invocation just created when they refuse. Only delete it when it has no
  runs, is the lineage this process created, and its runner lock is ours. Use
  the existing lineage-deletion API in the history repository rather than raw
  `fs.rm`.
- `exitUnlessTrustDecided` calls `process.exit` directly, so any cleanup must
  happen before that call, for example by having the gate return the exit code
  to the run path.

Add CLI tests covering both reproduced triggers. Each should assert that the
exit code is 2 and that the project's `.runs/` gains no new lineage directory.
