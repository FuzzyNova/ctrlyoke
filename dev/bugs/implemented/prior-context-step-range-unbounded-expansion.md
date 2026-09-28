# A large `$step:` range freezes or crashes prompt parsing

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/utils/RangeNotationParser.ts`, `src/utils/FileReferenceParser.ts`
- **Resolution:** fixed in this commit

## Symptom

`parseRangeNotation` expands every range into a full array without bounding its size. A prompt
that contains a large inline prior-context range, such as `$step:1-99999999`, therefore:

- `1-10000000` blocks synchronously for about 2.7 s and allocates about 500 MB.
- `1-20000000` or more throws `RangeError: Set maximum size exceeded` from `new Set(result)`. The
  function is documented to return `null` for invalid input, and its callers expect that.
- Larger upper bounds keep pushing until the process runs out of heap. An extension-host OOM
  takes VS Code down.

The parser runs on the editor text as the user types (`useAttachmentTokenCount.ts`), during step
preparation on the extension host or CLI (`CliPromptPreparer.ts`), and in the custom range field
of `PriorContextSelect.tsx`. A single typo in a prompt can therefore stall the webview or crash
the host.

## Steps to Reproduce

1. `npx tsx -e "import('./src/utils/RangeNotationParser.ts').then(m => console.log(m.parseRangeNotation('1-30000000')))"`
2. Observe `RangeError: Set maximum size exceeded` (and a multi-second stall before it).
3. The same happens through `parseInlinePriorContextRefs("see $step:1-30000000")`.

## Root Cause

`RangeNotationParser.ts:21`: `for (let i = start; i <= end; i++) result.push(i);` has no cap on
`end - start`. The numbers are also not checked with `Number.isSafeInteger`.

## Suggested Fix

Reject (return `null`) any input whose total expanded count would exceed a sane cap. Check it
cumulatively before expanding, and single-source the cap from the existing max-steps limit if one
applies. Also reject numbers that are not safe integers. Add unit tests for a huge range, for many
ranges that together exceed the cap, and for a non-safe integer.
