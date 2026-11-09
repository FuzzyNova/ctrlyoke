# Importing a history-only bundle keeps authored `parallel:` blocks, so step indices shift and rerun fails

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/orchestration/RunMaterializer.ts` (`materialize`, `projectAttemptRuntime`), `src/core/orchestration/RunBundleImporter.ts` (`importRun`), `src/core/WorkflowStepSanitizer.ts` (`buildAuthoredWorkflow`), `src/core/ParallelGroupTopology.ts` (`flattenParallelItems`)
- **Resolution:** fixed in this commit

## Symptom

A run whose workflow has a parallel group imports wrongly from a history-only
bundle (a completed run, or any run with no pending work). The group arrives
as a single nameless, prompt-less queue item, so every later step moves down
one index and is paired with the wrong timeline events:

```
# source workspace
$ ctrlyoke history steps --workflow scripted
0      one    completed  …  echo hello-one
1      pa     completed  …  echo pa
2      pb     completed  …  echo pb
3      three  completed  …  echo three; exit 0
4      four   completed  …  echo four
final  fin    completed  …  2 passes  echo final

# after export + import
$ ctrlyoke history steps --workflow scripted
0      one    completed  …  echo hello-one
1      —      completed  …
2      three  completed  …  echo three; exit 0
3      four   completed  …  echo four
final  fin    completed  …  2 passes  echo final
```

- `history show --step 2` is headed `three` but prints **pb**'s output.
  `--step 1` prints pa's output under "Step 2". The source's step 4 (`four`)
  cannot be addressed at all ("This run has 4 steps").
- `ctrlyoke rerun --workflow scripted --from 1` on the imported run fails:
  `Error: Working file validation failed: Prompt 2: Empty prompt text`.
- The imported working file has no `parallelGroups`, and its `steps[1]` is
  `{ parallel: [...], failFast: true }`. The dashboard reads the same file, so
  it very likely shows the same broken queue. That was not checked in the
  dashboard.

## Steps to Reproduce

```sh
R=/tmp/cypar; rm -rf $R; mkdir -p $R/ws $R/ws2; export CTRLYOKE_HOME=$R/home
cd $R/ws && git init -q && git commit -q --allow-empty -m init
cat > wf.ctrlyoke.yaml <<'EOF'
name: scripted
steps:
  - { name: one, type: script, script: echo hello-one }
  - parallel:
      - { name: pa, type: script, script: echo pa }
      - { name: pb, type: script, script: echo pb }
  - { name: three, type: script, script: echo three }
EOF
ctrlyoke run wf.ctrlyoke.yaml
ctrlyoke export --workflow scripted -o $R/b          # "History only"
cd $R/ws2 && git init -q && git commit -q --allow-empty -m init
ctrlyoke import $R/b.ctrlyokerun
ctrlyoke history steps --workflow scripted           # 3 rows, row 1 is "—"
ctrlyoke history show --workflow scripted --step 2   # "three" heading, pb output
ctrlyoke rerun --workflow scripted                   # Empty prompt text
```

## Root Cause

A bundle's `workflow.ctrlyoke.json` is the **authored** workflow:
`buildAuthoredWorkflow` (`WorkflowStepSanitizer.ts`) folds runtime parallel
groups back into `parallel:` blocks. Only continuable bundles also carry the
flat working file (`run.json` → `header.runtime`). For a history-only import,
`RunBundleImporter.importRun` passes only `definition`.
`RunMaterializer.materialize` then uses `definition.steps` as the working
file's `steps` without flattening. It never derives `parallelGroups`, while the
timeline's `target.stepIndex` values are flat runtime indices.

`projectAttemptRuntime` (added in `4ccc6e968` to rebuild history-only step
state) has the same index mismatch. The parallel item gets pa's runtime,
`three` gets pb's, and so on.

The continuable path is unaffected because `{ ...definition, ...workingFile }`
takes the flat `steps` and `parallelGroups` from the working file.

## Suggested Fix

- Normalize a history-only bundle's authored definition to the runtime shape
  before anything uses its indices. Flatten `parallel:` items with
  `flattenParallelItems` (`ParallelGroupTopology.ts`), the helper the parser
  uses, and set the resulting `parallelGroups` (ids included, as
  `normalizeParallelGroupTopology` produces them). Do it in the importer,
  before `projectAttemptRuntime` runs (it is called in `RunBundleImporter`
  after `rewriteAssets`), or at the top of `RunMaterializer.materialize` when
  `input.workingFile` is absent. Either way, the runtime projection and the
  written working file must both see flat indices.
- Check whether the authored form has other non-runtime shapes that
  materialization must undo the same way. Compare it with what
  `PromptFileParser` does for a normal run.
- Tests in `src/test/unit/RunBundleImporter.test.ts`: a history-only bundle
  whose definition has a `parallel:` block imports as flat steps with a
  matching `parallelGroups` entry. Each step's projected `_runtime` comes from
  its own attempts (members and the steps after the group). A rerun or
  `history show --step` of a step after the group reads its own output.
- Add a `CHANGELOG.md` **Fixed** entry under `## [Unreleased]`.
