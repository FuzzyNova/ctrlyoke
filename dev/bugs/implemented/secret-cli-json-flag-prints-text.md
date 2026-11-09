# `secret` and `trust-secret-grants` accept `--json` but print text, and most failures emit no JSON

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, reproduced with `node out/cli.js`)
- **Area:** `src/cli/SecretCommands.ts`, `src/cli/SecretCommandDefinitions.ts`
- **Resolution:** fixed in this commit

## Symptom

- `ctrlyoke secret list --json` exits 0 and prints `No declared or managed secrets found.`
- `ctrlyoke secret check a.ctrlyoke.yaml --json` prints `✓ a.ctrlyoke.yaml: all declared secrets are resolvable.`
- `secret rm FOO --json` prints `Dry run only; ...`; `trust-secret-grants a.ctrlyoke.yaml --json`
  prints `No pending secret grants ...`.
- Failures: with a script step declaring `secrets: [CYHUNT_MISSING_KEY]`,
  `secret check sec.ctrlyoke.yaml --json` exits 2 with **empty stdout** and plain text
  `Secret check failed: ...` on stderr. `secret check --json` with no file does the same.
  `trust-secret-grants sec.ctrlyoke.yaml --json` without a TTY prints the text grant list on
  stdout, then exits 2 with a plain stderr error.

Expected: the option help says "Emit one versioned JSON result line", and `docs/cli/ctrlyoke.md`
("JSON errors") says failures under `--json` print `{ schemaVersion: 1, success: false, error: { message } }`
on stdout.

## Steps to Reproduce

Run the commands above from a scratch workspace (script-only workflow, no harness needed).

## Root Cause

f88a8bf97 added `--json` so `handleSecretCommand` → `reportCliError` could format thrown errors.
Most secret failures don't throw: `checkSecretsCommand` and `trustSecretGrantsCommand` call
`io.writeErr(...)` and return 1/2, which never reaches the reporter, and every success path writes
text via `io.writeOut` without checking `options.json`.

## Suggested Fix

Thread `json` into each secret subcommand and `trust-secret-grants`. Emit one success envelope
per command (`{ schemaVersion: 1, success: true, ... }` with the command's data, e.g. the listed
entries, the check's missing names), and route returned-code failure paths through the shared
JSON error envelope while keeping their exit codes. Follow the existing envelope helpers other
commands use (see how `history` was fixed in 48e4c4cc8/8b89970e5). Additive within
`schemaVersion: 1`; add a CHANGELOG line. Tests: `src/test/unit/SecretCommands.test.ts` and/or
`src/test/unit/CliErrorContract.test.ts`.
