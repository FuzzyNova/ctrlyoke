# Extension-side error toasts are not written to the session log

- **Found:** 2026-11-02 by Claude, while investigating a dashboard Run export failure that toasted but left no log line
- **Area:** `src/core/UserFeedbackSink.ts`, `src/extension.ts`
- **Severity:** medium

## Symptom

An error notification raised by the extension host often has no matching line in
`.ctrlyoke/logs/ctrlyoke-<timestamp>.log`, so a user's "I saw this error" cannot be
traced from the log. The dashboard side is fixed: `notifyUser` and `showWebviewToast`
(`src/ui/webview-react/utils/notifyUser.ts`) now log every ERROR they show as
`[<client>] [Toast] …`. The extension side has no equivalent funnel.

## Steps to Reproduce

1. Trigger any extension command failure that goes through `reportCommandError` or a
   direct `vscode.window.showErrorMessage` (for example `extension.ts` "list workflow
   files" or "server bind" failures).
2. The VS Code error notification appears.
3. The session log has no line for it.

## Root Cause

`notifyUserFeedback` (`src/core/UserFeedbackSink.ts`) only forwards to the sink, and no
sink logs (`VsCodeUserFeedbackSink`, `HostedWebSocketUserFeedbackSink`,
`ConsoleUserFeedbackSink`, `CompositeUserFeedbackSink`). Each call site has to log for
itself. An audit on 2026-11-02 found about 39 extension-side ERROR notifications with
no log, including about 26 direct `showErrorMessage` calls (22 in `extension.ts`,
plus some in `DevCommands.ts` and `ScmCommitCommand.ts`). It also found about 17 sites
that `Log.error` just before notifying. `PromptFileParser.ts` calls `sink.notify()`
directly and bypasses the helper.

## Suggested Fix

1. Make `notifyUserFeedback` call `Log.error` for ERROR, and take an optional `error`
   argument so the stack trace that today's caller-side `Log.error(…, error)` lines
   record is kept. Do not log in the sinks or in `DashboardApplication`'s
   `SHOW_NATIVE_FEEDBACK` handler: those carry dashboard toasts, which `notifyUser`
   already logged.
2. Delete the caller-side `Log.error` lines that come right before a
   `notifyUserFeedback`, passing their error object through instead.
3. Send the direct `showErrorMessage` calls and `PromptFileParser`'s `sink.notify` calls
   through `notifyUserFeedback` / `reportCommandError`.
4. Optional: host handlers that `Log.error` and then emit a failure message the dashboard
   toasts (`WORKFLOW_ACTION_FAILED`, `WORKFLOW_SAVE_FAILED`) now log twice, once with the
   stack (host) and once as `[Toast]`. Keep the host line when it carries an `Error`;
   drop it when it only repeats the message.
