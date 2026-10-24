# `ctrlyoke commit` runs `git add -A` / `git commit` with the default 1 MiB maxBuffer, so git is killed mid-operation on large commits

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (utils-git-config)
- **Area:** `src/git/GitCommitter.ts`
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke commit [--all]` commits through `GitCommitter`, which calls a bare
`promisify(execFile)` for `git add -A` and `git commit -m` with no `maxBuffer`.
Node's default cap of 1 MiB then applies to stdout and to stderr separately.
Both streams grow with the number of files:

- With `core.autocrlf=true` (the Git for Windows default), `git add -A` prints
  one `warning: in the working copy of '<path>', LF will be replaced by CRLF the
  next time Git touches it` line per LF file. That is about 108 bytes per file
  for short paths, so roughly 9-10k files exceed 1 MiB of stderr.
- `git commit` prints a ` create mode 100644 <path>` line per new file on
  stdout, and pre-commit hooks (lint-staged, formatters, test runners) can write
  a lot to either stream.

When the cap is exceeded, Node kills git and rejects with
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. If that happens during `git add`, the
index is only partly updated and `.git/index.lock` can be left behind, which
blocks every later git command until the user deletes it. If it happens after
the commit object is written (verbose hook or summary output), the CLI reports
failure even though the commit exists. In both cases the user is told the
commit failed, with no mention of the real reason.

Realistic input: the first commit of an imported project, a vendored
directory, or a large generated or renamed tree on Windows.

## Steps to Reproduce

1. On Windows with `core.autocrlf=true`, create a repo with ~12k new LF text
   files.
2. Run `ctrlyoke commit --all -m "import"`.
3. The command fails with `stderr maxBuffer length exceeded`. `git status`
   shows a partial index, and `.git/index.lock` may remain.

Measured: `git add -A` of 200 LF files with `core.autocrlf=true` wrote
21,692 bytes of warnings (~108 B/file) to stderr.

## Root Cause

- `src/git/GitCommitter.ts:4`: `const execFileAsync = promisify(execFile);`
- `:22`: `await execFileAsync("git", ["add", "-A"], { cwd: stdout.trim() });` and
  `:24`: `await execFileAsync("git", ["commit", "-m", message], { cwd });` pass
  no `maxBuffer`. The output is never used, yet it is buffered and capped.
- Caller: `src/cli/CommitCommand.ts:50` (`committer.commit(message, cwd, { addAll: options.all })`).

## Suggested Fix

Neither command's output is used, so do not buffer it at all. Spawn with
`stdio: ["ignore", "ignore", "pipe"]` and keep only a bounded tail of stderr
for the error message. Alternatively, route through the `GitUtils` mutation
helper (`GIT_COMMAND_MAX_BUFFER` plus the mutation timeout), as
`commitAll` already does. A raised cap alone just moves the cliff. Streaming or
discarding the output removes it. Add a test that stubs a git child writing
more than 1 MiB to stderr and asserts the commit still succeeds.
