# Editor treats a longer fence as closed by the first ``` inside it, unlike the runtime

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), code reading and a reproduction against the bundled modules
- **Area:** `src/ui/webview-react/utils/atomicReferences.ts` (`getFencedBlockRanges`), `src/utils/FileReferenceParser.ts` (`maskFencedCodeBlocks`)
- **Resolution:** fixed in this commit

## Symptom

The prompt below has a 4-backtick fence wrapping a 3-backtick example:

`````text
````md
```
$previous
```
````
`````

- **At runtime**, `maskFencedCodeBlocks` matches fence lengths, so `$previous` is masked and not expanded.
- **In the editor**, `getFencedBlockRanges` closes the outer fence at the first inner ```, so `$previous` gets a live chip, prior-context lint, and a token count.

The same mismatch affects every editor decoration and lint that uses
`getFencedBlockRanges` / `isInFencedBlock` (`@`, `#`, `~`, `!`, `/skill:` and
condition chips). It breaks the invariant that the editor chips exactly what a
run will substitute.

## Root Cause

`getFencedBlockRanges` uses the lazy regex ``/```[\s\S]*?```/g`` instead of the
fence-length-aware scan in `maskFencedCodeBlocks`.

## Suggested Fix

Export the block-range scan from `FileReferenceParser.ts` (e.g.
`findFencedBlockRanges(text)`, which `maskFencedCodeBlocks` then uses
internally) and have `getFencedBlockRanges` delegate to it, so the two can't
drift. Keep the generated literal-fence opener handling.
