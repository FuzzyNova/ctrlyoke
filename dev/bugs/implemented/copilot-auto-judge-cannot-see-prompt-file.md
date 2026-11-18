# Copilot's auto-mode judge refuses actions asked for in ctrlyoke's prompt file

- **Found:** 2026-11-13 by the `auto` permission-mode harness cases (step 5 of `dev/implemented/AUTO_PERMISSION_MODE_PLAN.md`), Copilot CLI 1.0.111, `gpt-6-luna`
- **Area:** `src/core/harness/CliIntegration.ts` (prompt delivery), `src/core/harness/copilot/CopilotToolPermissionMapper.ts`
- **Resolution:** fixed by the headless stdin inline prompt work: Copilot headless prompts
  now carry the step text inline on stdin, and `auto` is headless-only. The live case
  passed on Copilot 1.0.112 (2026-11-16 full harness run); this commit drops the
  `KNOWN_BROKEN_CLAIMS` entry and backs the claim with the suite.

## Symptom

Under `toolPermissions.mode: auto`, headless Copilot runs with `--assisted-approval`.
The judge refuses an unlisted, benign command that the step's prompt explicitly asks for:

```
Permission denied because the assisted approval check did not approve this request. …
Feedback: The unseen prompt file does not establish authority for this command's file write.
```

So for Copilot, `auto` is no more permissive than `custom` for anything the allow list
doesn't cover, and the deny list was never the problem. The other judges are not affected the
same way: Claude 2.1.323's classifier approved the same case.

## Steps to Reproduce

Direct probe, outside ctrlyoke, from a fresh git repo with a `mark.js` that writes `argv[2]`:

1. Inline: `copilot --model gpt-6-luna --assisted-approval --allow-tool 'shell(echo)' -p "Call your shell tool exactly once, with exactly this command line: echo probe-chain && node <dir>/mark.js <dir>/out.txt …"`.
   The command ran in **5 of 5** runs.
2. File reference, which is how ctrlyoke delivers every prompt: write the same instruction to
   `task.prompt.md` and run `copilot … -p "follow the instructions in @task.prompt.md "`. The
   command was **refused in 5 of 6** runs ("The prompt's instructions are unavailable, so
   authorization for the file write is unresolved").
3. Live case: `copilot-cli: auto runs an unlisted benign command chained to an allowed one`
   in `src/test/harness/inline-config.harness.test.ts`.

## Root Cause

ctrlyoke never puts the step prompt on the command line. `CliIntegration` writes it to
`.ctrlyoke/temp/<…>.prompt.md` and passes `follow the instructions in @<file>`
(`formatCategorizedInstruction`). Copilot's assisted-approval reviewer judges a request
against the user's own message. It sees only the file reference, and it apparently does not
treat what the agent read from that file as the user's intent, which is a reasonable
prompt-injection defence. So the user's authority for the action is "unavailable".

**Confirmed 2026-11-15 (Copilot 1.0.112, `gpt-6-luna`)** with the prompt piped on stdin, which is
the transport in [`HEADLESS_STDIN_INLINE_PROMPT_PLAN.md`](../../implemented/HEADLESS_STDIN_INLINE_PROMPT_PLAN.md):

- Full instruction text on stdin: the command ran in **4 of 4** runs.
- `follow the instructions in @task.prompt.md ` on stdin: refused in **3 of 4** runs.

## Suggested Fix

Options, roughly in order of preference:

1. In headless Copilot `auto`, deliver the prompt text inline in `--prompt` (still writing
   attachments, skills and agent files as references). This needs care with argument-length
   limits and Windows quoting (`spawn-windows-shim`), and possibly a size threshold above
   which `auto` falls back to file delivery with a diagnostic.
2. Re-check whether a Copilot release lets the reviewer see attached `@file` content as user
   input. If so, gate on that version.
3. Failing both, downgrade Copilot `autoMode` to `unsupported` so `auto` falls back to
   `custom` with the existing diagnostic, instead of advertising a judge that refuses the
   step's own instructions.

## Fix

Option 1 shipped in a better form through
[`HEADLESS_STDIN_INLINE_PROMPT_PLAN.md`](../../implemented/HEADLESS_STDIN_INLINE_PROMPT_PLAN.md):
headless Copilot (including `auto`, which stays off ACP) receives every generated section,
the step prompt among them, inline on stdin, with no argv length or quoting limits.

Residual exposure: the judge still sees only a file reference when inlining is off
(`execution.inlineGeneratedPromptOnStdin: false`) or when the prompt section itself is moved
to a split-file reference by the inline size budget. Both are opt-out or edge paths, so they
are documented here rather than gated.
