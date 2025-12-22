# Manual Testing Quick Reference

## Starting a Test Session

1. **Press F5** in VS Code
2. Extension Development Host opens with `flightpath-test.code-workspace` (root directory with test settings)
3. FlightPath extension is active and ready to test
4. Test files are available in `manual-test/` directory

**Note:** The workspace file uses the project root (`.`), allowing you to:

- Access all manual tests in `manual-test/`
- Use FlightPath to develop FlightPath itself
- Run both instances side-by-side without duplicate project warnings

## Test Files Available

### Core Tests (`.flightpath/` directory)

- `simple.prompt.md` - Basic markdown prompt
- `with-file.flightpath.yaml` - Prompt with file attachment
- `with-end-condition.flightpath.yaml` - End condition validation
- `multi-step.flightpath.json` - Model switching test

### Retry Tests (root directory)

- `retry-counter-test.flightpath.json` - Basic retry with counter
- `retry-max-exhaustion-test.flightpath.json` - Max retries exhaustion
- `retry-timeout-error-test.flightpath.json` - Timeout error path
- `retry-multi-step-test.flightpath.json` - Multi-step with retries

### Special Feature Tests

- `agent-test.flightpath.json` - Agent switching (CLI only)
- `new-chat-session-test.flightpath.json` - Session control
- `multi-step-file-reference.flightpath.json` - File path references
- `dynamic-queue-basic-example.flightpath.json` - Dynamic queue
- `dynamic-queue-multi-stage.flightpath.json` - Complex dynamic queue

### End Condition Scripts (`.flightpath/scripts/`)

- `always_true.py` - Always succeeds
- `always_false.py` - Always fails
- `always_fails.py` - For retry exhaustion tests
- `timeout_test.py` - Timeout handling (60s sleep)
- `timeout_script.py` - Retry timeout testing (20s sleep)
- `check_counter.py` - Counter validation
- `check_counter_value.py` - Counter with target value
- `check_has_add_function.py` - Validates "add" function
- `check_typescript.js` - TypeScript detection

### Sample Code (`sample-code/`)

- `example.ts` - TypeScript UserManager class
- `example.py` - Python Inventory system

## Running Tests

**Right-click any prompt file:**

- **Run with FlightPath** - Executes using your configured provider
- **Load in FlightPath** - Loads into dashboard without running

**Command Palette (`Ctrl+Shift+P`):**

- FlightPath: Take Off
- FlightPath: Create Prompt File
- FlightPath: Create End Condition Script
- FlightPath: Show Copilot Status

## Monitoring

- **Status Bar** (bottom-left) - Shows FlightPath state
- **Output Panel** - "FlightPath" channel shows CLI responses
- **Problems Panel** - Shows any errors

## Common Test Scenarios

1. **Basic execution:** `simple.prompt.md` → Run with FlightPath
2. **File attachment:** `with-file.flightpath.yaml` → Run with FlightPath
3. **End condition:** `with-end-condition.flightpath.yaml` → Run with FlightPath
4. **Model switching:** `multi-step.flightpath.json` → Run with FlightPath
5. **Retry mechanism:** `retry-counter-test.flightpath.json` → Run with FlightPath
6. **Chat mode:** Set provider to "copilot-chat" in settings, then any prompt → Run with FlightPath

## Resetting Counter Tests

```powershell
echo 0 > manual-test\counter.txt
echo 0 > manual-test\multi-step-counter.txt
```

## Adding New Tests

Create files in `manual-test/.flightpath/`:

- New prompts: `.prompt.md` or `.flightpath.yaml`
- New workflows: `.flightpath.json`
- New scripts: `.flightpath/scripts/yourscript.py`
- New code: `sample-code/yourfile.ts`

See `manual-test/README.md` for detailed documentation.
