# FlightPath Testing Guide

## Overview

FlightPath uses a hybrid testing approach:

- **Automated Tests**: Integration tests via VS Code's test harness (CI/CD friendly)
- **Manual Tests**: End-to-end testing requiring Copilot CLI/Chat (human verification)
- **Dashboard Tests**: WebView UI component testing

---

## Automated Tests

### Current Coverage (18 passing tests)

```
✨ 18 passing (24ms)
⏸️ 0 pending
❌ 0 failing
```

**Test Breakdown:**

- ✅ Extension activation and lifecycle (2 tests)
- ✅ Command registration (1 test)
- ✅ Copilot CLI detection (1 test)
- ✅ Configuration access (1 test)
- ✅ Chat commands availability (1 test)
- ✅ File attachment detection (1 test)
- ✅ Settings validation (2 tests)
- ✅ Core utilities - PromptQueue, ValidationUtils, PromptFileParser (8 tests)
- ✅ Workspace handling (1 test)

### Running Automated Tests

```bash
# Run all tests (auto-compiles via pretest hook)
npm test

# Or manually compile first
npm run compile          # Compiles extension with esbuild
npm run compile-tests    # Compiles tests with tsc
```

**Note:** The `pretest` script automatically runs both `compile` and `compile-tests` before tests, following VS Code extension testing best practices.

### Test Structure

```
src/test/
├── integration/
│   ├── cli.integration.test.ts    # CLI integration (6 tests)
│   ├── chat.integration.test.ts   # Chat integration (8 tests)
│   └── workflow.integration.test.ts
├── extension.test.ts              # Extension lifecycle
├── flightpath.test.ts             # Core utilities (8 tests)
├── runTest.ts                     # Test runner
└── suite/
    └── index.ts                   # Test suite loader
```

### Testing Philosophy

We use **real integration tests** instead of mocks because:

- Tests run in real VS Code with extension loaded
- Catches actual integration issues (no false positives)
- Matches VS Code extension testing best practices
- Simpler maintenance (no complex mock infrastructure)

---

## Manual Testing

### Quick Start

1. **Press F5** in VS Code
2. Extension Development Host opens with `flightpath-test.code-workspace` (root directory with test settings)
3. FlightPath extension is active and ready to test
4. Test files are available in `manual-test/` directory

### Test Files Available

**Prompts (`.flightpath/` directory):**

- `simple.prompt.md` - Basic markdown prompt
- `with-file.prompt.json` - Prompt with file attachment
- `multi-step.flightpath.json` - Three-step workflow
- `with-end-condition.prompt.json` - Prompt with end condition validation

**End Condition Scripts (`.flightpath/scripts/`):**

- `always_true.py` - Always succeeds
- `always_false.py` - Always fails
- `timeout_test.py` - Tests timeout (60s sleep)
- `check_has_add_function.py` - Validates "add" function
- `check_typescript.js` - Detects TypeScript syntax

### Running Tests

**Right-click any prompt file:**

- **Send to CLI** - Uses Copilot CLI (default)
- **Send to Chat** - Uses Chat window automation

**Command Palette (`Ctrl+Shift+P`):**

- FlightPath: Take Off
- FlightPath: Create Prompt File
- FlightPath: Create End Condition Script
- FlightPath: Show Copilot Status

### Common Test Scenarios

1. **Basic execution:** `simple.prompt.md` → Send to CLI
2. **File attachment:** `with-file.prompt.json` → Send to CLI
3. **Multi-step workflow:** `multi-step.flightpath.json` → Send to CLI
4. **End condition success:** `with-end-condition.prompt.json` → Send to CLI
5. **Chat mode:** Any prompt → Send to Chat

### Monitoring

- **Status Bar** (bottom-left) - Shows FlightPath state
- **Output Panel** - "FlightPath" channel shows CLI responses
- **Problems Panel** - Shows any errors

---

## Dashboard Testing

The FlightPath Dashboard is a WebView-based UI that displays real-time workflow execution progress.

### Opening the Dashboard

**Method A: Command Palette**

```
Ctrl+Shift+P → FlightPath: Open FlightPath Panel
```

**Method B: Status Bar**

- Click the FlightPath status bar item (bottom-left)

### Testing Checklist

#### Initial State

- ✅ "No file selected" in header
- ✅ "Select" and "Edit" buttons (Edit disabled)
- ✅ "Idle" execution state badge
- ✅ Run (▶), Pause (⏸), Stop (⏹) buttons
- ✅ Empty prompts list with "Select a prompt file to begin"
- ✅ Empty output section with "No output yet"

#### File Selection

1. Click **Select** button
2. Choose a `.flightpath.json` file
3. Verify:
   - ✅ File name appears in header
   - ✅ Edit button becomes enabled
   - ✅ Prompts list shows all steps
   - ✅ Each prompt shows "⏸️" (pending) icon

#### Workflow Execution

1. Click **Run (▶)** button
2. Verify:
   - ✅ Execution state changes to "Running"
   - ✅ Current prompt shows "▶️" (running) icon
   - ✅ Pause and Stop buttons become enabled
   - ✅ CLI output appears in output section
   - ✅ Progress counter updates (e.g., "Completed 1 of 3")

#### Pause/Resume

1. Click **Pause (⏸)** button
2. Verify execution state changes to "Paused"
3. Click **Resume (▶)** button
4. Verify workflow continues

#### Stop

1. Click **Stop (⏹)** button
2. Verify workflow stops completely

#### Responsive Layout

- **Wide (>= 800px):** Prompts and Output side-by-side
- **Narrow (< 800px):** Prompts and Output stacked vertically

### Component Files

- **Template**: `src/ui/webview/dashboard.html`
- **Styles**: `src/ui/webview/dashboard.css`
- **Logic**: `src/ui/webview/dashboard.js`
- **Provider**: `src/ui/FlightPathDashboardProvider.ts`

### Common Issues

| Issue                 | Solution                                          |
| --------------------- | ------------------------------------------------- |
| Dashboard not visible | Check View → FlightPath panel is open             |
| Template not loading  | Run `npm run compile`, check `out/ui/webview/`    |
| No CLI output         | Verify `flightpath.showCliOutput` is enabled      |
| Messages not updating | Check MESSAGE_TYPES constants match between files |

---

## Test Coverage Goals

### Currently Tested (Phase 1)

- ✅ Extension infrastructure (activation, commands, config)
- ✅ Core utilities (PromptQueue, ValidationUtils, PromptFileParser)
- ✅ CLI and Chat integration detection

### Future Testing (Phase 2+)

- [ ] CLI output parsing tests (mock child_process.spawn)
- [ ] PromptFileParser with various JSON formats
- [ ] EndConditionEvaluator script execution
- [ ] End-to-end workflow tests
- [ ] Coverage reporting with nyc/istanbul
- [ ] GitHub Actions CI/CD workflow

---

## Success Criteria

**Automated Tests:**

- 100% pass rate (18/18 tests)
- Fast execution (~25ms)
- No external dependencies (workspace, Copilot CLI)

**Manual Tests:**

- Extension loads without errors
- Workflows execute successfully
- Dashboard updates in real-time
- Pause/resume/stop controls work
- Both CLI and Chat modes functional
