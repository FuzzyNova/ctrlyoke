#!/usr/bin/env python3
"""
End condition script that throws an actual error (for testing error path display).
This simulates a script crash/exception, not a validation failure.
"""

import sys

# Print to stderr to simulate an error
print("Error: Script crashed with unexpected exception", file=sys.stderr)
print("Traceback (most recent call last):", file=sys.stderr)
print("  File 'throws_error.py', line 15", file=sys.stderr)
print("RuntimeError: Simulated script crash for testing", file=sys.stderr)

# Exit with non-zero to indicate execution error (not validation failure)
sys.exit(1)
