# Context references

ctrlyoke prompt files support structured references that help you attach the right project context without pasting everything manually.

## File and directory references

```text
@src/extension.ts
@src/core/
@"path with spaces/file.ts"
```

- `@file` attaches a full file
- `@dir/` attaches the directory's file tree (names only, no file contents)
- paths with spaces are quoted; quoted paths may also name a root-level file without an
  extension, such as `@"Makefile"`
- an unquoted path must contain `/`, `\`, or `.`, so `@workspace` is not treated as a
  reference. An `@` in the middle of a word, path, or URL is not a trigger: email addresses
  such as `name@example.com`, scoped package paths such as `node_modules/@types/node`, and
  URLs such as `https://medium.com/@alice/post` stay plain text. `@` can start a reference
  after whitespace or opening punctuation such as `(` or `"`.

### Image attachments

Use a full-file `@` reference to attach an image to a prompt:

```text
What does this screenshot show? @images/checkout.png
```

ctrlyoke recognizes `.png`, `.jpg`, `.jpeg`, `.gif` and `.webp` image files.
Every harness receives the image as an image input. Codex and headless OpenCode
attach it with a command-line flag; the other harnesses read the referenced
file themselves. The model you select must itself accept images. The
[harness compatibility matrix](/harnesses/compatibility#compatibility-matrix)
lists the versions each harness was verified with.

Pasting an image into the prompt editor accepts PNG, JPEG, GIF and WebP files up
to 15 MB each. That limit applies to pasted images; ctrlyoke does not impose
that same byte limit on an image referenced from a workspace file. A harness
may have its own input limits.

### Where paths resolve

- A plain path such as `@src/app.ts` is relative to the workspace root. In a
  multi-root workspace, a path whose first segment names a workspace folder
  (`@backend/src/app.ts`) resolves inside that folder.
- A path starting with `./` or `../` is relative to the workflow file's own
  directory.
- An absolute path is accepted only when it points inside the workspace or an
  approved external root (see
  [Trusted external folders](/workflows/permissions#trusted-external-roots)).
  References that escape those roots are blocked and reported as skipped.

## Snippet references

```text
#selection:src/cli.ts:45-103
#sym.method:src/core/WorkflowExecutor.ts:runLoop:88-110
#selection:"docs/my notes.md":1-20
```

- `#selection:` attaches a line range (1-based, inclusive)
- a path or symbol name that contains a space or `:` must be double-quoted
- `#sym.<kind>:` attaches a symbol definition using file, symbol name, and a line range; this is the form ctrlyoke inserts. Hand-authored `#sym:` references remain valid and use the generic icon.

## Git references

```text
~diff
~staged
~stash:0
~a1b2c3d4
```

Use these when a prompt should reason over local changes, staged work, a stash entry, or a specific commit:

- `~diff` attaches unstaged working-tree changes (`git diff`)
- `~staged` attaches staged changes (`git diff --cached`)
- `~stash:N` attaches stash entry `N`
- `~<hash>` attaches a commit's diff. The hash must be 7 to 40 hexadecimal characters.

## Prior output references

```text
$previous
$previous:3
$all
$finalStep
$allFinalStep
$step:1,3-5
```

These let a prompt pull prior ctrlyoke output into the prompt text:

- `$previous` pulls in the most recent earlier step that produced output, and `$all` pulls in every earlier queue step
- `$previous:3` pulls in the last 3 earlier steps that produced output, oldest first. It counts back from the prompt it is written in, so it keeps meaning "the last 3" when steps are added or reordered, and it includes fewer if fewer exist
- `$finalStep` pulls in the most recent `finalStep` pass output, and `$allFinalStep` pulls in every earlier `finalStep` pass output
- `$step:1,3-5` pulls in specific steps by their 1-based step number

They are the inline form of the `priorContext` step property
(`previous`, `{ previous: 3 }`, `all`, `finalStepPrevious`, `finalStepAll`, or an
array such as `[1, 3]`).

Prior output is rendered from the step's structured event history. The full form includes the
authored prompt, text and thinking, file edits and creations with their diffs, deletions,
commands with their output, file reads as path and line range, tool calls and results, web search
results, questions and answers, user steering, and earlier attempts. Command output is
tail-truncated to keep large logs bounded. File reads include only the path and line range, never
the captured file contents. Failed file operations are marked as failed and do not include a diff.

A script step's output includes its pass/fail verdict; see
[Using script output in later prompts](/workflows/script-steps#using-script-output-in-later-prompts).

Add `:summary` after the kind of any selector, before its arguments, to request a deterministic
excerpt: `$previous:summary`, `$previous:summary:3`, `$all:summary`,
`$finalStep:summary`, `$allFinalStep:summary`, or `$step:summary:1,3-5`.
The excerpt contains the first 8 KB of the authored prompt, the changed files, and the last
16 KB of the step's text; a script step keeps its command head and the last 4 KB of its output.
It does not call an AI model. All the summary steps in one prompt share a budget of 400 KB
(about 100k tokens). Past that, the earliest summary steps are left out whole and rendered as an
empty `<step … omitted="all"/>` element that keeps their number and name, and the latest summary
step is always kept. Steps referenced in full detail don't count toward this budget. Use it for hand-offs and commit-style prompts
where the full transcript would add noise. Keep the full form for review work
that needs diffs, commands, or tool-call details.

The workflow or prompt property `priorContextDetail: summary` applies the same
detail level to its `priorContext` selectors; the default is `full`. An inline
`:summary` selector requests summary for that reference even when the property
uses the full form.

## Output from another workflow

`priorContext` can also import every step's output from a completed run of
another workflow in the same workspace:

```yaml
steps:
  - prompt: Review the fixes from the last bug sweep.
    priorContext:
      workflow: bug-sweep
  - prompt: Compare against the sweep before that one.
    priorContext:
      workflow: bug-sweep
      run: 12
```

`workflow` takes the workflow's name or its workflow key. To get the key,
right-click the workflow in the workflow list and choose **Copy Workflow Key**.
A name is matched without regard to case, and if more than one workflow has
that name, the step fails, so use the key to be exact. Leave out `run` to use
the workflow's latest completed run, which moves on as new runs complete. Set
`run` to a run number from the run list to pin one run. A run pinned this way
cannot be deleted while a workflow still references it.

In the properties panel, choose **Completed run output** under **Prior
Context** and fill in the same two fields.

## Context at a parallel boundary

For a member of a parallel group, `previous` and `all` are evaluated at the
group's pre-execution boundary. They include output from completed steps before
the group and never include a sibling's partial or terminal output. Numeric
prior-context references use the same boundary: a member may reference an
earlier step before the group, but cannot reference another member in the same
group. After the join, the following step can use numeric references to the
flattened member step numbers (for example, `priorContext: [2, 3, 4]`) to
consume the settled group output.

## Other prompt tokens

The same prompt text also recognizes:

- `/skill:<name>`, which attaches a skill (see [Agents and skills](/workflows/agents-and-skills))
- `/mcp:<server-id>`, which force-attaches a managed MCP server
- `!NAME`, which grants the secret environment variable `NAME` to the step
- `$preCondition:<field>` and `$endCondition:<field>` for condition output (see [End conditions](/workflows/end-conditions))
- <code v-pre>{{name}}</code> for workflow `vars`

If a reference cannot be resolved, ctrlyoke warns and runs the step anyway by
default. Set `execution.contextResolutionFailure` to `fail` to stop the step
instead.

## Writing references literally

References inside inline code (single backticks) or a fenced code block are
not expanded. Wrap a token in backticks to write about it, and use a fence when
you paste logs, examples, or earlier ctrlyoke instructions that contain `@`,
`#`, `~`, `$`, `!`, or `/skill:` text.

A fence starts with three or more backticks or tildes at a CommonMark line
boundary, including on a list marker line or inside a list item or blockquote.
Its closer uses the same character, has at least as many marks, and contains
only trailing whitespace. A closer with an info string does not close the
fence. The fence ends with its list or blockquote container. An unclosed fence
stays live until it has a closer, so references inside it can still expand
while the prompt is being written; a later closed fence is still recognized.
Inline code can cross one line break within a paragraph; a blank line, new list
item or heading ends the paragraph. Its closing run must have the same number
of backticks as its opener. Backslashes do not escape delimiters inside code.
An unmatched backtick run is plain text and does not hide anything after it.

A secret grant written in plain prompt text is real. A grant not yet approved
for the workspace stops the workflow when that step starts.

Workflow <code v-pre>{{name}}</code> placeholders are the exception: they are
substituted inside inline code too, because the same substitution runs on
script text, where backticks are shell command substitution. Only a fenced
block keeps a placeholder literal.

## References in replies

The output pane recognizes the same syntax in an AI reply. When a response
cites `@src/auth/login.ts`, a `#selection:` or `#sym:` range, a `~<commit>`,
or a `$step:` reference, it renders as a link that opens the target, exactly as
in an echoed prompt. Attach the bundled `ctrlyoke-syntax` skill to a step to
teach the AI to cite its work this way; every bundled agent already includes it.

## How context reaches CLI harnesses

The references you write are expanded before the step runs. Headless steps put the generated
content (agent instructions, skills, prior context and excerpts) in the harness's first message.
Interactive steps write it to files in `.ctrlyoke/temp/` and send the harness a short instruction
that names them. Workspace `@file` references always stay paths. Very large content is moved to
numbered files rather than truncated.

See [How prompts reach the harness](/workflows/prompt-delivery) for the details, including size
limits.

## Tips

1. Use `@` for whole files and directories.
2. Use `#selection:` and `#sym.<kind>:` when the full file would be noisy. Hand-authored `#sym:` references remain valid.
3. Prefer prior-output references over repeating large summaries by hand.
