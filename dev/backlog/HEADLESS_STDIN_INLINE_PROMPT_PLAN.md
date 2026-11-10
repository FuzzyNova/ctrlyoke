# Headless Stdin Inline Prompt Delivery

**Status:** Not started. Researched 2026-11-10 against the vendor sources and
installed CLIs listed below; nothing here has been checked with a live run.
**Priority:** P2

## Problem

For a categorized prompt, ctrlyoke writes every generated section (agent
instructions, secrets list, skills index, prior-step context, attachment
excerpts and the prompt itself) to `.ctrlyoke/temp/` files. It then sends a
short instruction that names them (`CliIntegration.formatCategorizedInstruction`):

```
Following these agent instructions <agent.md>, using these available skills
<skills.md>, using these file references src/foo.ts, ..., follow the
instructions in <prompt.md>
```

Only Claude Code reads `@path` references into the first message itself. The
other harnesses get a path, and the model spends one read tool call per file
before it starts the actual work. That costs:

- **Latency and tokens.** Each read is a full model round trip, and the whole
  conversation so far is re-sent each time.
- **Truncation.** Read tools cap their output: Claude's Read at 25k tokens and
  256 KB, Codex keeps 10,000 tokens of a tool output in history, Qwen 25,000
  characters or 1,000 lines, Copilot 30 KB before it falls back to a preview,
  agy a line cap per view. `PromptFileSplitter` splits every generated section
  into numbered chunks (10k tokens, 1,800 lines) only to stay under these caps,
  and the model still has to read every chunk.
- **Qwen's `@path` reading never fires for them.** Qwen's `@path` inlining
  skips git-ignored files, and `.ctrlyoke/temp/` is git-ignored in every
  initialized workspace (`WorkspaceInitializer`). In any git repository the
  model gets the plain path and reads the file with a tool call, like the other
  harnesses.
- **Wrong paths.** Some models resolve a relative temp path against the wrong
  folder and search the disk for it. That is why OpenCode, agy and Qwen force
  absolute references (`requiresAbsoluteFileReferences`); with those, the
  model's read finds the file reliably.

## Proposal

For **headless** runs on harnesses that support it, put the content of every
generated section into the prompt text and deliver the whole prompt on
**stdin**:

- **Generated sections are inlined.** Each one goes in its own labelled block
  (`<agentInstructions>`, the excerpt `<attachment>` blocks, and so on) and is
  not split.
- **Workspace file references stay paths.** Direct `@file` references in the
  workflow name real files the model may only need part of, so they keep the
  harness's current format and the model reads them as it chooses. This keeps
  a prompt with many references from loading every file into context up front.
- **Stdin, not argv.** Inline content quickly passes the Windows command-line
  limit (about 32K characters, less through a `.cmd` shim). Stdin also avoids
  argv quoting problems and greedy array flags swallowing the prompt
  (`moveGreedyOptionArgsAfterPrompt`, Claude's prompt-first ordering).

The context window cost is about the same as today. Every generated section is
content the model is told to read, so the same tokens already arrive, just one
tool call at a time.

### Scope

- **Headless only.** Every harness's TUI needs stdin to be a terminal, and
  terminal reuse pastes text into a running TUI. Interactive steps keep
  today's files and references, so each harness ends up with two prompt shapes
  to test.
- **A size budget with a fallback.** If the inlined total goes over a
  configured limit (well under each harness's stdin cap), fall back to today's
  split-file references for the largest sections, so huge `$all` context never
  fails a step.
- **A setting to turn it off**, at least while it is new. It changes what every
  headless step sends.

### Interactive mode (the default) is not covered

No harness accepts a prompt on piped stdin in its TUI. In a PTY, stdin is the
terminal: it carries keystrokes, so "stdin" there just means typing into the
TUI, which terminal reuse already does with a bracketed paste. Piping stdin
instead either switches the CLI to its headless mode (Copilot, agy, Claude) or
makes it refuse to start (Codex needs a terminal, `cli/src/main.rs`; Qwen's
`-i` exits without one, `llm.tsx:630-634`). So this plan helps only headless
steps. No interactive work is planned. With absolute references the model's
read tool call finds the prompt files reliably in every harness. The
per-harness routes are recorded here for reference:

| Harness  | Interactive route to file contents without a tool call                                                                                                                                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | Already works: `@path` is read in.                                                                                                                                                                                                                                                                                                       |
| Qwen     | `@path` runs in the TUI but skips the git-ignored `.ctrlyoke/temp/`. Both workarounds were rejected: per-run `respectGitIgnore: false` makes Qwen's grep, glob and folder context include ignored files, and moving Qwen's prompt files to Qwen's own temp dir would break the rule that a run's prompt files live in `.ctrlyoke/temp/`. |
| OpenCode | OpenCode 2: a plugin `prompt` hook can add `file://` attachments to every submitted prompt, TUI included (inferred). OpenCode 1: the plugin's `promptAsync` path (resumed sessions) can send `text/plain` file parts.                                                                                                                    |
| Codex    | Only skills (`$name`, `.agents/skills/<name>/SKILL.md`) are read in. Otherwise inline the text in the argv prompt (32K-character limit) or paste it into the TUI.                                                                                                                                                                        |
| Copilot  | `@path` is attached only as path and line count. Inline the text in argv or paste it into the TUI.                                                                                                                                                                                                                                       |
| agy      | No file inlining. Inline the text in argv or paste it into the TUI.                                                                                                                                                                                                                                                                      |

"Paste into the TUI" means sending the first prompt the way terminal reuse
sends later ones. Large pastes collapse into a placeholder that is expanded on
submit in OpenCode and Codex. Qwen wraps pastes over 1,000 characters in
`<clipboard-paste>` and doubles every backslash.

## Per-harness findings

| Harness     | Stdin prompt in headless mode                 | Stdin with a prompt flag too                       | Resume               | Cap                                         |
| ----------- | --------------------------------------------- | -------------------------------------------------- | -------------------- | ------------------------------------------- |
| Claude      | yes: `claude -p` with no positional           | positional + `\n` + stdin                          | inferred yes         | 10 MB (error)                               |
| Copilot     | yes: piped stdio implies prompt mode, no `-p` | `-p` wins, stdin ignored                           | inferred yes         | none found                                  |
| Codex       | yes: `codex exec -`                           | appended as `<stdin>…</stdin>` (new sessions only) | `exec resume <id> -` | 1M chars (app-server; not traced on `exec`) |
| OpenCode    | already in use (`STDIN`)                      | not used                                           | yes                  | none                                        |
| Qwen        | yes: one stream-json user message             | n/a                                                | inferred yes         | none in stream-json                         |
| Antigravity | yes: piped stdin with no `--print`            | flag wins, stdin not read                          | inferred yes         | none found                                  |

### Claude Code (v2.1.322, read from the installed binary and the docs)

- `claude -p` reads plain-text stdin when stdin is not a TTY, joining it to the
  positional prompt with a newline. `--output-format stream-json` only affects
  output. Do **not** add `--input-format stream-json`.
- Stdin is merged into the same string as an argv prompt before any other
  processing, so `@path` references in it should still be expanded (inferred).
- 10 MB stdin cap: the CLI exits with "piped stdin input exceeds 10MB". If no
  data arrives within 3 s it proceeds without stdin; ctrlyoke writes and closes
  stdin immediately, so this does not apply.
- **Benefit is smaller here.** Claude already inlines `@path` files without a
  tool call. Moving it would mainly remove the Read caps and the argv-ordering
  workaround. It is reasonable to leave Claude on `@` references and do it
  last, or never.

### Copilot CLI (1.0.107, read from the bundle, `--help`, the changelog)

- With piped stdio, Copilot enters prompt mode even without `-p` and reads the
  prompt from stdin until EOF. `-p -` is not special and sends a literal `-`.
- `@path` mentions are resolved on the stdin text too, but a text file is
  attached only as a `<tagged_files>` entry with its path and line count, never
  its contents. That is why the model still makes a read call today, and why
  inlining is a real gain for Copilot.
- Clear `COPILOT_PROMPT_TURN_DELIMITER` from the child environment: when it is
  set, Copilot splits stdin into several turns.
- Empty stdin fails with "No prompt provided".

### Codex (`37103d7f01`, source in `C:\dev\codex`)

- Codex never expands anything in prompt text: no `@path`, and the TUI `@`
  picker only inserts a path. Only images, audio and installed skills are read
  from disk.
- Use `codex exec -` (new session) and `codex exec resume <id> -`. Both make
  stdin the whole prompt. The positional-plus-stdin form appends a `<stdin>`
  block but only for new sessions, so `-` is simpler.
- User text is never truncated. History truncation applies only to tool-call
  outputs (`codex-rs/core/src/context_manager/history.rs`, per-model
  `truncation_policy` of 10,000 tokens).
- Today's headless spawn ignores stdin. A spawn that left stdin as an open pipe
  with a positional prompt would block `exec` waiting for EOF.

### OpenCode (OpenCode 2 source; OpenCode 1.3.16 from git history)

- Headless prompts already go on stdin (`headlessPromptDelivery: STDIN`).
- Headless runs now also attach the generated prompt files with `--file`
  (`buildPromptFileAttachmentArgs`). OpenCode reads each one into the first
  message, so OpenCode already gets most of this proposal's benefit. If this
  plan ships, pick one channel for OpenCode: inline text, or keep `--file` and
  skip inlining there.

### Qwen Code (0.27.1, source in `C:\dev\qwen-code`)

- Keep `--output-format stream-json --input-format stream-json`. The
  non-interactive auto-deny exemption is keyed on the input format only, so
  text-mode stdin would lose it (and text mode is capped at 8 MB).
- Drop the positional prompt and write one JSON line, then close stdin:
  `{"type":"user","session_id":"<any>","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null}`.
  That is the same message Qwen builds from the positional prompt, and stdin
  EOF drains the turn exactly as today.
- `@` processing still runs on that text, so any `@token` that matches a real
  path gets inlined, and a read error is fatal. Escape literal `@` in inlined
  content as `\@`, and never start the text with `/` (slash command).
- For headless Qwen this also sidesteps the git-ignore skip, since there is
  nothing left to read from `.ctrlyoke/temp/`. `respectGitIgnore: false` in the
  per-run settings was rejected as the alternative: it applies to the whole
  run, so Qwen's grep would pass `--no-ignore-vcs` and glob, ls and the
  folder-structure context would stop skipping ignored files.

### Antigravity (agy 1.5.4, from the binary, `--help`, docs)

- `--print` needs a value, and a flag prompt means stdin is not read. Piping
  stdin into `agy --output-format stream-json` with no `--print` enters print
  mode and reads the prompt from stdin. That was checked with one empty-stdin
  run, which returned the empty-prompt error without a model call.
- agy never inlines mentioned files ("the agent gets the item's full path and
  reads it when it needs to"), so inlining is a real gain.
- A prompt starting with `/` is treated as a slash command or skill. Pass
  `--disable-slash-commands`, or never start the inlined text with `/`.
- Older versions lost output or hung when stdout was not a terminal (upstream
  issues #76, #318); later changelog entries say pipes are fixed.

## Implementation sketch

1. **Prompt planning.** In `CliPromptPreparer.createCategorizedPromptPlan`,
   when the provider opts in and the execution is headless, build the inline
   prompt text instead of temp-file references. Keep writing the temp files
   only for the fallback path. Workspace file refs still go through
   `formatDirectFileRef`. Dry Run's prompt preview must show the same thing.
2. **Provider opt-in.** A provider flag (for example
   `inlinesGeneratedPromptOnStdin`), reusing `headlessPromptDelivery: STDIN` for
   the transport. `CliTransportCoordinator` already writes `promptArgument` to
   stdin and closes it.
3. **Stdin encoding hook.** Qwen needs the text wrapped in a stream-json user
   message. Add an optional provider hook that turns the prompt text into the
   stdin payload, used by `CliTransportCoordinator`. Every other provider sends
   the text as is.
4. **Per-provider args.**
   - Claude: drop the prompt from `buildHeadlessArgs`.
   - Copilot: drop `--prompt <text>` and clear `COPILOT_PROMPT_TURN_DELIMITER`.
   - Codex: pass `-` in the prompt's place, after `resume <id>` when resuming.
   - Qwen: drop the positional prompt.
   - agy: drop `--print <prompt>`.
5. **Escaping.** Inlined content must not trigger harness syntax. Escape `@`
   for Qwen, and avoid a leading `/` for Qwen and agy. Copilot will tag any
   `@token` that resolves to a real path, which is harmless except for images.
6. **Echoed prompt.** `BaseLogParser` normalizes the echoed user prompt as
   `follow instructions in @…`. With inlining, each harness echoes the full
   content as the first user message, so check the output pane and the
   `events.jsonl` prompt record show something sensible and not the whole
   inlined text twice.
7. **Tests.** Unit tests for the prompt plan and each adapter's args, and one
   live harness case per harness. The resume-with-stdin claims above are all
   inferred and need those live cases to confirm.

## Open questions

- Inline budget: one number, or one per harness derived from its stdin cap and
  the model's context window?
- Should a resumed session that already received the same agent and skills
  content (`shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume`) skip
  inlining them again? It does today for references.
- Does inlining change how harness context compaction treats the content? agy's
  changelog notes compaction no longer cuts a long first instruction to a
  fixed slice; the others are unknown.
