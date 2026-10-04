---
name: ctrlyoke-syntax
description: ctrlyoke's inline reference syntax (@file, #selection, #sym, ~commit, $step, /skill, /mcp, !SECRET, $endCondition). Use when writing a prompt or workflow step that ctrlyoke will run, and when citing files, line ranges, symbols, or commits in a reply shown in ctrlyoke's output pane.
---

# ctrlyoke reference syntax

ctrlyoke recognizes a small set of inline reference tokens. They do two jobs:

- In a **reply** you write, ctrlyoke's output pane turns them into links the user can click.
- In a **prompt** ctrlyoke runs, they attach context before the prompt reaches the AI.

## Citing things in your reply

When you summarize work, cite what you touched with these tokens instead of plain prose. Each one renders as a link (or a compact chip) that opens the exact target:

| To cite                    | Write                                        |
| -------------------------- | -------------------------------------------- |
| A file                     | `@src/auth/login.ts`                         |
| A directory                | `@src/auth/`                                 |
| A line range               | `#selection:src/auth/login.ts:42-57`         |
| A symbol (its line range)  | `#sym:src/auth/login.ts:validateToken:42-57` |
| A commit (7–40 hex chars)  | `~3f9c2a1`                                   |
| Uncommitted/staged changes | `~diff`, `~staged`                           |
| An earlier step's output   | `$step:2`, `$previous`, `$previous:3`        |

For example: "I fixed the expiry check in #sym:src/auth/login.ts:validateToken:42-57, which ~3f9c2a1 broke, and added a case to @src/auth/login.test.ts."

- Use workspace-relative paths with forward slashes. Quote a path that contains spaces: `@"docs/release notes.md"`.
- Write tokens as plain text. In a reply, text inside backticks or a code block is shown literally and is not linked, which is how you show the syntax itself.
- A token ends at whitespace or punctuation (`,` `.` `)` `;`). Do not glue letters or digits onto one: `~3f9c2a1x` is not a commit reference.
- A slash reference can begin at the start of the text or after whitespace and punctuation such as an opening parenthesis or quotation mark. It cannot follow a filename character, slash, dot, or colon, which keeps URL and path segments literal.
- Use real line numbers from the current file; the link opens exactly the range you write.

## Writing prompts ctrlyoke will run

| Token                          | What the AI receives                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@src/app.ts`                  | The file path; the AI reads the file from disk.                                                                                                                                                                    |
| `@src/components/`             | A tree listing of the directory (names only, no contents).                                                                                                                                                         |
| `#selection:src/app.ts:10-25`  | Lines 10–25 embedded with their line numbers.                                                                                                                                                                      |
| `#sym:src/app.ts:main:10-25`   | Lines 10–25 embedded, labelled with the symbol name. The range is what counts, so it goes stale if the file changes.                                                                                               |
| `~diff` / `~staged`            | Working-tree (with untracked file names) / staged diff.                                                                                                                                                            |
| `~stash:0` / `~3f9c2a1`        | That stash entry's diff / that commit's diff.                                                                                                                                                                      |
| `$previous`                    | Output of the most recent earlier step that produced any.                                                                                                                                                          |
| `$previous:3`                  | Output of the last 3 earlier steps that produced any, oldest first; counted back from this prompt, so it stays correct when steps move.                                                                            |
| `$all` / `$step:1,3-5`         | Output of every earlier step / of steps 1, 3, 4 and 5 (1-based; only earlier steps).                                                                                                                               |
| `$finalStep` / `$allFinalStep` | Output of the latest / every `finalStep` loop pass.                                                                                                                                                                |
| `$preCondition:stdout`         | Replaced in place by that script output. Fields: `stdout`, `stderr`, `exitCode`, `expected`, `actual`, `compareSource`. Works in step and retry prompts.                                                           |
| `$endCondition:stderr`         | Same fields, for the end-condition script. Only available in a `retryPrompt`.                                                                                                                                      |
| `/skill:commit`                | Attaches that skill, as if listed under `skills:`.                                                                                                                                                                 |
| `/mcp:ctrlyoke`                | Enables that registered MCP server for the step.                                                                                                                                                                   |
| `!API_TOKEN`                   | Grants the step the managed secret `API_TOKEN` as an environment variable. The value never appears in the prompt. Names are uppercase. A grant not yet approved for the workspace stops the workflow at that step. |

Path rules for file, directory, line-range and symbol references:

- Paths are workspace-relative. `./` and `../` resolve from the workflow file's own folder. In a multi-root workspace, start the path with the folder name (`@backend/src/app.ts`).
- A path outside the workspace is blocked, and the reference is reported as skipped.
- Trailing punctuation after an unquoted file path is ignored: "see @src/app.ts." attaches `src/app.ts`.

Writing about the syntax without triggering it:

- Inline code (single backticks) and fenced code blocks both keep tokens literal, so wrap a token in backticks to write about it without triggering it.
- A secret grant written in plain prompt text is real. A grant not yet approved for the workspace stops the workflow when that step starts.
- A token directly after a letter, digit, or filename character is not a reference (`price$previous`, `user@example.com`).
- Slash references are recognized only at a word start, outside URL and path segments.
