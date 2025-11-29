# FlightPath Execution Output

**File:** script-error-test.flightpath.json
**Exported:** 2025-11-29T05:09:56.520Z
**Status:** completed
**Progress:** 0 of 1 completed

---

> **[11:09:22 PM]** Starting Prompt 1: This is a test to verify script error handling....

## Prompt 1 - Initial Attempt

### Prompt

```
This is a test to verify script error handling.

Please respond with: 'I acknowledge this test will have a script error.'

This tests that script execution errors (non-zero exit codes) are properly displayed in the output.
```

### CLI Command

```bash
$ claude -p --output-format json --model claude-haiku-4-5-20251001 --add-dir c:\dev\FlightPath\manual-test --dangerously-skip-permissions
```

### Response

```
I acknowledge this test will have a script error.
```

*📊 Tokens: 3 prompt / 13 completion | ⏱️ 6s*

---

> **[11:09:28 PM]** Evaluating end condition: Running throws_error.py

> **[11:09:28 PM]** End condition Failed ✗ - Output: Error: Script crashed with unexpected exception
Traceback (most recent call last):
  File 'throws_...
