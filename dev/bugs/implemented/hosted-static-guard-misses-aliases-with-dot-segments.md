# Hosted static guard still serves raw index.html for NTFS aliases behind `./` or `a/../`

- **Found:** 2026-09-30 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (static-file guard before `express.static`, ~line 974)
- **Resolution:** fixed in this commit

## Symptom

On Windows, these requests still get a 200 with the raw, unpatched `index.html` (or `favicon.svg`)
from `express.static`, without a token:

| Request                 | Status                    |
| ----------------------- | ------------------------- |
| `/INDEX~1.HTM`          | 404 (blocked)             |
| `/./INDEX~1.HTM`        | **200**, raw `index.html` |
| `/a/../INDEX~1.HTM`     | **200**                   |
| `/.%5CINDEX~1.HTM`      | **200**                   |
| `/./index.html::$DATA`  | **200**                   |
| `/%5Cindex.html::$DATA` | **200**                   |
| `/./favicon.svg::$DATA` | **200**                   |

This is a follow-up to `hosted-index-html-ntfs-alias-bypasses-token.md` and
`hosted-index-html-backslash-path-bypasses-token.md`. It is a partial regression from 1784413e1:
before that commit, the alias regexes ran on `path.posix.normalize(decodedPath)`, so `/./INDEX~1.HTM`
and `/a/../INDEX~1.HTM` were caught. Now they run on the raw decoded path.

## Steps to Reproduce

The repro used a standalone express app with the exact guard middleware copied from
`CtrlYokeHostedServer.ts`, `express.static(dist, { index: false })`, and a `dist/` that holds
`index.html` (8.3 short name `INDEX~1.HTM` per `dir /x`). Then it requested the paths above with
`http.get` (`$` sent as `%24`). The existing test `static fallback blocks NTFS aliases for protected
files without a token` only covers the root-level spellings, so it still passes.

## Root Cause

The guard has two checks:

1. It compares `path.resolve(webviewDist, "." + decodedPath)` against the protected absolute paths.
   `path.resolve` leaves the `::$DATA` stream suffix and the 8.3 short name alone, so these never
   equal `...\index.html`, even though the Windows filesystem opens the same file.
2. It runs the alias regexes (`/^\/index(?:~\d+)?\.html?(?::.*)?$/` etc.) on
   `decodedPath.toLowerCase()`. The path is not normalized, so any leading `./`, `a/../` or `.\`
   defeats the `^\/index` anchor.

`send` normalizes `./`, `a/../` and `\` itself before opening the file, so the file is served.

## Suggested Fix

Run the alias check on the **resolved** path rather than the raw request path. Block the request
when `path.dirname(resolvedPath)` equals `webviewDist` (case-folded on Windows) and
`path.basename(resolvedPath)` matches the alias patterns: `index(~\d+)?.htm(l)?` or
`favicon.svg` / `favico~\d+.svg`, with an optional `:...` stream suffix. A stricter alternative
is to strip any `:` stream suffix and compare `fs.realpathSync.native` of existing files, which
expands 8.3 names, against the protected paths. Add every row of the table above to the existing
NTFS-alias test.
