# Codex CLI Output Formatting Fixes

## Issues Fixed (2026-02-02)

### 1. ANSI Escape Codes Removal

**Problem**: PowerShell command output contained ANSI color codes (e.g., `\u001b[32;1mPath\u001b[0m`) that appeared as non-readable characters in the webview output.

**Root Cause**: Codex CLI captures raw terminal output from PowerShell, which includes ANSI formatting codes for colors and styles.

**Solution**: Added `stripAnsiCodes()` utility method to `CodexResponseParser.ts` that removes all ANSI escape sequences using the regex pattern `/\x1b\[[0-9;]*[a-zA-Z]/g`.

**Files Modified**:

- `src/flightpath/cli/codex/CodexResponseParser.ts`:
  - Added `stripAnsiCodes()` private method
  - Updated `parseItemToEvents()` to strip ANSI codes from command output
  - Updated `processStreamingChunk()` to strip ANSI codes from streaming deltas

### 2. File Edit Diff Information

**Problem**: File edit events showed "File update: path" but no diff visualization.

**Root Cause**: **Codex CLI does NOT provide file content or diff information** in its `file_change` events. The events only contain:

```json
{
  "type": "file_change",
  "changes": [
    {
      "path": "c:\\dev\\FlightPath\\temp_file.md",
      "kind": "update"
    }
  ],
  "status": "completed"
}
```

No `oldContent`, `newContent`, or `structuredPatch` fields are included.

**Solution**: Added graceful fallback messaging in `output-manager.js` to inform users when diff data is unavailable:

- Webview HTML output: Shows `⎿  (Diff not available)`
- Markdown export: Includes same message in exported output
- Note: Message is generic and applies to any provider that doesn't supply diff data

**Files Modified**:

- `src/ui/webview/output-manager.js`:
  - Updated `renderStructuredOutput()` fileEdit case to check for diff data availability
  - Updated `generateMarkdownOutput()` fileEdit case with same check

### 3. Status Badge Readability

**Problem**: Status badges `(initiated, exit: ?)` and `(completed, exit: 0)` had poor text contrast making them hard to read.

**Root Cause**: Background opacity was too low (0.2) and no border provided sufficient contrast.

**Solution**: Enhanced status badge styling with:

- Increased background opacity from 0.2 to 0.3
- Added subtle border (1px solid with 0.5 opacity) for better definition
- Maintained color consistency with VS Code theme variables

**Files Modified**:

- `src/ui/webview/dashboard.scss`:
  - Updated `.status-badge.success` styling
  - Updated `.status-badge.error` styling

## Codex CLI Limitations

### File Change Events

Codex CLI `file_change` events are **metadata-only** and do not include:

- File content (before/after)
- Unified diff patches
- Line-by-line changes

**Workaround**: FlightPath displays a message indicating diff is unavailable rather than silently showing nothing.

**Comparison with other CLIs**:

- **Claude CLI**: Provides `structuredPatch` with unified diff format including accurate line numbers
- **Copilot CLI**: Provides oldContent/newContent for diff generation
- **Codex CLI**: Only provides `{path, kind}` metadata

### ANSI Color Codes

Codex CLI captures raw terminal output including ANSI formatting codes. This is expected behavior for terminal output but requires stripping for webview display.

**Handled by**: `stripAnsiCodes()` method automatically removes all ANSI sequences.

## Testing Recommendations

To verify these fixes work correctly:

1. **ANSI Code Stripping**:
   - Run Codex CLI command that produces colored output (e.g., PowerShell directory listing)
   - Verify output in webview is clean text without escape sequences
   - Check markdown export doesn't contain `\u001b[` sequences

2. **File Edit Display**:
   - Run Codex CLI prompt that edits files
   - Verify "Diff not available" message appears in output
   - Confirm file paths are still shown correctly

3. **Status Badge Visibility**:
   - Run commands that succeed and fail
   - Verify both success (green) and error (red) badges are readable
   - Check in both light and dark VS Code themes

## Future Enhancements

If Codex CLI adds diff support in future versions, the following would need updates:

1. Check Codex event schema for new diff/content fields
2. Update `CodexResponseParser.parseItemToEvents()` to extract diff data
3. Remove "Diff not available" fallback messages from `output-manager.js`

## References

- Issue Report: FlightPath output window display issues with Codex CLI
- Raw Output Sample: `.flightpath/debug/codexResponseParserRawOutput1.log`
- Exported Output: `.flightpath/output/2026-02-02-19-16-29-flightpath-output.md`
