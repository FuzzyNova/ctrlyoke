# Test File Attachments

This prompt is a manual test that demonstrates the various types of file attachments supported in prompts. Please review the following attachments and confirm you received the actual attachments as expected:

1. Full file attachment: @src/extension.ts

2. Line range attachment: #file:src/flightpath/cli/CliIntegration.ts:90-130

3. Directory Attachment: @src/ui/

4. Symbol attachment: #sym:src/flightpath/cli/copilot/CopilotCliProvider.ts:buildInteractiveTuiCommand:100

5. Duplicate symbol attachment, you should only see it once despite being referenced multiple times: #sym:src/flightpath/cli/copilot/CopilotCliProvider.ts:buildInteractiveTuiCommand:100 and again #sym:src/flightpath/cli/copilot/CopilotCliProvider.ts:buildInteractiveTuiCommand:100. IF you see the full attachment more than once, please let me know, that means the test failed.

If all attachments are present and correct, please respond with "All attachments received successfully." otherwise, please specify which attachments are missing or incorrect.
