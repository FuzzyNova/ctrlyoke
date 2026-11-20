# How prompts reach the harness

Before a step runs, ctrlyoke expands the references in its prompt (`@file`, `#selection:`,
`$previous`, agents, skills and so on) and passes the result to the harness. This page explains
what the harness actually receives, and what happens when a prompt gets very large.

**In short, ctrlyoke never truncates or drops your context.** Large content is sent as files,
which the harness reads with its own tools.

## The pieces of a prompt

ctrlyoke sorts what it sends into categories:

| Category            | Comes from                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| Agent instructions  | The step's `agent`                                                         |
| Secrets             | The names (never the values) of the secrets the step is granted            |
| Skills              | The step's `skills` and `/skill:` references                               |
| Prior context       | `priorContext` and inline `$previous`, `$step:N` and `$all` references     |
| Excerpts            | `#selection:`, `#sym:`, directory trees and Git references such as `~diff` |
| Workspace file refs | Plain `@file` references                                                   |
| Prompt              | Your own prompt text                                                       |

Workspace `@file` references are always sent as **paths**. The harness reads the file when it
needs it, so a prompt that names many large files doesn't load them all up front. Every other
category is content ctrlyoke generates, and it is delivered in one of the ways below.

## Short prompts are sent as is

A prompt with no generated content (no agent, skills, secrets, prior context or excerpts) that
is short and safe to pass on a command line goes straight to the harness, unchanged. That holds
when it also names workspace files: the `@file` references are only rewritten into the format
the harness expects.

## Headless steps: generated content in the first message {#headless}

In a [headless](/reference/workflow-schema#execution-properties-executionmode) step, ctrlyoke puts the generated categories directly into the
first message it sends the harness, each in its own labelled block, with your prompt in a
`<userPrompt>` block at the end. Workspace `@file` references still follow as paths. Depending on
the harness, that message goes on stdin or over its control protocol rather than the command
line, so its size isn't limited by command-line length.

Because the content is already in the message, the model starts work immediately instead of
spending a read tool call on each generated file first.

This applies to Claude Code, Copilot CLI, Codex, Qwen Code and Antigravity. OpenCode attaches the
generated files to its first message with its own `--file` option instead, which has the same
effect. To send headless steps file references instead, turn off
[`execution.inlineGeneratedPromptOnStdin`](/reference/settings#execution-inlinegeneratedpromptonstdin).

### The size budget

The inlined content is limited to **400,000 characters** (about 100,000 tokens). If a prompt goes
over that, ctrlyoke moves whole categories out of the message into files, **largest first**,
until the rest fits. Each category that moves is delivered as files, as described in the next
section, and the message ends with a sentence naming those files. A category is never split
between the message and files.

For example, a step with a large `$all` reference usually sends its prior context as files
while the agent instructions, skills and prompt stay in the message. If even your prompt text is
too large, it moves to files too, and the message is just the reference sentence.

## Interactive steps: files and references {#files}

Interactive steps always use files, because a harness's terminal UI can't receive a prompt on
stdin. The same applies to headless steps when the setting above is off, and to any category that
goes over the headless budget.

ctrlyoke writes each category to its own file in `.ctrlyoke/temp/` and sends a short instruction
that names them in order, ending with the prompt:

```text
Following these agent instructions @agent.md,
using these available skills @skills.md,
using these file references @src/foo.ts, @src/bar.ts,
with this prior conversation context @context.1.md, @context.2.md,
and these attachment excerpts @excerpts.md,
follow the instructions in @prompt.md
```

Categories that aren't needed are left out. The exact reference format depends on the harness:
some get absolute paths, and Claude Code's terminal UI reads the files into the message itself.

### Large categories are split into numbered files

Harness read tools cap how much of a file they return in one call. To stay under those caps,
ctrlyoke splits any category over about 10,000 tokens or 1,800 lines into numbered files
(`context.1.md`, `context.2.md`, …), and the model reads each of them. Splits fall on natural
boundaries:

- Prior context is split between steps, so each step's output stays together. One step whose
  output is over the limit by itself becomes a single larger file, which the model reads in parts
  with its own tools.
- Excerpts are split between attachments, so each excerpt stays whole where it fits.
- Other text is split between paragraphs, then lines. A single very long line is cut into
  pieces, each piece after the first starting with a `[... continued ...]` marker.

Splitting never removes content, and there is no limit on the number of files.

## Is there a maximum prompt size?

Not one that ctrlyoke enforces on your content. The 400,000-character budget only decides what
goes in the first message and what goes in files. The real limit is the model's context window:
a prompt whose total content is larger than the model can hold will fail or be compacted by the
harness however it is delivered, so keep very large context to what the step needs. Prefer
`#selection:` or `#sym:` over a whole large file, and `$previous` or a `:summary` reference over
`$all`.

## Seeing what will be sent

The **Payload** tab of a step in [Dry Run](/guide/dry-run#a-step-s-tabs) lists each part of the
prompt in the order it is sent, with its size, and names the files ctrlyoke will write. Temporary prompt files are deleted when the turn that
used them finishes. To keep them for inspection, turn off
[`execution.autoDeleteTempFiles`](/reference/settings#execution-autodeletetempfiles).
