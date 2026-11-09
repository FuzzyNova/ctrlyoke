# Trust-decision files mishandle empty files and accept invalid roots

- **Found:** 2026-11-08 by smell hunt, pass 6
- **Area:** `src/config/TrustDecisionFile.ts`
- **Resolution:** fixed in this commit

## Symptom

An empty, whitespace-only or comment-only trust-decision file was treated as
malformed, so every later decision save failed. An array root or non-object
`decisions` value was instead accepted as an empty store, allowing the next
decision save to overwrite the user's original file.

## Steps to Reproduce

1. Create an empty or comment-only trust-decision JSON file.
2. Attempt to save a trust decision; the store rejects the write as invalid JSON.
3. Replace the file with an array root or a `decisions` field that is not an object.
4. Attempt to save a trust decision; the previous implementation overwrote the file.

## Root Cause

`TrustDecisionFile.loadTrustDecisionFile` parsed JSONC independently from the
settings backend. It did not treat comment-only content as empty and did not
validate the root or `decisions` object shape before returning a writable store.

## Resolution Details

Both readers now use `readJsoncObjectFile`, which shares BOM handling, JSONC
parsing, empty-content detection and object-root validation. Trust-decision
files with malformed content remain protected from overwrites. Their writers
and the settings and MCP registry writers now use the shared hardened atomic
write helper.
