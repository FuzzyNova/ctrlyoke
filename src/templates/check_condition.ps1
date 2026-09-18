# ctrlyoke End Condition Script Example
# This script checks if tests pass or some condition is met

# Example: Check if file exists
# if (Test-Path "some-file.txt") { exit 0 } else { exit 1 }

# For demo purposes, always succeed. The exit code is the whole contract:
# 0 passes, non-zero fails. Print anything you like for the log — output is
# only compared when the condition sets compareSource/operator/expected.
exit 0
