# Windows credential overwrite that fails partway returns a spliced value

- **Found:** 2026-10-02 by bug-hunt final step (source review + fake-vault repro)
- **Area:** `src/platform/OsCredentialStore.ts` (`WindowsCredentialBackend`)
- **Resolution:** fixed in this commit

## Symptom

`WindowsCredentialBackend.store` splits long values across `<key>`, `<key>#1`,
… with the chunk count in `<key>#count`. Its comment promises that a write
which fails partway "must leave a state that `get` rejects loudly rather than
one it reads as a complete but truncated value". That only holds when there
was no previous value. When an existing multi-chunk value is _overwritten_,
`get` can silently return corrupt data:

- **Same chunk count** (e.g. a license refresh or rotating a long token): the
  count is rewritten unchanged, then chunks 0..N-1 are overwritten one by one.
  If writing chunk _i_ fails, `get` returns new chunks 0..i-1 joined with old
  chunks i..N-1. That is a well-formed-looking spliced value, with no error.
- **Shrinking to a single credential:** `#count` is deleted first, then chunk 0
  is written. If that write fails, the old full chunk 0 is left without a count.
  `get` sees "no continuation" and returns the first 1280 characters of the old
  value, with no error.

Each credential operation spawns its own PowerShell process (around 500 ms), so a
multi-second store has a wide window. A CredWrite error or a killed VS Code is
enough. A spliced license file then fails its signature check, and the user
silently drops to Free. A spliced PEM key or long token is handed to a
harness or script as if it were valid.

## Steps to Reproduce

Use the existing fake `runCommand` vault pattern from
`src/test/**/OsCredentialStore.test.ts` (platform `win32`):

1. Store `"A".repeat(3000)` under `k` (3 chunks).
2. Store `"B".repeat(3000)` under `k`, with the fake failing the write to `ctrlyoke.k#1`.
3. `get("k")` returns 3000 characters: 1280 `B` followed by `A`, with no error.
4. Separately: store `"A".repeat(3000)`, then store `"short"` with the fake
   failing the write to `ctrlyoke.k`. `get("k")` returns 1280 `A`, with no error.

The existing partial-write test only covers a fresh key.

## Root Cause

`store` (`src/platform/OsCredentialStore.ts`, about lines 412–439) relies on the
count record alone to detect a torn write. The count can't tell old chunks
from new ones, and the shrink branch deletes the count before the replacement
chunk 0 exists.

## Suggested Fix

- Make torn reads detectable: when a value spans more than one chunk, store an
  integrity tag in the `#count` record alongside the count, e.g.
  `"<count>:<sha256-hex of the full value>"`. Write it first, as today. In
  `get`, after joining the chunks, verify the hash and throw the same "Re-store
  the secret to repair it" style error on mismatch. Keep parsing a bare `"<count>"`
  (no hash) so existing stored secrets still read.
- Shrinking to one chunk: write chunk 0 first, then delete `#count`, then
  delete the orphaned continuations. A failed chunk-0 write then leaves the old
  count and hash in place, so `get` rejects instead of truncating.
- Add Mocha tests for both repro cases, plus the existing fresh-write failure
  and a successful overwrite round trip.
