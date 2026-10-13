# Code-fence masking ignores CRLF line endings, so fenced references expand

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a tsx probe)
- **Area:** `src/utils/FileReferenceParser.ts` (`findCodeRanges` / `maskCodeRanges`)
- **Resolution:** fixed in this commit

## Symptom

References and placeholders inside a fenced code block are meant to stay
literal. In a prompt with Windows `\r\n` line endings they are expanded instead:
`@file`, `#selection`, `$previous`/`$step`, `~diff`, `{{var}}` and
`$endCondition:` all go through. The most common source is a `.prompt.md` file
saved with CRLF, which is the default for many Windows editors and for checkouts
with `core.autocrlf=true`. `PromptFileParser.parseMarkdownPromptFile` passes the
body through unnormalized (`getPromptMarkdownText` only strips the BOM and
trims). Prompts in JSON workflows that contain `\r\n` escapes are affected the
same way. The dashboard editor normalizes to `\n`, so it shows these tokens as
literal while the runtime expands them.

## Steps to Reproduce

````ts
import {
  findCodeRanges,
  parseInlinePriorContextRefs,
} from "src/utils/FileReferenceParser";
const lf = "Intro\n```\nsee $previous and @src/app.ts\n```\nafter";
const crlf = lf.replace(/\n/g, "\r\n");
findCodeRanges(lf); // [{ from: 6, to: 43 }]
findCodeRanges(crlf); // []  <- no fence found
parseInlinePriorContextRefs(crlf).length; // 1   <- $previous expands inside the fence
````

## Root Cause

`findCodeRanges` splits on `"\n"` only, so each line keeps a trailing `"\r"`.
The fence-closer check is anchored to the end of the line (whitespace-only after
the run), and the trailing `\r` fails it. As a result `findClosedBlockFences`
never pairs an opener with a closer, and the block is not masked. Inline code
spans are unaffected because `\r` is an ordinary character inside them.

## Suggested Fix

In `findCodeRanges` (or `addFenceContainerContext`), treat a trailing `\r` as
part of the line terminator. Drop it from the text used for fence detection, but
keep the physical offsets intact so ranges still index the original string.
Every caller then works unchanged: the runtime, the editor lint/chips and
`maskCodeRanges`. Add CRLF cases to the `FileReferenceParser` unit tests:

- fenced `@path` and `$previous` stay literal;
- a fenced `{{var}}` stays literal in `VarSubstitutor`;
- returned offsets still map onto the original CRLF string.

Optionally, also add a `.prompt.md` round-trip test through `PromptFileParser`
with CRLF content.
