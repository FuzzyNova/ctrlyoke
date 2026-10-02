# File access policy compares unnormalized trusted roots

- **Found:** 2026-10-02 by bug-hunt final step (source review + compiled-module repro)
- **Area:** `src/utils/FileAccessPolicy.ts`
- **Resolution:** fixed in this commit

## Symptom

On Windows, a `permissions.trustedExternalRoots` entry that isn't already in
`path.resolve` form gets inconsistent answers. Examples are forward slashes,
which are common in hand-edited JSON (`"C:/Users/me/shared"`), a trailing
separator, or a `..` segment. `@`-attachments under that root are allowed,
because `AttachmentBuilders`/`ContextExpander` normalize roots with
`path.resolve`. Every caller of `evaluateFileAccess` denies the same paths as
`outsideTrustedRoots`. Those callers are:

- prompt-file resolution (`PromptFileResolver.isCandidateAllowed`, so a
  workflow's `file:` prompt under the trusted root is rejected at parse/run time)
- editor links and the "Trust Parent Folder" flow (`PromptLinkProvider`,
  `ContextMenuReferenceCommands`, `PromptEditorSupportService`)
- dashboard open-file (`RunOutputResolver`)

The user has trusted the folder, but half the product still treats it as
untrusted. This is a wrongful denial, not a bypass: unnormalized roots only
ever fail to match.

## Steps to Reproduce

Against the compiled module (`npm run compile:extension` first), on win32:

```js
const { evaluateFileAccess } = require("./out/utils/FileAccessPolicy.js");
const opts = (root) => ({
  workspaceRoots: ["C:\\dev\\ws"],
  approvedExternalRoots: [root],
});
evaluateFileAccess(
  "C:\\Users\\natha\\shared\\a.md",
  opts("C:/Users/natha/shared")
).reason;
// "outsideTrustedRoots"   (expected "trustedExternalRoot")
evaluateFileAccess(
  "C:\\Users\\natha\\shared\\a.md",
  opts("C:\\Users\\natha\\x\\..\\shared")
).reason;
// "outsideTrustedRoots"   (expected "trustedExternalRoot")
evaluateFileAccess(
  "C:\\Users\\natha\\shared",
  opts("C:\\Users\\natha\\shared\\")
).reason;
// "outsideTrustedRoots"   (the root directory itself; expected "trustedExternalRoot")
evaluateFileAccess(
  "C:\\Users\\natha\\shared\\a.md",
  opts("C:\\Users\\natha\\shared")
).reason;
// "trustedExternalRoot"   (only the already-resolved spelling works)
```

## Root Cause

`evaluateFileAccess` (`src/utils/FileAccessPolicy.ts`, about lines 44–88) passes
each workspace, own-state, and approved external root straight to
`isPathWithinDirectory` (`src/utils/PathSecurity.ts`). That function only
case-folds and string-prefix-compares, and its contract says both paths "must
already be resolved". The roots come from
`ConfigurationUtils.getEffectiveApprovedExternalFileRoots`, which returns the
setting strings verbatim. Its `dedupeExternalRoots` canonicalizes only to
compare entries and then returns the raw strings. None of the
`evaluateFileAccess` callers resolve them first. `AttachmentBuilders.ts`
(about line 117) and `ContextExpander.ts` (about line 163) do `path.resolve`
every root, which is why the two layers disagree.

## Suggested Fix

- Normalize every root once inside `evaluateFileAccess` with `path.resolve`,
  for `workspaceRoots`, `ownStateRoots`, and `approvedExternalRoots`. Then all
  callers agree with the attachment layer, and no caller has to remember to do
  it. Return the matched root in its original spelling, or the resolved one,
  consistently. Check `matchedRoot` consumers (Trust Parent Folder UX) to
  decide which.
- Don't change `isPathWithinDirectory`'s contract. It is a hot, pure prefix
  check.
- Add unit tests in `src/test/` for the three repro shapes above: forward
  slashes, a `..` segment, and a trailing separator with the root itself as
  the candidate. Each must evaluate to `trustedExternalRoot`. Add a sibling-prefix
  case (`C:/Users/natha/shared-evil/a.md` must still be `outsideTrustedRoots`)
  so normalization can't widen trust.
