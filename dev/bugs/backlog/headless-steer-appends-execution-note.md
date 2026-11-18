# Headless steer messages get the headless execution note appended

- **Found:** 2026-11-17 by Claude (live dashboard steer test)
- **Area:** `src/core/harness/shared/CliPromptPreparer.ts`, `src/core/harness/CliIntegration.ts` (`sendSteerMessage`)
- **Severity:** low

## Symptom

A steer sent to a headless step arrives, and shows in the step's **User message** receipt, as
the user's text followed by "This headless session ends when you end your turn, and any
background commands are stopped with it. Wait for long-running commands in the foreground
before ending your turn." The user did not type that sentence, and the model already received
it with the step's first prompt.

## Steps to Reproduce

1. Run any headless step that takes a while.
2. Send Steer Message with "The secret word is PINEAPPLE."
3. The receipt in the output, and the text the harness receives, end with the note above.

## Root Cause

`CliIntegration.sendSteerMessage` prepares headless steer text through
`CliPromptPreparer.preparePrompt` with the live step's resolved properties. Those keep
`executionMode: headless`, so `CliPromptPreparer` (around line 372) appends
`HEADLESS_EXECUTION_NOTE` to the user prompt section, the same as for a step's first prompt.
The receipt is built from the prepared text.

## Suggested Fix

Let `preparePrompt` take an option to omit the headless note (or a "steer" flag), and pass it
from the headless steer branch. Do not drop `executionMode` from the reduced properties: other
headless preparation (inline generated sections for stdin) depends on it. Keep the receipt
showing the user's text.
