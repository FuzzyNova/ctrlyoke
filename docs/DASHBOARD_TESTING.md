# FlightPath Dashboard - Testing Guide

## Overview

The FlightPath Dashboard is a WebView-based UI that displays real-time workflow execution progress, CLI output, and step status.

## Quick Test

### 1. Open the Dashboard

**Method A: Command Palette**

```
Ctrl+Shift+P → FlightPath: Open FlightPath Panel
```

**Method B: Status Bar**

- Click the FlightPath status bar item (bottom-left)

**Method C: View Menu**

- View → Command Palette → FlightPath: Open FlightPath Panel

### 2. Verify Initial State

Dashboard should display:

- ✅ "No file selected" in header
- ✅ "Select" and "Edit" buttons (Edit disabled)
- ✅ "Idle" execution state badge
- ✅ Run (▶), Pause (⏸), Stop (⏹) buttons
- ✅ Empty prompts list with "Select a prompt file to begin"
- ✅ Empty output section with "No output yet"

### 3. Test File Selection

1. Click **Select** button
2. Choose `.flightpath/examples/zero-interaction-demo.flightpath.json`
3. Verify:
   - ✅ File name appears in header
   - ✅ Edit button becomes enabled
   - ✅ Prompts list shows all steps
   - ✅ Each prompt shows "⏸️" (pending) icon
   - ✅ Run button is enabled

### 4. Test Workflow Execution

1. Click **Run (▶)** button
2. Verify real-time updates:
   - ✅ Execution state changes to "Running"
   - ✅ Current prompt shows "▶️" (running) icon
   - ✅ Pause and Stop buttons become enabled
   - ✅ Status messages appear in prompt details
   - ✅ CLI output appears in output section (if CLI mode)
   - ✅ Progress counter updates (e.g., "Completed 1 of 3")

### 5. Test Pause/Resume

**During execution:**

1. Click **Pause (⏸)** button
2. Verify:
   - ✅ Execution state changes to "Paused"
   - ✅ Pause button becomes Resume (▶) button
   - ✅ Workflow stops advancing

3. Click **Resume (▶)** button
4. Verify:
   - ✅ Execution state returns to "Running"
   - ✅ Workflow continues from where it paused

### 6. Test Stop

**During execution:**

1. Click **Stop (⏹)** button
2. Verify:
   - ✅ Execution state changes to "Error" or "Idle"
   - ✅ Workflow stops completely
   - ✅ Controls reset to initial state

### 7. Test End Condition Display

**Use a file with end conditions:**

1. Select `manual-test/retry-counter-test.flightpath.json`
2. Run workflow
3. Verify:
   - ✅ Status message shows "Evaluating end condition"
   - ✅ End condition result appears in prompt details
   - ✅ Retry attempts display (if validation fails)

### 8. Test Retry Mechanism

**Using retry test file:**

1. Select `manual-test/retry-counter-test.flightpath.json`
2. Run workflow
3. Verify:
   - ✅ Retry counter appears (e.g., "🔄 Retry 1/3")
   - ✅ Status message shows retry attempt
   - ✅ CLI output shows multiple attempts

### 9. Test CLI Output Display

**In CLI mode (default):**

1. Run any workflow
2. Verify output section shows:
   - ✅ Prompt text in blue box
   - ✅ Response text in green box
   - ✅ Token statistics (📊)
   - ✅ Timing information (⏱️)
   - ✅ Streaming indicator while in progress

### 10. Test Autoscroll

1. Run a multi-step workflow
2. Verify:
   - ✅ Output section auto-scrolls to bottom
   - ✅ Uncheck "Autoscroll" checkbox
   - ✅ Output stops auto-scrolling
   - ✅ Re-check to resume auto-scrolling

### 11. Test Responsive Layout

**Wide layout (>= 800px):**

- ✅ Prompts and Output side-by-side
- ✅ Prompts section ~350px wide
- ✅ Output section fills remaining space

**Narrow layout (< 800px):**

- ✅ Prompts and Output stacked vertically
- ✅ Both sections full width

**Test by resizing VS Code window or panel**

## Component Verification

### HTML Template

- **File**: `src/ui/webview/dashboard.html`
- **Output**: `out/ui/webview/dashboard.html`
- **Verify**: Template uses `{{placeholders}}` for URIs
- **Verify**: CSP meta tag includes `{{cspSource}}`

### CSS Styling

- **File**: `src/ui/webview/dashboard.css`
- **Verify**: VS Code theme variables used (`--vscode-*`)
- **Verify**: Responsive media queries (800px breakpoint)
- **Verify**: Status icons have colors (✅ green, ❌ red, etc.)

### JavaScript Logic

- **File**: `src/ui/webview/dashboard.js`
- **Verify**: Imports constants from `FlightPathConstants`
- **Verify**: Message handlers for all MESSAGE_TYPES
- **Verify**: State management tracks execution progress

### Provider Integration

- **File**: `src/ui/FlightPathDashboardProvider.ts`
- **Verify**: Loads HTML template from file
- **Verify**: Replaces placeholders with webview URIs
- **Verify**: Handles messages from webview
- **Verify**: Sends updates to webview

## Common Issues

### Dashboard not visible

- Check View → FlightPath panel is open
- Verify extension is activated (check Output → FlightPath)

### HTML template not loading

- Run `npm run compile` to copy template
- Check `out/ui/webview/dashboard.html` exists
- Check console for error messages

### Styling looks broken

- Verify `dashboard.css` copied to output
- Check browser console (Help → Toggle Developer Tools)

### No CLI output appearing

- Verify `flightpath.showCliOutput` setting is enabled
- Check integration mode is "cli" (not "chat")
- Look for output in webview console

### Messages not updating

- Check webview is registered correctly
- Verify MESSAGE_TYPES constants match between files
- Check FlightPathManager calls dashboard methods

## Developer Testing

### Check Template Placeholders

```typescript
// In FlightPathDashboardProvider.getHtmlContent()
console.log("Constants URI:", constantsUri.toString());
console.log("Script URI:", scriptUri.toString());
console.log("Style URI:", styleUri.toString());
console.log("CSP Source:", webview.cspSource);
```

### Monitor Message Flow

```javascript
// In dashboard.js message handler
window.addEventListener("message", (event) => {
  console.log("[Dashboard] Received message:", event.data);
  // ... existing handler
});
```

### Verify State Updates

```javascript
// After state changes in dashboard.js
console.log("[Dashboard] State updated:", state);
```

## Build Verification

After making changes:

1. **Compile**:

   ```bash
   npm run compile
   ```

2. **Verify files copied**:

   ```bash
   ls out/ui/webview/
   # Should show: dashboard.html, dashboard.css, dashboard.js, DashboardConstants.js
   ```

3. **Check template content**:

   ```bash
   cat out/ui/webview/dashboard.html
   # Should contain {{placeholders}} not actual URIs
   ```

4. **Test in extension**:
   - Press F5 to launch Extension Development Host
   - Open FlightPath panel
   - Run test workflow

## Next Steps

After verifying basic functionality:

1. **Test with real workflows** - Use actual prompt files from your projects
2. **Test retry mechanism** - Create workflows with end conditions
3. **Test error handling** - Simulate failures and timeouts
4. **Test performance** - Run workflows with many steps
5. **Test edge cases** - Empty files, malformed JSON, missing scripts

## Success Criteria

✅ Dashboard loads without errors
✅ File selection works
✅ Workflow execution displays progress
✅ Pause/resume/stop controls work
✅ CLI output appears in real-time
✅ Retry attempts display correctly
✅ Status messages update properly
✅ Responsive layout adapts to panel size
✅ Autoscroll functions correctly
✅ Styling matches VS Code theme
