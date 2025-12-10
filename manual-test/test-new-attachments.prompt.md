# Test New Attachment Features

This prompt tests the newly implemented directory and symbol attachment features.

## Test 1: Directory Attachment

Analyze the architecture of @src/flightpath/ and explain how the different components interact.

## Test 2: Symbol Attachment

Review the implementation of #sym:FlightPathManager and suggest improvements to the initialization logic.

## Test 3: Combined References

Compare the symbol resolution in #sym:resolveSymbol with the directory structure of @src/utils/ to ensure proper organization.

## Expected Behavior

1. **@src/flightpath/** should attach a directory tree showing all files in that folder
2. **#sym:FlightPathManager** should resolve to the FlightPathManager class location and attach that code
3. **#sym:resolveSymbol** should resolve to the resolveSymbol function in AttachmentBuilders.ts
4. **@src/utils/** should show the utils directory structure

All attachments should be prepended as XML before this prompt text.
