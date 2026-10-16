# OpenCode headless steps with an image fail: `--file` swallows the prompt

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; argv parse reproduced with OpenCode's option definitions)
- **Area:** `src/core/harness/opencode/OpenCodeCliProvider.ts` (`buildImageAttachmentArgs`, `buildHeadlessArgs`)
- **Severity:** high

## Symptom

Every headless OpenCode step that attaches an image fails. OpenCode exits 1 with
`File not found: <the prompt text>`, or with "You must provide a message".

## Steps to Reproduce

1. Run a headless `opencode-cli` step whose prompt attaches an image, e.g. `shots/diagram.png`.
2. ctrlyoke spawns `opencode run --format json -m <model> --file shots/diagram.png "<prompt>"`.
3. OpenCode defines `file` as `type:"string", array:true` and parses with yargs-parser's
   `greedy-arrays` on. The repo's yargs, given the same option definitions, parses that argv as
   `{"message":[],"file":["shots/diagram.png","<prompt>"]}`. The `--file=path` form is just as
   greedy.

## Root Cause

`buildImageAttachmentArgs` (`OpenCodeCliProvider.ts:534`) emits `["--file", path]`, and
`ExecutionPlanBuilder.ts:149-155` places those in `baseArgs`. For OpenCode only the permission args
follow, and they are always `[]` (`OpenCodeCliProvider.ts:665`). `buildHeadlessArgs`
(`:471-472`) then appends the prompt last, directly after the greedy array option.
`src/test/unit/ExecutionPlanBuilder.test.ts:155` asserts this broken order.

## Suggested Fix

Put the positional prompt before the array flags (`run "<prompt>" --format json … --file x`),
which parsed correctly in the same probe. If prompt-first is awkward in the shared builder, have
OpenCode's `buildHeadlessArgs` move the `--file` pairs after the prompt. Update the test at
`ExecutionPlanBuilder.test.ts:155` to assert that the prompt comes before the first `--file`.

Codex's `--image` (`CodexCliProvider.ts:769`) may have the same problem when permission mode is
`none`. That hasn't been verified against Codex's clap definition. Check it while fixing this.
