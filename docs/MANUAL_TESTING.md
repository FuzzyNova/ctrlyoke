# Manual Testing Quick Reference

## Starting a Test Session

1. **Press F5** in VS Code
2. Extension Development Host opens with `manual-test/` workspace automatically
3. FlightPath extension is active and ready to test

## Test Files Available

### Prompts (`.flightpath/` directory)

- `simple.prompt.md` - Basic markdown prompt
- `with-file.prompt.json` - Prompt with file attachment
- `multi-step.flightpath.json` - Three-step workflow
- `with-end-condition.prompt.json` - Prompt with end condition validation

### End Condition Scripts (`.flightpath/scripts/`)

- `always_true.py` - Always succeeds
- `always_false.py` - Always fails
- `timeout_test.py` - Tests timeout (60s sleep)
- `check_has_add_function.py` - Validates "add" function
- `check_typescript.js` - Detects TypeScript syntax

### Sample Code (`sample-code/`)

- `example.ts` - TypeScript UserManager class
- `example.py` - Python Inventory system

## Running Tests

**Right-click any prompt file:**

- **Send to CLI** - Uses Copilot CLI (default)
- **Send to Chat** - Uses Chat window automation

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

1. **Basic execution:** `simple.prompt.md` → Send to CLI
2. **File attachment:** `with-file.prompt.json` → Send to CLI
3. **Multi-step workflow:** `multi-step.flightpath.json` → Send to CLI
4. **End condition success:** `with-end-condition.prompt.json` → Send to CLI
5. **Chat mode:** Any prompt → Send to Chat

## Adding New Tests

Create files in `manual-test/.flightpath/`:

- New prompts: `.prompt.md` or `.prompt.json`
- New scripts: `.flightpath/scripts/yourscript.py`
- New code: `sample-code/yourfile.ts`

See `manual-test/README.md` for detailed documentation.
