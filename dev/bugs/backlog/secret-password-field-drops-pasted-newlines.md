# Pasting a multi-line secret (PEM key) into the default password field silently drops its newlines

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/settings/SecretsSection.tsx`
- **Severity:** medium

## Symptom

If you paste a multi-line secret, such as a PEM private key, into the default **Secret value** field of the Set secret / Replace dialog, its line breaks are lost. Chromium strips them and Firefox turns them into spaces. The field never switches to multi-line mode, and the corrupted single-line value is stored without any warning. Because the field shows only masked dots, the user cannot see the damage. Any tool that later reads the key from the injected environment variable fails to parse it.

## Steps to Reproduce

1. Open the dashboard and go to **Settings > Secrets**. Click **Set secret**, or **Replace** on an existing secret.
2. Enter a valid name. Leave **Multi-line value (for example, a PEM private key)** unticked.
3. Paste a multi-line PEM private key (`-----BEGIN ...` through `-----END ...`) into **Secret value**.
4. The field stays a single-line password input. It never switches to the textarea, because the browser has already removed the newlines from the input's value.
5. Click **Set value**. The secret is stored without line breaks, and a tool that consumes it (for example `ssh` or a JWT signer) rejects the key.

## Root Cause

`src/ui/webview-react/components/settings/SecretsSection.tsx:361-372`: the default control is `<input type="password">`. Its `onChange` handler tries to detect a multi-line paste with this check (line 368):

```tsx
if (event.target.value.includes("\n")) setMultiline(true);
```

The HTML value-sanitization algorithm for text and password inputs strips CR and LF, and browsers also strip or replace newlines on paste. As a result, `event.target.value` never contains `"\n"` and this branch can never run.

`handleSubmit` (lines 261-283) then passes the already-collapsed `value` to `setSecret` with no validation and no warning. `multiline` defaults to `false` (line 227) and is reset each time the dialog opens (line 242), so this broken path is the default one.

## Suggested Fix

Detect newlines before the browser sanitizes the value:

- Add an `onPaste` handler to the password input that reads `event.clipboardData.getData("text")`. If the text contains `\n` or `\r`, call `preventDefault()`, set `value` to the raw clipboard text, and call `setMultiline(true)`. The textarea then takes over with the newlines intact. Focus should move to the textarea.
- Remove the dead `includes("\n")` check from `onChange`.

A simpler alternative is to always render the masked textarea (`rows={1}`, auto-growing). With no single-line control, nothing can drop newlines.

Add a Vitest test that fires a paste event with multi-line clipboard data on the default field and asserts that `setSecret` receives the value with its newlines intact.
