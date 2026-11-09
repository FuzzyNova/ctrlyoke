# `ctrlyoke run` reports script output as truncated whenever a streamed script also writes stderr

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/cli/CliTerminalFormatter.ts` (`renderScriptOutput`, `writeBoundedScriptChunk`)
- **Resolution:** fixed in this commit

## Symptom

A script step (or condition script) that writes to stdout and also to stderr
prints a truncation notice in `ctrlyoke run`, even though every byte was shown:

```
│ Script step output:
out1
out2

1.019s
err1
err2
│ … script output truncated: 9 more characters (see .ctrlyoke/.runs/…/events.jsonl)
│ ✔ Passed — Script step passed (exit code == 0) → continue
```

The "N more characters" count equals the length of the trimmed stderr. Any
script that prints a warning to stderr (npm, tsc, git and most test runners do)
gets the notice, which tells the user output was dropped and sends them to the
events file for nothing.

## Steps to Reproduce

```sh
R=/tmp/cytrunc; rm -rf $R; mkdir -p $R/ws && cd $R/ws && git init -q
export CTRLYOKE_HOME=$R/home
cat > s.ctrlyoke.yaml <<'EOF'
name: s
steps:
  - type: script
    name: mixed
    script: echo out1; echo err1 1>&2; sleep 1; echo out2; echo err2 1>&2
EOF
ctrlyoke run s.ctrlyoke.yaml --headless
#   … script output truncated: 9 more characters
```

A script that writes only stdout, or only stderr (nothing streamed), prints no
notice.

## Root Cause

`renderScriptOutput` (around lines 916-945), completed branch, after stdout
was streamed:

1. `state.totalChars` is already the streamed stdout length (counted by
   `writeBoundedScriptChunk` while streaming).
2. Line 935 sets `state.totalChars = Math.max(state.totalChars, totalText.length)`
   where `totalText = getScriptOutputText(scriptOutput)` is stdout **and**
   stderr joined, so the total now already includes stderr.
3. Line 937-940 then writes the stderr through `writeBoundedScriptChunk`, which
   adds `chunk.length` to `state.totalChars` again (and to `shownChars` once).
4. Line 941's `Math.max` cannot undo the double count, so
   `omittedChars = totalChars - shownChars` equals the stderr length.

`totalLines` is reassigned (not maxed) after the write, so the line count is
not affected; only the character count is.

The existing test "prints streamed stdout and completed stderr exactly once"
in `src/test/unit/CliDryRunOutput.test.ts` covers this path but does not
assert the absence of the notice.

## Suggested Fix

Compute the totals once, after writing the unstreamed stderr, from what was
actually produced: e.g. write the stderr chunk first and then set
`state.totalChars = Math.max(state.shownChars, totalText.length)` (or simply
don't pre-assign `totalChars` from `totalText` before the stderr write, and
assign it — not `Math.max` with the inflated value — afterwards). Keep the real
truncation path working: the `bounds streamed script output with an explicit
notice` test must still report "40 more lines".

Tests in `src/test/unit/CliDryRunOutput.test.ts`: extend the streamed
stdout + completed stderr case to assert no `script output truncated` notice,
and add a case where streamed stdout exceeds the cap and stderr is present, to
check the notice still counts the truly omitted characters.
