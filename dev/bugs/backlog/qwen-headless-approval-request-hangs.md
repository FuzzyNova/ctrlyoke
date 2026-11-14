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

## Suggested Fix

- Answer `can_use_tool` control requests in headless runs with a deny (ctrlyoke already parses
  Qwen's stream-json output), which keeps the stream-json exemption from the stale alias gate.
- Or drop `--input-format stream-json` and work around the auto-deny alias table in
  `QwenToolPermissionMapper` instead. Re-run the Qwen permission cases either way.
