---
name: commit
description: Stage and commit current changes with a well-formed commit message. Reviews git status and diff, writes a conventional commit message, and commits without any attribution lines.
---

Review all current changes and create a git commit.

## Steps

1. Run `git status` to see all changed and untracked files
2. Run `git diff` (and `git diff --staged` if anything is already staged) to review the full diff
3. Draft a commit message following the format below
4. Stage the appropriate files and commit

## Commit message format

```
type: short title (imperative, ≤72 chars)

Optional body — explain *why*, not *what*. Wrap at 72 chars.
Use bullet points if there are multiple distinct changes.
```

**Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`, `perf`

**Title rules:**

- Imperative mood ("add feature", not "added feature")
- No period at the end
- Lowercase after the colon

## What NOT to include

- No `Co-Authored-By:` lines
- No `Co-authored-by:` lines
- No Anthropic or Claude attribution of any kind
- No AI-generated disclosure lines
- No trailers except those explicitly requested by the user

## File selection

Stage only files relevant to the logical change. Do not use `git add -A` blindly — exclude unrelated files, build artifacts, or secrets. If untracked files look intentional, ask before skipping them.

## After committing

Run `git status` to confirm the working tree is clean, then report the commit hash and title.
