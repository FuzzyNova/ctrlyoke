#!/usr/bin/env python3
"""
End condition that simulates a timeout by sleeping longer than the timeout setting.
Useful for testing timeout handling in EndConditionEvaluator.
"""
import time

print('Starting long operation...', flush=True)
time.sleep(60)  # Sleep for 60 seconds (longer than default 30s timeout)
print('true')
