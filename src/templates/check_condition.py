#!/usr/bin/env python3
"""
ctrlyoke End Condition Script Example
This script checks if tests pass or some condition is met
"""
import sys
import subprocess
import os

def main():
    try:
        # Example: Run tests and check if they pass
        # result = subprocess.run(['npm', 'test'], capture_output=True, text=True)
        # return result.returncode

        # For demo purposes, always succeed. The exit code is the whole
        # contract: 0 passes, non-zero fails. Print anything you like for the
        # log — output is only compared when the condition sets
        # compareSource/operator/expected.
        return 0

    except Exception as e:
        print(f"Error: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
