# SCM "Generate commit message" button ignores the repository it was clicked on

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code reading
- **Area:** `src/scm/ScmCommitCommand.ts`, `src/extension.ts` (`VSCODE_COMMANDS.GENERATE_COMMIT_MESSAGE` registration)
- **Resolution:** fixed in this commit

## Symptom

`package.json` contributes `ctrlyoke.generateCommitMessage` to `scm/title` with
`when: scmProvider == git`. VS Code shows that button on the title of **every**
git repository in the Source Control view: each folder of a multi-root workspace,
nested repositories it detects, and linked worktrees. Whichever button you click,
ctrlyoke:

- diffs the repository at `getVsCodeWorkspaceRoot()` (the `.ctrlyoke` root), not
  the repository you clicked, and
- writes the message into the input box of the repository whose root equals
  that path, or `repositories[0]` if none does.

So clicking the button on repository B generates a message from repository A's
changes. When the `.ctrlyoke` root is not a repository root (a saved
`.code-workspace` folder, a `ctrlyoke.workspaceDirectory` subfolder, or a parent
folder containing several repos), the diff either fails with "not a git
repository" or comes from a repo that has nothing to do with the input box
`repositories[0]` picks.

## Steps to Reproduce

1. Open a multi-root workspace with two git repositories, `A` and `B`, where the
   ctrlyoke root resolves to `A` (e.g. `A` is the first folder).
2. Stage a change in `B` only.
3. Click ctrlyoke's sparkle button on `B`'s title in the Source Control view.
4. You get "No changes detected" (A is clean). If A has changes, A's message
   lands in A's input box, and B's input box stays empty.

## Root Cause

`extension.ts` registers the command as `() => scmCommitCommand.execute(context)`
and drops the `SourceControl` argument VS Code passes to `scm/title` commands.
`ScmCommitCommand.execute` then always uses `cwd = getVsCodeWorkspaceRoot()`
(`ScmCommitCommand.ts:70`). `getGitInputBox` matches on that path and falls back
to `api.repositories[0]` (`ScmCommitCommand.ts:27-29`), which can be an unrelated
repository.

## Suggested Fix

Forward the command argument: `(sourceControl?: { rootUri?: vscode.Uri }) =>
scmCommitCommand.execute(context, sourceControl?.rootUri?.fsPath)`. In
`execute`, use that root as `cwd` when it's provided, and fall back to
`getVsCodeWorkspaceRoot()` only for command-palette invocations. Resolve the
input box for that exact root. Don't fall back to `repositories[0]` when an
explicit root was passed and isn't found. Leave the input box untouched rather
than writing into another repo's.

Careful: `CommitMessageGenerator.generateMessage(diff, cwd, ...)` uses `cwd` for
two jobs. It's the harness working directory, and it's also the ctrlyoke state
root: `.ctrlyoke/temp` for the MCP commit-output file, `stateRoot` for
`readCommitMessageLineageKey`, the `WorkflowInstance` workspace root, and
`CTRLYOKE_WORKSPACE`. Split these. The clicked repository root is the git/harness
working directory. The ctrlyoke root (`getVsCodeWorkspaceRoot()`) stays the state
root, so the commit-message lineage and temp files don't get scattered into
other repositories. Check `src/cli/CommitCommand.ts` (the other caller) and keep
its behavior unchanged.
