#!/usr/bin/env python3
"""
End condition script for multi-step workflow testing.
Validates counter for different target values based on command line argument.
"""

import sys
import os

def check_counter(target_value: int) -> bool:
    """Check if multi-step-counter.txt contains the target value."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    counter_file = os.path.join(script_dir, "..", "..", "multi-step-counter.txt")
    
    try:
        with open(counter_file, 'r') as f:
            content = f.read().strip()
            current_value = int(content)
            
        if current_value == target_value:
            print("true")
            return True
        else:
            print("false")
            print(f"Counter is {current_value}, expected {target_value}")
            return False
            
    except Exception as e:
        print("false")
        print(f"ERROR: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("false")
        print("ERROR: Target value required as argument")
        sys.exit(0)
    
    target = int(sys.argv[1])
    check_counter(target)
    sys.exit(0)
