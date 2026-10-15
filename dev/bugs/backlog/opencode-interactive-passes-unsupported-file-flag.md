# OpenCode interactive mode passes `--file` image attachments to the TUI, which has no `--file` option

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/opencode/OpenCodeCliProvider.ts`
- **Severity:** medium

## Symptom

When an OpenCode step runs in interactive (TUI) mode and its prompt references an image, ctrlyoke launches `opencode --prompt <text> -m <model> --file <image>`. OpenCode's default TUI command has no `--file` option, so the image never reaches the model as an attachment. Depending on how OpenCode configures yargs, the flag is either silently ignored or the launch fails with an `Unknown argument` error. No compatibility warning is shown, because OpenCode image input is declared exact/native for every mode.

## Steps to Reproduce

1. Create a workflow step with `harness: opencode-cli`, `executionMode: interactive`, and a prompt that references an image, e.g. `Describe @shots/screen.png`.
2. Run the workflow. `CliPromptPreparer` resolves `imageFileRefs = ["shots/screen.png"]`.
3. `ExecutionPlanBuilder.plan` appends the `buildImageAttachmentArgs` output (`--file shots/screen.png`) to the base args. `planCliArgs` omits the `run` subcommand because `isInteractive` is true.
4. `buildInteractiveArgs` produces `opencode --prompt <text> -m provider/model --file shots/screen.png`.
5. Observe that the TUI either starts without the image attached (the model sees only the path text) or exits with a yargs `Unknown argument: file` error. No `IMAGE_INPUT_*` compatibility diagnostic is reported.

## Root Cause

- `src/core/harness/opencode/OpenCodeCliProvider.ts:518-520`: `buildImageAttachmentArgs` returns `--file <path>` pairs regardless of execution mode.
- `src/core/harness/shared/ExecutionPlanBuilder.ts:143-150`: the builder calls it for both interactive and headless plans and does not pass the mode, although it computes `isInteractive` at line 105.
- In interactive mode the args go to OpenCode's default TUI command. The `run` subcommand is only added for headless runs (`OpenCodeCliProvider.ts:368-373`), and `buildInteractiveArgs` (`OpenCodeCliProvider.ts:478-498`) only prepends `--prompt`. The TUI command does not accept `--file` (its help in `src/test/fixtures/harness-help/opencode-cli.txt` lists `--prompt`, `-m`, `-s` and others, but not `--file`). Only `opencode run` accepts it.
- `OPENCODE_IMAGE_INPUT_CAPABILITY` (`OpenCodeCliProvider.ts:94-103`, wired in at line 179) declares fidelity `exact`, mechanism `native`, with no mode caveat, so `analyzeConfiguredImageInputs` in `src/types/CompatibilityAnalyzer.ts:253-279` never warns.
- The unit test at `src/test/unit/OpenCodeCliProvider.test.ts:985-990` checks only the arg shape and does not cover interactive mode.

## Suggested Fix

- Make image attachment depend on the execution mode. One option: add an `isInteractive` parameter to `ICliProvider.buildImageAttachmentArgs` and pass it from `ExecutionPlanBuilder`, which already computes the value. OpenCode would return `[]` in interactive mode and leave the image path in the prompt text so the model can read the file with its own tool. The other option: have OpenCode's `planCliArgs` add image args itself, only for headless runs.
- Either way, report image fidelity per mode (e.g. `partial` with a caveat for interactive) so `analyzeConfiguredImageInputs` warns, then regenerate `docs/harnesses/compatibility.md`.
- Add a unit test confirming that interactive OpenCode plans contain no `--file`.
- Check Codex for the same problem. Its interactive CLI accepts `-i`, so it is probably unaffected.
