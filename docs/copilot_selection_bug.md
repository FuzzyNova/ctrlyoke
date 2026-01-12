# Multiple `#selection` attachments only include the last selection

## Description

When using multiple `#selection` references in a single GitHub Copilot Chat message, only the last selection is included in the context sent to the AI model. The `#selection` tool transforms into `#file:path:line-line` format, but when multiple such references are used, only the last one is actually attached. Additionally, this last reference appears to be duplicated in the attachment list.

This issue is specific to `#selection` references and `#file:path:line-line` references with line ranges. Full file references using `#file:path` (without line numbers) work correctly and all are included.

## Steps to Reproduce

1. Open a workspace with multiple files in VS Code
2. Select a code section in one file (e.g., lines 45-52 in `src/utils.ts`)
3. In GitHub Copilot Chat, type `#selection` - it will transform to `#file:src/utils.ts:45-52`
4. Select a different code section in another file (e.g., lines 120-125 in `src/helpers.ts`)
5. Continue typing in the same chat message and add `#selection` again - it will transform to `#file:src/helpers.ts:120-125`
6. Repeat for a third file if desired
7. Complete your message (e.g., "Compare these implementations") and submit
8. Observe that only the last selection is actually included in the context sent to the AI

## Expected Behavior

All file references with line ranges should be attached to the context, similar to how multiple full file references work:

- `#file:src/utils.ts:45-52` should be attached
- `#file:src/helpers.ts:120-125` should be attached
- `#file:src/services.ts:89-94` should be attached

## Actual Behavior

- Only `#file:src/services.ts:89-94` is attached (the last reference)
- The first two references are silently ignored
- The last reference appears duplicated in the attachments

## Additional Context

**Works correctly:**

- Multiple full file references: `#file:config.json #file:main.ts` - both files are attached

**Fails:**

- Multiple file references with line ranges: only the last one is attached
- The `#selection` reference appears to have the same behavior when used multiple times

This significantly limits the ability to provide targeted context across multiple files when specific line ranges are relevant to the question.

## Environment

- Copilot Chat Extension Version: Originally reported in 0.32.4, still present in 0.36.0
- VS Code Version: 1.105.1+
- OS Version: Windows 11 (24H2)
- Feature: Chat (all modes: agent/edit/ask)
- Selected model: Sonnet 4.5
- Logs: Available upon request

**Status**: Upstream bug in VS Code/Copilot Chat - FlightPath works around this using XML attachments (see [CONTEXT_ATTACHMENT.md](CONTEXT_ATTACHMENT.md)).

## Impact

Users cannot reference multiple specific code sections from different files in a single message, requiring workarounds such as:

- Sending multiple separate messages
- Manually copying code into the message
- Using less precise full file references
- Using the context menu to "Add selection to chat" instead of typing `#selection` (this workaround does correctly attach all selections)

## Reproducibility

This issue occurs consistently (100% reproducible) across different file types and projects. The behavior has been verified through:

- Examination of AI responses that only reference the last attached file
- Debug log inspection showing only one line-range attachment
- Testing with 2, 3, and 4+ file references with line ranges
