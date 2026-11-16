# Qwen headless `custom` hangs on a tool call that needs approval

- **Found:** 2026-11-13 by the new `custom` regression case "an allowed command does not allow an unlisted one chained to it" (`src/test/harness/inline-config.harness.test.ts`), Qwen Code 0.27.2
- **Area:** `src/core/harness/qwen/QwenHarnessAdapter.ts` (`buildHeadlessArgs`)
- **Resolution:** fixed in this commit

## Symptom

A headless Qwen step in `custom` mode that calls a tool which no allow rule covers never
finishes. Qwen records the `run_shell_command` call in its chat log and then waits. The step
only ends at ctrlyoke's prompt timeout (1 hour by default), and nothing runs. Headless
`custom` should refuse such a call in-band, as Claude (`dontAsk`), Copilot and agy do.

## Steps to Reproduce

Outside ctrlyoke, from an empty directory with a `mark.js` that writes `argv[2]`:

1. `qwen "Run this shell command once: echo probe && node <dir>/mark.js <dir>/out.txt. If denied, stop." --model qwen3.7-flash --output-format stream-json --input-format stream-json --approval-mode default --allowed-tools 'ShellTool(echo *)' < /dev/null`
   hangs (killed after 120 s).
2. The same command **without** `--input-format stream-json` exits at once with
   `Qwen Code requires permission to use "run_shell_command", but that permission was declined (non-interactive mode cannot prompt for confirmation).`

## Root Cause

`buildHeadlessArgs` passed both a positional prompt and `--input-format stream-json`. Qwen treated
that positional prompt as the first stream-json message, selecting "direct mode" and disabling
the control system (`packages/cli/src/nonInteractive/session.ts:380-412`). No `can_use_tool`
request was written. The tool waited in `awaiting_approval` with no confirm handler, and after
stdin EOF the session waited for it without a timeout (`session.ts:931-938`). A probe showed
stdout ending at the `tool_use`.

Opening the session with an `initialize` control request selects SDK mode. Qwen then emits
`can_use_tool`, accepts a deny response with a message, and cancels a pending request at stdin
EOF. ctrlyoke now drops the positional prompt, waits for the matching initialize response, sends
the prompt as a `user` message, and denies approval requests in-band. A bounded initialize wait
also fails the step if Qwen never answers.

**Correction (2026-11-15, source + probe on 0.27.1):** The hang was not caused by an unanswered
`can_use_tool` request in the old launch; no such request was sent. The direct-mode transition
from the positional prompt was the cause.

## Suggested Fix

Stage 1 of [`HEADLESS_SESSION_CONTROL_PLAN.md`](../../backlog/HEADLESS_SESSION_CONTROL_PLAN.md):

- Drop the positional prompt and send `initialize` first, then the prompt as a `user` message.
- Answer every `can_use_tool` request with a deny that tells the model why.

That plan also builds headless steering and "ask me" approvals on the same channel. Dropping
`--input-format stream-json` is still possible, but it would lose the auto-deny gate exemption.
