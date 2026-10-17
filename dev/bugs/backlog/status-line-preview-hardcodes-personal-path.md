# Status-line preview hard-codes the developer's personal Windows path

- **Found:** 2026-10-17 by release-ready audit workflow (Claude, repo-hygiene auditor)
- **Area:** `src/ui/webview-react/components/settings/stats/StatusLinePreview.tsx` (~L79-83)
- **Severity:** medium

## Symptom

The Copilot example payload in the Settings status-line preview shows
`transcript_path: "C:\\Users\\natha\\.copilot\\session-state\\<session_id>"` and
`cwd: "C:\\dev\\ctrlyoke"`. Every user who opens that preview sees the developer's home path, which
ships in the VSIX and the hosted dashboard and will be searchable once the repo is public. The other
harness cases already use neutral values such as `cwd: "/workspace/project"`.

## Steps to Reproduce

1. Open Settings, then Stats, then the status-line preview, and select the Copilot harness.
2. The example JSON shows the personal path.

## Root Cause

The sample payload was copied from a real local session and never anonymised.

## Suggested Fix

Use neutral placeholders such as `C:\\Users\\you\\.copilot\\session-state\\<session_id>` and
`C:\\projects\\my-app`, matching the other harness cases. Update any test or snapshot that
asserts on the old strings.
