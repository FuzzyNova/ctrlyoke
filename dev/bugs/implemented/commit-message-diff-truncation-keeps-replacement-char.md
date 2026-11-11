# Commit-message diff truncation keeps a replacement character

- **Found:** 2026-11-10 by smell-hunt pass 7
- **Area:** `src/git/CommitMessageGenerator.ts` (`getDiff`)
- **Resolution:** fixed in this commit

## Symptom

When a staged diff is truncated in the middle of a four-byte UTF-8 character, the
commit-message prompt can contain a stray U+FFFD replacement character.

## Steps to Reproduce

1. Create a staged diff whose byte limit cuts after the first byte of a four-byte
   character, such as an emoji.
2. Read the truncated diff returned by `CommitMessageGenerator.getDiff`.
3. Observe that the result ends with U+FFFD.

## Root Cause

The private truncation helper decoded a sliced buffer and removed characters
only while the decoded text exceeded the byte limit. A malformed sequence can
decode to U+FFFD whose UTF-8 encoding still fits the limit, so the loop kept it.

## Suggested Fix

Use the shared `truncateUtf8` utility, which backs the byte boundary up to the
start of a split code point before decoding.
