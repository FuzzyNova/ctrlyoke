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
- paths with spaces are quoted
- an unquoted path must contain `/`, `\`, or `.`, so `@workspace` is not treated as a
  reference. An `@` in the middle of a word is not a trigger, which keeps email addresses such
  as `nathan@gmail.com` from becoming references.

### Where paths resolve

- A plain path such as `@src/app.ts` is relative to the workspace root. In a
  multi-root workspace, a path whose first segment names a workspace folder
  (`@backend/src/app.ts`) resolves inside that folder.
- A path starting with `./` or `../` is relative to the workflow file's own
  directory.
- An absolute path is accepted only when it points inside the workspace or an
  approved external root (see `trustedExternalRoots` in the
  [YAML format](/workflows/yaml-format#workflow-scoped-external-roots)).
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
$all
$finalStep
$allFinalStep
$step:1,3-5
```

These let a prompt pull prior ctrlyoke output into the prompt text:

- `$previous` pulls in the step just before this one, and `$all` pulls in every earlier queue step
- `$finalStep` pulls in the most recent `finalStep` loop output, and `$allFinalStep` pulls in every earlier `finalStep` loop output
- `$step:1,3-5` pulls in specific steps by their 1-based step number

They are the inline form of the `priorContext` step property
(`previous`, `all`, `finalStepPrevious`, `finalStepAll`, or an array such as
`[1, 3]`).

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

References inside a triple-backtick fenced block are not expanded. Use a fence
when you paste logs, examples, or earlier ctrlyoke instructions that contain
`@`, `#`, `~`, `$`, `!`, or `/skill:` text. Single-backtick inline code does
**not** suppress expansion.

## How context reaches CLI harnesses

The reference syntax above is what you author. ctrlyoke also provides a delivery layer underneath it so a complex expanded prompt does not have to become one enormous terminal command or one undifferentiated file.

Simple prompts may be sent directly. When ctrlyoke needs to assemble richer context, it writes temporary files grouped by purpose:

- agent instructions;
- available skills;
- direct workspace file references;
- prior conversation context;
- excerpts expanded from selections, symbols, directories, and Git references;
- the main prompt.

It then sends the harness a short ordered instruction. The exact file-reference syntax is adapted to the active harness, but its conceptual shape is:

```text
Following these agent instructions @agent.1.md,
using these available skills @skills.md,
using these file references @src/foo.ts, @src/bar.ts,
with this prior conversation context @context.md,
and these attachment excerpts @excerpts.1.md,
follow the instructions in @prompt.md
```

Categories that are not needed are omitted. The main prompt is named last so its role remains explicit instead of being buried among supporting material.

Large generated categories are split conservatively by token and line count before delivery. Prior context is split at step boundaries, and complete attachment blocks are kept together where possible. This reduces dependence on shell command-length limits—particularly on Windows—and reduces the risk of hitting known per-file read limits with one oversized generated context file. It does not change the syntax you write, and the temporary files are cleaned up automatically after the turn by default.

## Tips

1. Use `@` for whole files and directories.
2. Use `#selection:` and `#sym.<kind>:` when the full file would be noisy. Hand-authored `#sym:` references remain valid.
3. Prefer prior-output references over repeating large summaries by hand.
