# `trust-external-roots` commands exit 0 and record nothing when there is no terminal

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; reproduced with the compiled `out/cli.js`)
- **Area:** `src/cli.ts` (`trustExternalRootsCommand`, `trustWorkflowExternalRootsCommand`)
- **Resolution:** fixed in this commit

## Symptom

Without `--yes` and with no terminal on stdin (CI job, `< /dev/null`, a pipe that closes),
`ctrlyoke trust-external-roots` and `ctrlyoke trust-workflow-external-roots <file>` print the
pending roots and the `Trust all N listed folder(s)? [y/N]` question, then exit **0** with no
decision written and no error. A CI step that runs them "passes", the roots stay pending, and
the next `ctrlyoke run` exits 2.

The sibling review commands already fail closed: `trust-workspace-settings` exits 2 with
"no terminal to ask in" (`src/cli/WorkspaceSettingsTrustCommands.ts`, the `!io.isInteractive`
branch), and `trust-secret-grants` uses `confirmMutation`, which declines without a terminal.

## Steps to Reproduce

1. In a temp folder, write `.ctrlyoke/settings.json` with
   `{"permissions":{"trustedExternalRoots":["<tmp>/ext"]}}`.
2. `node out/cli.js trust-external-roots < /dev/null; echo exit=$?`
3. Output ends with `Trust all 1 listed folder(s)? [y/N] exit=0`; the state home holds no
   external-roots decision.

## Root Cause

Both commands call `promptYesNo` (`src/cli/CliPrompt.ts`) unconditionally:

```ts
const approved =
  options.yes ||
  (await promptYesNo(`Trust all ${pendingRoots.length} listed folder(s)? [y/N] `));
```

When stdin is at EOF, `rl.question` never settles; the event loop drains and Node exits 0
before the `setDecisions` call or any `process.exit`. Neither command checks for a terminal
first. Both also pass raw `"allow"`/`"deny"` strings instead of `TRUST_DECISIONS`.

## Suggested Fix

Move both commands onto the shared `CliTrustIo` from `src/cli/CliTrustGate.ts`
(`createCliTrustIo()`), as `trust-workspace-settings` does: with `--yes`, allow; otherwise, if
`!io.isInteractive`, list the roots on stderr with an error naming `--yes` and exit 2; otherwise
ask with `io.confirm`. Use `TRUST_DECISIONS.ALLOW`/`DENY`. Add unit coverage with
`RecordingCliTrustIo` (`src/test/helpers/RecordingCliTrustIo.ts`) for the non-interactive path.
