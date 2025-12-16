# Test FlightPath Link Provider

This prompt file tests all 4 types of clickable links:

## 1. Full File References

Click these to open files:

- @src/extension.ts
- @src/completions/PromptCompletionProvider.ts
- @src/completions/PromptLinkProvider.ts
- @README.md

## 2. Directory References

Click these to reveal directories in Explorer:

- @src/
- @src/completions/
- @docs/
- @manual-test/

## 3. Line Range References

Click these to open files with line selection:

- #file:src/extension.ts:1-20
- #file:src/completions/PromptCompletionProvider.ts:25-40
- #file:src/completions/PromptLinkProvider.ts:80-120

## 4. Symbol References

Click these to navigate to symbol definitions:

- #sym:src/extension.ts:activate:14
- #sym:src/completions/PromptCompletionProvider.ts:provideCompletionItems:30
- #sym:src/completions/PromptLinkProvider.ts:provideDocumentLinks:45

## Test Instructions

1. Hover over any reference above - you should see a tooltip
2. Ctrl+Click (Cmd+Click on Mac) to navigate
3. File references should open the file at the top
4. Directory references should reveal the folder in File Explorer
5. Line range references should open the file with lines selected
6. Symbol references should navigate to the symbol location

All links should be underlined when you hover with Ctrl held down.
