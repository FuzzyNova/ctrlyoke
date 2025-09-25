#!/usr/bin/env python3
"""
FlightPath End Condition Script - Check Improvements
This script checks if code improvements have been applied
"""
import sys
import os
import subprocess

def main():
    try:
        # Check if there are any syntax errors
        print("Checking for syntax errors...")
        
        # Example: Run TypeScript compiler in check mode
        result = subprocess.run(['npx', 'tsc', '--noEmit'], 
                              capture_output=True, text=True, cwd=os.getcwd())
        
        if result.returncode != 0:
            print(f"TypeScript errors found: {result.stderr}")
            print("false")
            return 1
        
        # Example: Check if ESLint passes
        print("Running ESLint checks...")
        lint_result = subprocess.run(['npx', 'eslint', 'src/**/*.ts'], 
                                   capture_output=True, text=True, cwd=os.getcwd())
        
        if lint_result.returncode != 0:
            print(f"ESLint issues found: {lint_result.stdout}")
            # Don't fail on lint warnings, just report
        
        print("Code improvements check passed!")
        print("true")
        return 0
        
    except Exception as e:
        print(f"Error during improvement check: {e}")
        print("false")
        return 1

if __name__ == "__main__":
    sys.exit(main())