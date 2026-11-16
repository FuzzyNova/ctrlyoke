# Headless Stdin Inline Prompt Delivery

**Status:** Implemented for this plan's current scope: Qwen, Copilot, Codex and Antigravity are opted in, with unit coverage for their prompt plans, arguments and echo handling. Confirmed live on 2026-11-15 by the full `npm run test:harness` run: new and resumed headless steps ("headless: image input reaches the model and the next step resumes", multi-step and end-condition cases) pass on all four over stdin. Claude is deferred to session-control Stage 2. Researched 2026-11-10 against vendor sources and installed CLIs. Open questions resolved 2026-11-15 (see "Decisions").
**Priority:** P2
**Depends on:** Stage 1 of
[`HEADLESS_SESSION_CONTROL_PLAN.md`](HEADLESS_SESSION_CONTROL_PLAN.md), which
builds the writable-stdin transport. Implement that first; this plan then only
decides _what text_ the first user message carries.

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
  output. The earlier note "do not add `--input-format stream-json`" is
  superseded: the session-control channel needs stream-json input.
- Plain-text stdin is merged into the same string as an argv prompt before any
  other processing, so `@path` references in it should still be expanded
  (inferred). **Whether `@path` is expanded in a stream-json `user` message is
  unknown** (Agent SDK messages may skip it). If it is not, moving Claude onto
  the control channel without inlining would silently turn today's free
  `@path` reads into Read tool calls. Probe this first (see "Decisions").
- 10 MB stdin cap: the CLI exits with "piped stdin input exceeds 10MB". If no
  data arrives within 3 s it proceeds without stdin; ctrlyoke writes and closes
  stdin immediately, so this does not apply.
- **Benefit is smaller here** while Claude stays on argv: it already inlines
  `@path` files without a tool call. Once Claude moves to the control channel
  (session-control Stage 2), inlining becomes the default way to keep that
  benefit unless the probe shows `@path` still expands in stream-json.

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
  message, so OpenCode already gets most of this proposal's benefit.
  **Decision:** keep `--file` and do not opt OpenCode in. It already avoids the
  tool calls, and inlining would only change a path that works.

### Qwen Code (0.27.1, source in `C:\dev\qwen-code`)

- Keep `--output-format stream-json --input-format stream-json`. The
  non-interactive auto-deny exemption is keyed on the input format only, so
  text-mode stdin would lose it (and text mode is capped at 8 MB).
- The positional prompt is dropped by session-control Stage 1, which opens the
  session with `initialize` and sends the prompt as a `user` message
  (`{"type":"user","session_id":"<any>","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null}`).
  This plan only changes that message's text. The earlier "write one line and
  close stdin" form is superseded: it is direct mode, which is what hangs.
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

## Scope of this round (2026-11-15)

- **Claude is not opted in here.** It keeps today's argv prompt and free `@path` reads until
  session-control Stage 2 moves it onto stream-json input; whether it inlines is decided there by
  the `@path` probe. Step 4's "Claude: drop the prompt" applies only then.
- **Opted in now:** Qwen (first message on the control channel) and Copilot, Codex and
  agy (`STDIN` delivery). Codex uses `exec -` / `exec resume <id> -`; agy drops
  `--print <prompt>` so stdin selects print mode. OpenCode stays on `--file`.
- **The setting controls content, not transport.** Moving Copilot, Codex and agy to stdin is
  unconditional, so their args do not fork on a setting. With the setting off, the stdin text
  is today's `follow the instructions in @…` sentence.

## Implementation sketch

1. [x] **Prompt planning.** In `CliPromptPreparer.createCategorizedPromptPlan`,
       when the provider opts in and the execution is headless, build the inline
       prompt text instead of temp-file references. Keep writing the temp files
       only for the fallback path. Workspace file refs still go through
       `formatDirectFileRef`. Dry Run's prompt preview must show the same thing.
2. [x] **Provider opt-in.** A provider flag (for example
       `inlinesGeneratedPromptOnStdin`). Transport by harness:
   - With a headless control channel (Qwen after session-control Stage 1,
     Claude after Stage 2, agy after Stage 4, Codex after Stage 5): the inline
     text is the channel's first `sendUserMessage`. No new transport.
   - Without one yet (Copilot, and Codex/agy if this lands before their
     stages): `headlessPromptDelivery: STDIN`, which `CliTransportCoordinator`
     already writes to stdin and closes. These per-harness arg changes (step 4)
     are interim and are replaced when that harness gets its channel.
3. [x] **No separate stdin encoding hook.** The control channel already owns each
       harness's envelope (Qwen and Claude `user` lines, agy `{"event":"user",…}`).
       Plain-stdin harnesses send the text as is.
4. [x] **Per-provider args for this round.** Qwen already drops its positional
       prompt for the control channel. Copilot now drops `--prompt <text>`, relies
       on piped stdin for prompt mode, and clears `COPILOT_PROMPT_TURN_DELIMITER`.
       Codex and agy use plain stdin until their session-control stages replace
       this transport; Claude remains deferred to Stage 2.
5. [x] **Escaping.** Inlined content must not trigger harness syntax. Escape `@`
       for Qwen, and avoid a leading `/` for Qwen and agy. Copilot will tag any
       `@token` that resolves to a real path, which is harmless except for images.
6. [x] **Echoed prompt.** `BaseLogParser` normalizes the echoed user prompt as
       `follow instructions in @…`. With inlining, each harness echoes the full
       content as the first user message. Wrap the whole inlined text in one
       ctrlyoke root block and have the parser recognize that wrapper, showing only
       the user's own prompt section in the output pane. The `events.jsonl` prompt
       record keeps ctrlyoke's own prompt text, not the echo, so nothing is stored
       twice.
7. [x] **Setting.** An opt-out setting, default **on** (decided 2026-11-15). Record
       it under **Changed** in `CHANGELOG.md` in the commit that ships it.
8. **Tests.** Unit tests cover each adapter's args/env and a prompt-plan path
   per harness. Live cases remain to confirm vendor stdin behavior; run these
   manually (do not use the paid `npm run test:harness` gate for this change):
   - **Qwen:** run a headless step with generated agent/skill content containing
     a literal `@name`, a workspace `@file` reference, and a prompt starting
     with `/`; confirm generated content is not expanded as a mention, the
     workspace file is read, and the echoed first user message matches only
     the user's prompt section in step output. Repeat in a resumed session to
     confirm the control-channel first message is accepted (inferred).
   - **Copilot:** run a headless step with generated agent/skill content and a
     workspace `@file` reference; confirm stdin is processed as one turn,
     generated sections are available immediately, and output parsing does not
     expose generated context as user text. Repeat with a parent
     `COPILOT_PROMPT_TURN_DELIMITER` set, and in a resumed session to confirm
     resume-with-stdin works (inferred from piped-stdin behavior).
   - **Codex:** run a new headless step and a resumed headless step with generated
     agent/skill content and a workspace file reference; confirm `exec -` and
     `exec resume <id> -` consume stdin, and the rollout echo shows only the
     user's prompt section. Resume-with-stdin is inferred and needs a live check.
   - **Antigravity:** run a new headless step and a resumed headless step with
     generated agent/skill content, a workspace file reference, and a prompt
     starting with `/`; confirm stdin enters print mode without `--print`, the
     prompt is not treated as a slash command, and output parsing shows only
     the user's prompt section. Resume-with-stdin is inferred and needs a live
     check.
   - For each opted-in harness, set
     `execution.inlineGeneratedPromptOnStdin: false` once and confirm the
     categorized-file fallback still runs.

## Decisions

Resolved 2026-11-15 from the code; the last two are Nathan's calls.

- **Inline budget: one global number.** Every stdin cap found is at least
  1M characters (Claude 10 MB, Codex 1M chars), so the binding limit is the
  model's context, not stdin. Use one constant character budget (start around
  400k characters, about 100k tokens at `ESTIMATED_CHARS_PER_TOKEN`). Add an
  optional per-provider `maxInlinePromptChars` only if a harness turns out to
  need a lower one. Over budget, fall back to split-file references for the
  largest sections first.
- **Resume: inherit today's omission.** `CliPromptPreparer` decides
  `shouldFilterResumeAttachments` and runs `ResumeAttachmentResolver` before
  the prompt is formatted, so the inline path gets the same filtered set for
  free. Do not add a second check. This holds when the earlier step was
  interactive and used file references: the model read that content then.
- **Compaction: not a blocker.** Content the model reads today arrives as a
  tool result, which harnesses truncate (Codex at 10,000 tokens) and prune
  first. User text is not truncated (Codex) or is kept longer, so inlining
  should only help. Check it in one long live run per harness; do not design
  around it.
- **OpenCode: not opted in.** It keeps `--file` (see its section).
- **Codex and Antigravity live stdin behavior:** the CLI findings support the
  chosen forms, but the new adapter paths have not been exercised against live
  harnesses. The live cases above are still required.
- **Claude: probe first.** Before session-control Stage 2 moves Claude to
  stream-json input, send a stream-json `user` message containing an `@path`
  and see whether the file is read in. If it is not, ship Claude's inlining in
  the same commit as its control channel.
- **Default** (Nathan, 2026-11-15): the setting defaults on, with an opt-out.
