# Commit messages

ctrlyoke can write a commit message for your changes. It sends the diff to a
harness, which returns a [Conventional Commits](https://www.conventionalcommits.org/)
message, and puts the message where you'll commit from. There are three ways
to start it:

- the button in VS Code's **Source Control** view
- the commit box in the browser dashboard's
  [Source Control tab](/guide/source-control#committing)
- the [`ctrlyoke commit`](/cli/ctrlyoke#ctrlyoke-commit) command

All three use the same generator and the same
[settings](#the-commit-message-settings-tab).

## In VS Code

In the **Source Control** view, select **Generate Commit Message with
ctrlyoke** in the view's title bar. With more than one repository, each one has
its own button. The view shows progress while the harness works, and the
message lands in the commit message box. Review it, then commit as usual.

<!-- SHOT D17: VS Code Source Control view with staged changes, the "Generate Commit Message with ctrlyoke" title-bar button replaced by its Cancel button mid-generation, and the Source Control progress bar running. -->

- **Guide the message.** Anything already in the commit message box is passed
  to the harness as instructions or a starting draft. Type "mention the
  migration" and then generate, for example. The generated message replaces it.
- **Cancel.** While a message is being generated, the button turns into
  **Cancel Commit Message Generation**. Select it, or the button again, to
  stop. Cancelling shows no error.
- **Unstaged changes.** When nothing is staged, ctrlyoke uses your unstaged
  changes instead and says "Generated from unstaged changes. Remember to stage
  files before committing."
- **No changes.** With nothing to describe, it says "No changes detected. Stage
  or modify files first." and doesn't start a harness.

## In the browser dashboard

The [Source Control tab](/guide/source-control#committing) of the workspace
viewer has the same generate button beside its commit box, with the same
draft-as-instructions behavior.

## From the command line

```bash
ctrlyoke commit                                   # generate, confirm, commit
ctrlyoke commit --hint "mention the migration" --yes
git commit -m "$(ctrlyoke commit --print-only)"    # just print the message
```

`--all` stages every change, including untracked files, before committing.
Without it, the CLI only commits what is staged. `--model` overrides the model
for this run. The [`commit` command reference](/cli/ctrlyoke#ctrlyoke-commit)
lists every flag and exit code.

## Which changes it reads

1. **Staged changes**, when there are any (`git diff --cached`).
2. Otherwise, **unstaged changes** to tracked files, plus the contents of new
   untracked files that aren't ignored. A binary file appears as a one-line
   "Binary file added" entry.

The diff sent to the harness is capped at 750 KB. A larger diff is cut off,
and ctrlyoke warns that the message may be incomplete. Stage a smaller set of
files for a better message.

The harness reads only the diff and your instructions. The run has no agent,
skills, hooks, extra arguments or MCP servers of yours, never resumes a
session, and runs headless in the workspace itself, never in a
[worktree](/workflows/worktrees).

## The Commit Message settings tab

Open [Settings](/guide/settings) and choose **Commit Message**.

| Setting           | What it does                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Harness**       | [`commit.harness`](/reference/settings#commit-harness). **Inherit active harness** (the default) uses your default harness. |
| **Model**         | [`commit.model`](/reference/settings#commit-model). Empty uses that harness's default model.                                |
| **System prompt** | [`commit.systemPrompt`](/reference/settings#commit-systemprompt). The instructions sent before the diff.                    |

Change the system prompt to match your project's conventions, for example a
ticket number in the header or a shorter body. The diff is always appended
after it.

A cheap, fast model is usually enough for commit messages, and picking one
here doesn't change the model your workflows use.

### Last Generation Input

The lower half of the tab shows what was sent the last time a message was
generated from VS Code or the browser dashboard in this window:

- where it was started (**VS Code SCM button** or **Workspace viewer**) and when
- the git commands that produced the diff, and the folder they ran in
- whether the diff was staged, unstaged, or included untracked files, and
  whether it was truncated
- the harness command, the full prompt, and the generated message
- **View full output**, which opens that generation's run

## Generation runs in the dashboard

Each generation is saved as a run of a workflow named
`commit-message-generation`, so you can open it from the workflow list like
any other run and see the harness's full output. The workflow is read-only:
its banner says "Read-only — managed automatically by commit message
generation", with an **Edit in settings** link to the Commit Message tab,
which is where you change how it runs.

## See also

- [Source Control in the workspace viewer](/guide/source-control)
- [`ctrlyoke commit`](/cli/ctrlyoke#ctrlyoke-commit)
- [Settings reference: `commit`](/reference/settings#commit)
