# `ctrlyoke run` never prints a script's stdout or stderr

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/cli.ts` (`instance.onTargetScriptOutput` subscription), `src/cli/CliTerminalFormatter.ts` (`renderScriptOutput`)
- **Severity:** high

## Symptom

When `ctrlyoke run` executes a script step, pre-condition or end-condition,
the terminal shows the command line and the verdict block but none of the
script's output. Nothing streams while the script runs, and nothing is
printed when it finishes. The output is recorded: `ctrlyoke history show
--step N` prints it under "Script step output:", and `--json` includes it in
`steps[].script.stdout`. A user watching a live run (or reading a CI log)
cannot see what a test or build script printed, including why it failed.

This has shipped in every release since v0.2.0.

## Steps to Reproduce

```sh
R=/tmp/cyout; rm -rf $R; mkdir -p $R/ws && cd $R/ws && git init -q
export CTRLYOKE_HOME=$R/home
cat > e.ctrlyoke.yaml <<'EOF'
name: e
steps:
  - type: script
    name: one
    script: echo hello-one; echo warn-one 1>&2
EOF
ctrlyoke run e.ctrlyoke.yaml --headless > out.txt
grep -c hello-one out.txt      # 1: only the echoed command line "…> echo hello-one; …"
grep -c warn-one out.txt       # 1: same, never the output itself
ctrlyoke history show --workflow e --step 0   # shows "Script step output:" with both lines
```

## Root Cause

`f1d90e360` (feat: migrate prior context output to timeline v2) removed the
`output.response` fallbacks from `CliTerminalFormatter.renderScriptOutput`:

- The `isStreaming` branch used to write each streamed chunk
  (`output.response`) through `writeBoundedScriptChunk`. It now only prints
  the command line and returns, so streamed chunks are dropped.
- The completed branch now takes its text only from the optional third
  argument, `scriptOutput?: ScriptRuntimeOutput`
  (`const outputText = scriptOutput ? getScriptOutputText(scriptOutput) : ""`).

`HistoryInspectionCommands` passes that argument, so `history show` works.
The live caller in `src/cli.ts` (`instance.onTargetScriptOutput`) calls
`renderScriptOutput(data.output, target)` with no third argument. Both the
streamed chunks and the completed output carry the text in
`data.output.scriptOutput` (`ScriptExecutionReporter.execute` sets
`scriptOutput: { command, stdout: sanitizedChunk, stderr: "" }` on each chunk
and the full `scriptOutput` on `finalOutput`). Neither is read.

The unit tests in `src/test/unit/CliDryRunOutput.test.ts` call
`renderScriptOutput` directly and pass the third argument, so they never cover
the `cli.ts` wiring.

## Suggested Fix

- In the `isStreaming` branch, write `output.scriptOutput?.stdout` chunks with
  `writeBoundedScriptChunk`, creating the state and the "… output:" label on
  the first chunk as the code did before `f1d90e360`.
- In `cli.ts`, pass `data.output.scriptOutput` to `renderScriptOutput`. In the
  completed branch, when stdout was already streamed, print only what was not
  streamed (stderr), so stdout is not duplicated. When nothing was streamed,
  print the whole completed text as today.
- Keep the line/char caps and truncation notice behaving as the existing
  `CliDryRunOutput` tests expect.
- Add a test that goes through the live wiring: a CLI integration test
  (`src/test/integration/helpers/cliProcess.ts` `runCli`) that runs a script
  step that writes to both stdout and stderr, and asserts both appear in the
  output exactly once.
