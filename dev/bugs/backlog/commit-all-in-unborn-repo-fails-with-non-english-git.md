# `ctrlyoke commit --all` fails in a repo with no commits when git's messages are not in English

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against `out/`)
- **Area:** `src/git/CommitMessageGenerator.ts` (`getDiff`, `includeUnstaged` branch ~487-510)
- **Severity:** medium

## Symptom

In a repository with no commits (unborn `HEAD`), generating a commit message
with unstaged changes included (`ctrlyoke commit --all`, `includeUnstaged`)
throws instead of falling back to staged + unstaged diffs when git's messages
are localized:

```
Command failed: git diff HEAD --no-ext-diff
Schwerwiegend: mehrdeutiges Argument 'HEAD': unbekannter Commit oder Pfad existiert nicht
```

The same repo works under English git.

## Steps to Reproduce

1. `git init r`, create and `git add a.txt`, create untracked `b.txt`.
2. `npm run compile:extension`; call `getDiff(r, { includeUnstaged: true })`
   from `out/git/CommitMessageGenerator.js`.
3. Under `LC_ALL=C` it returns both files. Under `LC_ALL=de_DE.UTF-8` it
   throws the error above.

**Expected:** the same diff in both locales.

## Root Cause

`CommitMessageGenerator.ts` ~497-504 recognizes the unborn-HEAD failure only by
matching git's English stderr:
`/ambiguous argument 'HEAD'|unknown revision.*HEAD/i`. Localized git does not
match, so the error is rethrown.

## Suggested Fix

Detect the unborn repo before the diff with
`git rev-parse --verify --quiet HEAD` (exit code 1 and no output when `HEAD`
is unborn; `RunBundleExporter.ts` ~220 already does this) and take the
fallback branch on that result rather than parsing stderr. Test in
`src/test/unit/CommitMessageGenerator.test.ts`: unborn repo, `includeUnstaged`,
git run with `LC_ALL`/`LANGUAGE` set to a non-English locale (or an env var
that forces a non-matching message), and assert the staged and untracked files
both appear.
