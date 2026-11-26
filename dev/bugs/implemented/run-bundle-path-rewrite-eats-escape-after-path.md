# Run-bundle path rewrite swallows the escape after a path, corrupting nested JSON and shell commands

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/RunBundlePaths.ts`, `src/core/orchestration/RunBundleExporter.ts`
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke export` (and dashboard Export) rewrites workspace and home paths to
`${workspaceFolder}` / `~` in every string of the run. When the path sits inside
JSON nested in a string (harness tool-call `input`s, inline JSON config in a
shell command), the backslash of the escape right after the path is taken as a
path separator and turned into `/`:

- `…/src/a.ts\n@@\n-old` becomes `${workspaceFolder}/src/a.ts/n@@/n-old` — every
  newline after the path in a patch body is destroyed (and stays destroyed after
  import).
- `"…\b.txt\""` becomes `"${workspaceFolder}/b.txt/""` — the escaped quote is
  unescaped, so the nested string no longer parses as JSON.

It happens in real data: a recorded OpenCode launch command on this machine,
`NFIG_CONTENT="{\"plugins\":[\"/Users/…/out/scripts/ctrlyoke-opencode-plugin-v2\"]}"`,
exports as `…[\"${workspaceFolder}/out/scripts/ctrlyoke-opencode-plugin-v2/"]}"`.
The original run history is unaffected; only the bundle (and runs imported from it)
is corrupt.

## Steps to Reproduce

Against the compiled `out/utils/RunBundlePaths.js`:

```js
const m = require("./out/utils/RunBundlePaths.js");
const rw = m.createPortablePathRewriter({ workspaceRoot: "/Users/alex/dev/app", homeDir: "/Users/alex" });
rw(JSON.stringify({ input: "*** Update File: /Users/alex/dev/app/src/a.ts\n@@\n-old" }));
// → {"input":"*** Update File: ${workspaceFolder}/src/a.ts/n@@/n-old"}
const rww = m.createPortablePathRewriter({ workspaceRoot: "C:\\dev\\app", homeDir: "C:\\Users\\alex" });
JSON.parse(rww(JSON.stringify({ q: 'type "C:\\dev\\app\\b.txt"' })));
// → SyntaxError: Expected ',' or '}' after property value
```

Expected: `${workspaceFolder}/src/a.ts\n@@\n-old` and `{"q":"type \"${workspaceFolder}/b.txt\""}`.

## Root Cause

`RunBundlePaths.ts`:

- line 31: `SEPARATOR = [\\/]+` accepts any backslash as a separator (to support
  doubled `\\` in nested JSON).
- line 36: `PATH_TAIL = ((?:SEPARATOR PATH_NAME_CHAR*)*)` lets a separator be
  followed by **zero** name characters, so a trailing `\` before `"` is captured.
  For `\n`, the `\` is captured as a separator and `n` as a path segment.
- line 80: the captured tail's separators are all rewritten to `/`.

`RunBundleExporter.ts:679-700` applies the rewriter to every string value in the
run files, including tool inputs that are themselves serialized JSON.

The tests in `src/test/unit/RunBundlePaths.test.ts` cover doubled `\\` separators
but never an escape sequence directly after a path.

## Suggested Fix

1. Only accept a separator in the tail when a path-name character follows it
   (`(?:SEPARATOR PATH_NAME_CHAR+)*`), allowing at most a single trailing `/`
   (never a trailing backslash). This fixes the `\"` case for every root shape.
2. For POSIX roots (those starting with `/`), accept only `/` as a tail
   separator: POSIX paths never contain backslashes, so `\n`, `\t`, `\"` after a
   POSIX path are always escapes. This fixes the `\n` case. Windows roots keep
   `[\\/]+`; there, a backslash followed by a letter is genuinely ambiguous and
   should keep today's behavior.

Add tests: a POSIX path followed by `\n` and by `\"` inside `JSON.stringify`ed
text, a Windows path followed by `\"`, and a doubly-escaped `\\\"` case. Verify
`JSON.parse` of the rewritten text still succeeds and round-trips through
`createWorkspacePathResolver`.
