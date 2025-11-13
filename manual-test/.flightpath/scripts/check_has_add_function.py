#!/usr/bin/env python3
"""
End condition script that checks if the Copilot response contains the word 'add' function.
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
