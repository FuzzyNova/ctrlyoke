#!/usr/bin/env python3
"""
End condition script that validates the counter value.

Reads counter.txt and checks if the value equals the expected target.
Exits with 0 on both success and validation failure (required for retry mechanism).
"""

import sys
import os

def check_counter(target_value: int) -> bool:
    """Check if counter.txt contains the target value."""
    # Get the path to counter.txt (one level up from .ctrlyoke/scripts/)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    counter_file = os.path.join(script_dir, "..", "..", "counter.txt")
    
    try:
        with open(counter_file, 'r') as f:
            content = f.read().strip()
            current_value = int(content)
            
        if current_value == target_value:
            print("true")
            return True
        else:
            # Provide helpful output for retry prompt
            print("false")
            print(f"Counter is currently {current_value}, expected {target_value}")
            print(f"Need to increment {target_value - current_value} more time(s)")
            return False
            
    except FileNotFoundError:
        print("false")
        print("ERROR: counter.txt not found")
        return False
    except ValueError as e:
        print("false")
        print(f"ERROR: Invalid counter value - {e}")
        return False
    except Exception as e:
        print("false")
        print(f"ERROR: {e}")
        return False

if __name__ == "__main__":
    # Default target is 3, but can be overridden via command line
    target = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    
    success = check_counter(target)
    
    # Always exit with 0 - validation failures are NOT execution errors
    # This is critical for the retry mechanism to work
    sys.exit(0)
