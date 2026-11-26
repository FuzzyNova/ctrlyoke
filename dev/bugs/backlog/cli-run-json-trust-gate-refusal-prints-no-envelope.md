# `run --json` writes nothing to stdout when a pre-run approval is missing

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/cli.ts`, `src/cli/CliTrustGate.ts`
- **Severity:** medium

## Symptom

In CI (no TTY), `ctrlyoke run <file> --json` against a workflow that needs an
unapproved decision (workflow or workspace `trustedExternalRoots`, secret
grants, or workspace settings that run programs) exits `2` with the
explanation on stderr and **an empty stdout**. The docs promise that commands
supporting `--json` write failures to stdout as one JSON object, and that `run`
keeps its run-result error object (`docs/cli/ctrlyoke.md`, "JSON output" and
"JSON errors"). The CI recipe in `docs/cli/ci.md` (`require("./result.json")`)
then fails on an empty file instead of reading `success: false` and the error.
Other early `run` failures (such as a parse error) do print the envelope.

## Steps to Reproduce

```bash
mkdir -p /tmp/ws && cd /tmp/ws
cat > tr.ctrlyoke.yaml <<'EOF'
name: TR
trustedExternalRoots: [/tmp/other]
steps:
  - type: script
    script: echo hi
EOF
node <repo>/out/cli.js run tr.ctrlyoke.yaml --json </dev/null >out.txt 2>err.txt; echo $?
```

Observed: exit `2`, `out.txt` empty, and `err.txt` lists the roots and says to
run `ctrlyoke trust-workflow-external-roots …`. Expected: the same exit code
and stderr text, plus one run-result envelope on stdout with `success: false`
and an `error.message` that names the review command.

## Root Cause

`exitUnlessTrustDecided` (`src/cli.ts:1975-1980`) calls `process.exit(exitCode)`
as soon as `ensureCliTrustDecided` (`src/cli/CliTrustGate.ts:50-72`) refuses.
`ensureCliTrustDecided` writes only to stderr. The workspace-settings gate
(`src/cli.ts:1157-1166`) exits the same way. Every `run`-family gate goes
through one of these, so none of them reaches the JSON reporting path:

- workspace external roots: `src/cli.ts:1152`
- workspace settings: `src/cli.ts:1157-1166`
- workflow roots and secret grants in the preflight: `src/cli.ts:1586`, `:1594`
- the same two in the main path: `src/cli.ts:2117`, `:2129`

## Suggested Fix

Keep the stderr text and the exit code. When `--json` is set, route a refusal
through the same error reporting that early `run` failures already use, so it
prints the run-result envelope (`success: false`, `error.message` naming the
review command). One way is to have the gates throw a typed error carrying the
exit code (or return it) instead of calling `process.exit` directly. Check
that `rerun`/`append`/`continue`, which share these gates, emit their
documented envelopes too. Add CLI tests with `--json` and no TTY for each gate
kind (external roots, secret grants, workspace settings), asserting exit `2`
and a parseable stdout envelope.
