# Commit-message diff drops untracked symlinks and nested repositories

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/git/CommitMessageGenerator.ts` (`getDiff`)
- **Resolution:** fixed in this commit

## Symptom

When a repository's only change is a new, untracked symbolic link, "Generate
Commit Message" in the Source Control view reports "No changes detected. Stage
or modify files first." `ctrlyoke commit --all` refuses to commit for the same
reason, even though its own `git add -A` (`GitCommitter.ts`) would stage the
link. When there are other changes too, the commit includes the link but the
generated message never mentions it, because the model never saw it.

An untracked nested repository (listed by `git ls-files --others` as `nested/`)
is dropped the same way.

## Steps to Reproduce

1. `git init repo && cd repo && git commit --allow-empty -m init`
2. `ln -s target.txt link`. `git status` shows `?? link`.
3. Call `CommitMessageGenerator.getDiff(cwd)` or
   `getDiff(cwd, { includeUnstaged: true })` (stub `vscode` and load
   `out/git/CommitMessageGenerator.js`).
4. Both return `null`, which becomes "No changes detected".

## Root Cause

In the untracked-file loop of `getDiff` (`src/git/CommitMessageGenerator.ts:572-577`):

```ts
const stat = await fs.lstat(absolutePath);
if (!stat.isFile()) {
  continue;
}
```

The `lstat` guard was added by `commit-message-untracked-files-read-unbounded`
so that ctrlyoke never reads _through_ a link or a special file. That is
correct, but skipping the entry entirely records nothing for it, so a diff made
up only of such entries is empty and `getDiff` returns `null` at
`if (!diff.trim()) return null;` (line ~638). Git itself lists a new symlink as
`new file mode 120000` with the link target as its content.

## Suggested Fix

- For `stat.isSymbolicLink()`, append a synthetic entry built from
  `fs.readlink()` (which never follows the link), matching what `git diff`
  shows once the link is staged:

  ```
  diff --git a/link b/link
  new file mode 120000
  --- /dev/null
  +++ b/link
  @@ -0,0 +1 @@
  +target.txt
  \ No newline at end of file
  ```

- For a directory entry (path ends in `/`, a nested repository), append a short
  header such as `diff --git a/nested b/nested\nnew file mode 160000\n` so the
  change is visible and the diff is non-empty.
- Keep skipping FIFOs, sockets and devices.
- Respect the existing `append`/`MAX_DIFF_BYTES` budget.
- Tests in `src/test/unit/CommitMessageGenerator*.test.ts`: a repo whose only
  change is an untracked symlink returns a non-null diff that contains
  `new file mode 120000` and the target, and never the target file's contents.
  Skip the symlink test where symlinks can't be created (see
  `worktree-utils-test-needs-symlink-privilege`).
