# Windows credential store corrupts non-ASCII secret values (console code page)

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `src/platform/OsCredentialStore.ts` (embedded PowerShell script, `runCommand`)
- **Severity:** medium

## Symptom

On Windows, `OsCredentialStore` (used by `ctrlyoke secret`, the CLI/MCP platform
adapter, and the extension's license/secret storage) round-trips values through an
embedded PowerShell script. Node writes the value to the script's stdin as UTF-8
and decodes stdout as UTF-8, but the script reads with `[Console]::In.ReadToEnd()`
and writes with `[Console]::Out.Write(...)` without setting the console encoding,
so Windows PowerShell 5.1 uses the console's active code page instead.

- Under code page 936 (default on Simplified-Chinese Windows) storing `x€` reads
  back as `x�` — the secret is silently corrupted.
- Under code page 437 the round trip happens to survive, but the stored credential
  is mojibake (each UTF-8 byte stored as its own UTF-16 unit). That also breaks
  `splitIntoCredentialChunks`' sizing, which counts UTF-16 units on the Node side,
  so a long non-ASCII value can exceed the 2560-byte `CredWrite` blob limit and fail
  with Win32 error 1783.

Machines with the system-wide "Beta: Use Unicode UTF-8" option (code page 65001)
hide the bug.

## Steps to Reproduce

1. On Windows, `chcp 936` (or run under a non-UTF-8 system locale).
2. `ctrlyoke secret set TEST_SECRET` and enter `x€`.
3. Read it back (e.g. run a script step that echoes `$env:TEST_SECRET`, or call
   `new OsCredentialStore().get(...)`): the value is `x�`.

Reproduced by spawning `powershell.exe` exactly as `runCommand` does after `chcp 936`.

## Root Cause

The script in `OsCredentialStore.ts` (`get` branch ~86, `store` branch ~95) relies
on the console's default encodings. The target name is already base64-encoded to
avoid encoding issues, but the value is not.

## Suggested Fix

Take the console out of the loop: have Node send the value as base64 of its UTF-8
bytes on stdin, and have the script decode it (`[Text.Encoding]::UTF8.GetString(
[Convert]::FromBase64String(...))`). Do the same in reverse for `get` (write
`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))`, decode in
Node). This works whatever the code page is. Setting
`[Console]::InputEncoding`/`OutputEncoding` to a BOM-less UTF-8 at the top of the
script is a smaller alternative, but base64 is more robust. Keep the chunk sizing
consistent with what is actually stored (UTF-16 units of the decoded value).
Unit test: with the injected `CommandRunner`, assert the script input/output
encoding contract (base64), and that a value with non-BMP and non-ASCII characters
round-trips through the encode/decode helpers.
