# `isPathWithinDirectory` never matches descendants of a filesystem root

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/utils/PathSecurity.ts` (`isPathWithinDirectory`)
- **Resolution:** fixed in this commit

## Symptom

When the directory being checked is a filesystem root (`C:\`, `D:\`, `/`), every
descendant is reported as outside it:

```
isPathWithinDirectory("C:\\foo\\bar.txt", "C:\\")  // false, expected true
isPathWithinDirectory("/foo/bar", "/")               // false on POSIX, expected true
```

(Reproduced by running the source with `tsx`.) This is a false denial, not a false
grant. But the function is the allowlist check behind roughly a hundred non-test call
sites: workspace-scoped file access, trusted external roots, hosted viewer path checks,
and so on. So a workspace opened at a drive root, or an external root trusted as `D:\`,
denies every file under it.

## Steps to Reproduce

1. `ExternalRootsTrustStore.canonicalizeRoot("D:/")` returns `"D:\\"`, because
   `path.resolve` keeps the trailing separator for roots.
2. Any containment check against that root runs
   `candidate.startsWith("d:\\" + path.sep)`, i.e. `startsWith("d:\\\\")`, which no
   real path satisfies.
3. Every file under the root is rejected.

## Root Cause

`PathSecurity.ts:26-27` appends `path.sep` to the directory unconditionally to guard
against sibling-prefix matches (`C:\dev\ctrlyoke-evil` vs `C:\dev\ctrlyoke`). A root
directory already ends in a separator, so the guard doubles it. There is no root case in
`src/test/unit/PathSecurity.test.ts`.

## Suggested Fix

Append the separator only when the folded directory does not already end with one:
`const prefix = foldedDirectory.endsWith(path.sep) ? foldedDirectory : foldedDirectory + path.sep;`.
Keep the sibling-prefix guard intact. Add `PathSecurity.test.ts` cases for a drive
root (`C:\`, with case folding on win32) and a POSIX `/` root, and keep the existing
sibling-prefix test green. Check `isPathWithinAnyDirectory` and any other local
`startsWith(dir + path.sep)` copies in `src/` (grep for `+ path.sep)`) and route them
through this helper so the fix lives in one place.
