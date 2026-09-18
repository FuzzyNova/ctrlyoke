@echo off
REM ctrlyoke End Condition Script Example
REM This script checks if tests pass or some condition is met

REM Example: Check if file exists
REM if exist "some-file.txt" ( exit 0 ) else ( exit 1 )

REM For demo purposes, always succeed. The exit code is the whole contract:
REM 0 passes, non-zero fails. Print anything you like for the log — output is
REM only compared when the condition sets compareSource/operator/expected.
exit 0
