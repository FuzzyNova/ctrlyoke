#!/bin/bash
# ctrlyoke End Condition Script Example
# This script checks if tests pass or some condition is met

# Example: Check if file exists
# if [ -f "some-file.txt" ]; then exit 0; else exit 1; fi

# Example: Run tests — the command's own exit code is already the verdict
# npm test

# For demo purposes, always succeed. The exit code is the whole contract:
# 0 passes, non-zero fails. Print anything you like for the log — it is only
# compared when the condition sets compareSource/operator/expected.
exit 0
