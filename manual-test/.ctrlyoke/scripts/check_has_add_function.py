#!/usr/bin/env python3
"""
BROKEN / DO NOT USE AS A REAL endCondition: ctrlyoke never writes the AI's
chat response to a condition script's stdin (or anywhere else the script can
read). `sys.stdin.read()` below will block until the condition's timeout
kills the process rather than seeing any response text - this script has
never actually worked as an endCondition. Kept only because
manual-test/.ctrlyoke/simple.prompt.md references it for a "what does this
script do" reading exercise. For a real file-based check, use
check_file_contains.py (checks a file on disk) or check_counter.py-style
scripts instead.

Original intent: check if the Copilot response contains the word 'add' function.
Returns 'true' if found, 'false' otherwise.
"""
import sys

# Read the Copilot response from stdin
response = sys.stdin.read()

# Check if response contains 'add' (case-insensitive)
if 'add' in response.lower() and 'function' in response.lower():
    print('true')
else:
    print('false')
