# Hosted server redacts JSON responses twice and can emit invalid JSON

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/server/SecretRedactionMiddleware.ts`
- **Severity:** medium

## Symptom

Any hosted JSON route that returns user text (diff, file history, search snippets, and so on) can
return a body that isn't valid JSON. The dashboard then fails to load that view.

## Steps to Reproduce

Verified by an agent against the real `CtrlYokeHostedServer`:

1. In a git workspace, commit `f.txt`, then change it to `const password=abcdefg"; // short`.
2. `GET /api/workspace-viewer/diff?path=f.txt&token=…`.
3. Actual: 200 with `"newContent":"const password=[REDACTED]"; // short…`, and `JSON.parse` fails.
   Expected: valid JSON with the text unchanged, because the value-level pass correctly found no
   secret.

## Root Cause

The middleware wraps both `res.json` and `res.send`. The `json` wrapper runs `redactValue(body)`,
then calls the original `res.json`. Express implements that by calling `this.send(string)`, which
is the patched `send`, so `redactText` runs again over the serialized JSON. The
`credential-assignment` value class stops at `"` but accepts `\`. So in the JSON text the 7-char
value plus the escaping backslash reaches the 8-char minimum, and the replacement swallows the
backslash. That leaves a bare `"` that ends the string early.

## Suggested Fix

Make the `json` path redact exactly once, at value level. For example, mark the response while
`originalJson` runs so the patched `send` skips text redaction, or have the JSON wrapper serialize
and call the unpatched `send`. Add a regression test with the input above that asserts the
response parses and that a real secret value is still redacted.
