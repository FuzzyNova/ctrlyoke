# `step edit --prompt` (and MCP `edit_step` with `prompt`) silently turns a script step into an AI prompt step

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/cli/StepCommands.ts` (`editStepCommand`, `parseStepChange`), `src/mcp-server.ts` (`handleStepEdit`), `src/core/WorkflowStepSanitizer.ts` (`mergeWorkflowStepUpdate`)
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke step edit --index N --prompt "<text>"` on a pending **script** step
reports success, but the stored step becomes `{ "prompt": "<text>" }`. Its
`type: script`, `script`, `name`, `onFail`, `env`, timeouts and every other
field are gone. On `ctrlyoke continue`, the text the user meant as a shell
command is sent to an AI harness as a prompt, which costs money and runs the
wrong kind of step. Nothing warns that the step changed kind.

```
$ ctrlyoke history steps --workflow scripted
1  two    failed   …  echo hello-two; exit 3
$ ctrlyoke step edit --workflow scripted --run <ref> --index 1 -p "echo fixed-two"
Edited step 1 in …
$ ctrlyoke history steps --workflow scripted
1  —      pending  …  echo fixed-two          # name gone; stored step is {"prompt":"echo fixed-two"}
```

MCP `edit_step` behaves the same way: `updates: { "prompt": "…" }` on a script
step replaces it with a bare prompt step. Its only script guard rejects a
prompt starting with the `(script) ` marker. The tool's own error says
"Script steps cannot be edited through MCP; edit_step only accepts prompt
steps", so converting a script step is outside what the tool says it allows.

## Steps to Reproduce

```sh
R=/tmp/cyedit; rm -rf $R; mkdir -p $R/ws && cd $R/ws && git init -q && git commit -q --allow-empty -m init
export CTRLYOKE_HOME=$R/home
cat > wf.ctrlyoke.yaml <<'EOF'
name: scripted
steps:
  - name: one
    type: script
    script: echo hello-one
  - name: two
    type: script
    script: echo hello-two; exit 3
EOF
ctrlyoke run wf.ctrlyoke.yaml            # step "two" fails, run is errored
ctrlyoke step edit --workflow scripted --run <run-ref> --index 1 -p "echo fixed-two"
# Read the run's workflow.ctrlyoke.json: steps[1] is {"prompt":"echo fixed-two"}
```

## Root Cause

`parseStepChange` turns `--prompt` into `{ updates: { prompt } }`.
`RunContinuationService.editStepAtRun` merges that through
`mergeWorkflowStepUpdate`. That function treats an incoming `prompt` key as
"incoming is a prompt step", sees a kind mismatch with the existing script step,
and returns the incoming object wholesale. That rule is right for the
dashboard's explicit type switch and for a full one-step file, but wrong for a
flag documented as "Replace the step prompt". `handleStepEdit` in
`mcp-server.ts` goes through the same merge with the agent's partial `updates`.

The earlier fix in `dev/bugs/implemented/mcp-edit-step-wipes-script-step.md`
covered partial updates with no kind-defining key, such as `name` or `enabled`.
This case is the one that bug's "reject prompt-only fields on a script step"
suggestion was meant to cover.

## Suggested Fix

Refuse the implicit conversion rather than guessing:

- CLI: in `editStepCommand`, when `--prompt` is used and the addressed step is
  a script step, fail with a clear error (exit 2), e.g. `step N is a script
step; --prompt only edits prompt steps. Pass a one-step file to change a
script step or its type`. The one-step file path keeps its documented
  merge/replace behaviour. A file containing a full prompt step is an explicit
  replacement.
- MCP: in `handleStepEdit`, reject `updates.prompt` when the existing step is
  a script step, with the same wording family as the existing "Script steps
  cannot be edited through MCP" error.
- Tests: `src/test/unit/StepCommands.test.ts` (the `--prompt` on a script step
  is rejected and the step is unchanged; `--prompt` on a prompt step still keeps
  its `name`), and the MCP edit_step tests (`updates.prompt` on a script step is
  rejected; `updates.name` on a script step still works).
- Add a `CHANGELOG.md` **Fixed** entry under `## [Unreleased]` and mention
  the script-step restriction under `ctrlyoke step edit` in `docs/cli/ctrlyoke.md`.
