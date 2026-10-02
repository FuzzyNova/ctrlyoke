# Inline prompt starting with a dash is parsed as CLI flags

- **Found:** 2026-10-02 by bug-hunt final step (dry-run across harnesses + live opencode repro)
- **Area:** `src/core/HarnessIntegration.ts` (`isSimplePrompt`)
- **Resolution:** fixed in this commit

## Symptom

A short single-line prompt that starts with `-`, such as `- fix the failing tests`
(a markdown bullet pasted as the whole prompt), is passed to the harness as a
bare argv element. The harness CLI parses it as flags:

- **opencode:** `opencode run --format json -m <model> "- hello world"` prints
  the help text and **exits 0** with empty stderr, because yargs reads the `h`
  as `-h`. ctrlyoke sees a clean exit with no error, so the step **succeeds
  with an empty response** and the model never runs.
- **qwen** (yargs) and **claude** (commander) receive `'- fix the tests'` the
  same way: as an inline positional with no `--` separator. They either
  misparse it as flags or fail with a usage error. Qwen's interactive `-i <text>`
  and opencode's `--prompt <text>` are affected too.

`ctrlyoke run -p "- fix the tests" -H <harness> --dry-run` shows the inline
argument for opencode-cli, claude-cli, and qwen-cli:

```
opencode.cmd "run" "--format" "json" "-m" "opencode/big-pickle" "- fix the tests"
claude.exe '- fix the tests' '-p' '--output-format' 'stream-json' ...
cli-entry.js '- fix the tests' '--output-format' 'stream-json' ...
```

## Steps to Reproduce

1. `ctrlyoke run -p "- hello world" -H opencode-cli -m opencode/big-pickle`
2. Observe: the step completes successfully with no model output. Running the
   logged command directly prints opencode's help and exits 0.

## Root Cause

`HarnessIntegration.isSimplePrompt` (`src/core/HarnessIntegration.ts`, about
line 831) lets short prompts that match `SAFE_CHARS_PATTERN` skip the temp-file
path and go straight into argv. The pattern allows `-` anywhere, including as
the first character. No harness's `buildHeadlessArgs`/`buildInteractiveArgs`
inserts `--` or uses `--flag=value` form, so a leading dash reaches the CLI's
option parser.

## Suggested Fix

Single-source it in `isSimplePrompt`: return `false` when the prompt starts
with `-`, so it takes the existing file-based path, which every harness already
supports. That covers all six harnesses and both headless and interactive
modes without touching each provider's argv builder. Add a Mocha test that
`isSimplePrompt('- fix the tests')` is false while `'fix the - tests'` stays
true, and a dry-run/argv-level test for at least one provider showing the
prompt no longer appears as a bare argv element.
