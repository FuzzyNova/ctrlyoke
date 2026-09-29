# `ctrlyoke validate --json` writes log lines and stack traces to stdout

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/cli.ts` (`validateCommand`, `checkSecretsCommand`, `trustSecretGrantsCommand`), `src/utils/Log.ts`
- **Severity:** medium

## Symptom

For a schema-invalid file, `ctrlyoke validate bad.ctrlyoke.yaml --json > out.txt` exits 2 with ~10 lines on stdout — `ctrlyoke [..] ERROR: [PromptFileParser] Failed to parse…`, a stack trace, then the JSON envelope — so `JSON.parse(out.txt)` fails. The envelope's `error` is only `"bad.ctrlyoke.yaml failed validation"` with no schema errors. `secret check <file>` and `trust-secret-grants <file>` leak the same way. Docs (`docs/cli/ctrlyoke.md`, `docs/cli/ci.md`) promise a single JSON line for CI gates.

## Steps to Reproduce

1. Create `bad.ctrlyoke.yaml` containing `steps:\n  - bogus: 1`.
2. `ctrlyoke validate bad.ctrlyoke.yaml --json > out.txt 2> err.txt`.
3. `out.txt` has log lines before the JSON; `err.txt` is empty.

## Root Cause

These commands parse before `Log.initializeCli` is called (it only runs on the compatibility/run path), and the uninitialized logger falls back to `console.log` (`Log.ts`).

## Suggested Fix

Initialize CLI logging (writing to the log file / stderr, never stdout) before parsing in these commands, and include the parser's schema errors in the JSON envelope.
