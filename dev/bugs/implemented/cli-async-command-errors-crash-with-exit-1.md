# `ctrlyoke server` startup errors crash with a raw stack trace and exit 1 instead of 2

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with the built CLI)
- **Area:** `src/cli.ts` (`program.parse()`), `src/cli/ServerCommand.ts`
- **Resolution:** fixed in this commit

## Symptom

- `ctrlyoke server --port abc` (or `--port 99999`) prints an uncaught
  `Error: --port must be an integer between 0 and 65535.` with a Node stack trace
  and exits **1**.
- With the port already taken, `ctrlyoke server --port 48123 --strict-port`
  prints the raw `node:net … EADDRINUSE` trace and exits **1**.

The CLI docs' exit-code table says 1 means the workflow failed and 2 means a
usage, parse or unexpected error. The other commands (history, step, secret,
run) print a clean red `Error:` line and exit 2.

## Steps to Reproduce

1. `node out/cli.js server --port abc` → stack trace, exit code 1.
2. Hold a port with another process, then
   `node out/cli.js server --port <port> --strict-port` → `EADDRINUSE` stack
   trace, exit code 1.

## Root Cause

`src/cli.ts` calls `program.parse()`, not `parseAsync()`, and the async
`server` action (`serverCommand` in `src/cli/ServerCommand.ts`) has no
try/catch. The `--port` validation throw (`ServerCommand.ts:50`) and the
`listen()` rejection therefore become unhandled promise rejections, and Node
exits 1 with a stack trace. Other async actions without their own catch (`about`,
`trust-external-roots`, `trust-workflow-external-roots`, `commit`) have the same
exposure.

## Suggested Fix

Switch to `await program.parseAsync()` with a single top-level catch that prints
`Error: <message>` and exits with `CLI_USAGE_EXIT_CODE`. Keep the per-command
handlers that already map their own errors. At minimum, wrap the server action
the same way the history and step handlers are wrapped.

Test: `src/test/unit/ServerCommand.test.ts` (an invalid port and a listen
failure produce a usage-error exit, not an unhandled rejection).
