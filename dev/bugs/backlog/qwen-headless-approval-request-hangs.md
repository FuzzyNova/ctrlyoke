# Qwen headless `custom` hangs on a tool call that needs approval

- **Found:** 2026-11-13 by the new `custom` regression case "an allowed command does not allow an unlisted one chained to it" (`src/test/harness/inline-config.harness.test.ts`), Qwen Code 0.27.2
- **Area:** `src/core/harness/qwen/QwenHarnessAdapter.ts` (`buildHeadlessArgs`)
- **Severity:** high

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

`buildHeadlessArgs` always passes `--input-format stream-json`. Its comment says this exempts the
run from Qwen's non-interactive auto-deny gate (which wrongly force-denies some allowed tools
such as `write_file`), and that stdin being `/dev/null` makes the session drain and exit. But with
stream-json input, Qwen asks for approval through a `can_use_tool` control request and waits for
the reply even after stdin reaches EOF. ctrlyoke never answers, so the turn never ends. The
existing Qwen "deny blocks" case passes only because `--exclude-tools` removes the tool, so no
approval is ever requested.

`auto` mode is not affected for benign commands (the judge decides in-band), but a command the
judge escalates to manual approval may hang the same way.

**Correction (2026-11-15, source + probe on 0.27.1):** no `can_use_tool` request is ever written
in this launch. The positional prompt becomes the first stream-json message, which puts Qwen in
"direct mode" with its control system off (`packages/cli/src/nonInteractive/session.ts:380-412`).
The tool then waits in `awaiting_approval` with no confirm handler, and after stdin EOF the session
waits for it with no timeout. A probe showed stdout ending at the `tool_use`. If the session is
opened with an `initialize` control request instead, the request arrives, allow and deny both work,
and stdin EOF cancels a pending request.

## Suggested Fix

Stage 1 of [`HEADLESS_SESSION_CONTROL_PLAN.md`](../../backlog/HEADLESS_SESSION_CONTROL_PLAN.md):

- Drop the positional prompt and send `initialize` first, then the prompt as a `user` message.
- Answer every `can_use_tool` request with a deny that tells the model why.

That plan also builds headless steering and "ask me" approvals on the same channel. Dropping
`--input-format stream-json` is still possible, but it would lose the auto-deny gate exemption.
