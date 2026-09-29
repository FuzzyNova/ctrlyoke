# MCP `edit_step` joins `additionalArgs` without quoting, so argument boundaries are lost

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/mcp-server.ts` (`toWorkflowStepUpdates`), `src/utils/CliArgParser.ts`
- **Severity:** medium

## Symptom

`edit_step` takes `additionalArgs` as `string[]`, but the handler stores
`additionalArgs.join(" ")`. Harness providers later split the string with
`parseArgString`, which treats `"`/`'` as quotes and whitespace as a separator.

Reproduced with a temporary test:
`edit_step {index: 2, updates: {additionalArgs: ["--append-system-prompt", "be terse", "it's"]}}`
stores `"--append-system-prompt be terse it's"`, which parses back as
`["--append-system-prompt", "be", "terse", "its"]`. The value is split in two,
and the apostrophe opens an unterminated quote that swallows the character.

## Steps to Reproduce

1. Call MCP `edit_step` on a pending step with an `additionalArgs` element that
   contains a space or quote.
2. Read the step back, or look at the harness argv at spawn.
3. The arguments don't round-trip.

## Root Cause

The array is flattened with a plain `join(" ")` instead of an inverse of
`parseArgString`.

## Suggested Fix

Add `formatArgString(args: string[])` next to `parseArgString` in
`CliArgParser.ts` that quotes (and escapes) any element containing whitespace
or quote characters, so that `parseArgString(formatArgString(a))` deep-equals
`a`. Use it in `toWorkflowStepUpdates`. Check for other `additionalArgs`
`join(" ")` call sites and route them through the same helper. Add a round-trip
unit test and an MCP `edit_step` test.
