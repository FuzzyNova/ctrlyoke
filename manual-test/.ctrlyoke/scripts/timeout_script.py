#!/usr/bin/env python3
"""
End condition script that deliberately times out.
Used to test error path (not happy path - should NOT retry).
"""

import time
import sys

print("Starting long-running task...")
sys.stdout.flush()

# Sleep longer than the timeout specified in the test (20 seconds vs 5 second timeout)
time.sleep(20)

print("This should never be reached")
sys.exit(0)
