# streamFileLines counts a held-back CR against the line-length limit

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/TextLines.ts`
- **Severity:** low

## Symptom

`streamFileLines(path, { maxLineLength })` throws `LineTooLongError` for a line
of exactly `maxLineLength` characters when that line ends in a CR that lands at
the end of a read chunk: either a file whose last line ends in a lone `\r`, or a
CRLF file whose chunk boundary falls between `\r` and `\n` on such a line. The
same line terminated by `\n` is accepted, so the limit depends on line-ending
style and chunk boundaries, which the code's own comment (line 103-104) says it
must not.

## Steps to Reproduce

```js
const fs = require("fs");
const { streamFileLines } = require("./out/utils/TextLines.js");
fs.writeFileSync("/tmp/cr.txt", "abc\r");
fs.writeFileSync("/tmp/lf.txt", "abc\n");
for (const p of ["/tmp/lf.txt", "/tmp/cr.txt"]) {
  (async () => {
    try {
      for await (const l of streamFileLines(p, { maxLineLength: 3 }))
        console.log(p, JSON.stringify(l));
    } catch (e) {
      console.log(p, "ERR", e.message);
    }
  })();
}
// /tmp/lf.txt "abc"
// /tmp/cr.txt ERR Line 1 is longer than the 3-character line limit
```

Expected: both yield `"abc"`.

## Root Cause

`src/utils/TextLines.ts:114-123` holds a trailing `\r` back in `buffered` until
the next chunk shows whether it starts a CRLF pair. Line 134 then calls
`assertLineLength(buffered, completedLines + 1)` on that buffer **including** the
held-back `\r`, so the terminator is measured as a line character.

Callers: `ContextExpander.ts` (file excerpts under `MAX_EXCERPT_BYTES`) and
`RunBundleReader.ts` (`events.jsonl`, written with `\n`, so effectively
unaffected). Impact is a false "line limit" refusal at one exact boundary length.

## Suggested Fix

Measure the unfinished tail without the held-back CR:
`assertLineLength(endsWithCarriageReturn ? buffered.slice(0, -1) : buffered, completedLines + 1)`.
Add unit tests: a lone-CR-terminated line at exactly the limit, and a CRLF file
read with a tiny `highWaterMark` (or a chunk split between `\r` and `\n`) at
exactly the limit; both must yield the line, and a line one character over must
still throw.
