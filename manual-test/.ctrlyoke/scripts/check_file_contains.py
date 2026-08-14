#!/usr/bin/env python3
"""
End condition script that checks whether a file on disk contains a given
substring. Exits 0 in all cases (a failed check is a validation result, not a
script error) so onFail/retry handling works correctly.

Why a script can't just read the AI's response from stdin:
ctrlyoke end-condition scripts are NEVER given the AI's chat response text.
EndConditionEvaluator.evaluateCondition() only threads workflow `vars` through
(as CTRLYOKE_VAR_<KEY> env vars) - nothing is written to argv, env, or stdin.
CliProcessManager spawns condition scripts with stdin set to "pipe" (so a
script that merely probes for a handle doesn't see a closed/NUL stream), but
nothing ever writes to or closes that pipe. A script that calls
`sys.stdin.read()` expecting the assistant's reply blocks until the
condition's timeout kills it, instead of returning a real true/false. Verify
actual workflow state on disk instead, the same way check_counter.py does.

IMPORTANT: print ONLY "true"/"false" on stdout (send any diagnostics to
stderr). EndConditionEvaluator's default "auto" compare falls back to exit
code only when stdout doesn't literally equal "true"/"false"; since this
script always exits 0, extra stdout text after the boolean would silently
flip a real failure into a pass.

Usage:
    check_file_contains.py <path-relative-to-execution-root> <substring>

The path is resolved relative to the current working directory, which
ctrlyoke sets to the execution root (the worktree checkout, when the workflow
runs in one) - not this script's own directory.
"""
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("false")
        print("ERROR: usage: check_file_contains.py <path> <substring>", file=sys.stderr)
        return 0

    path, needle = sys.argv[1], sys.argv[2]
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError as e:
        print("false")
        print(f"ERROR: could not read {path}: {e}", file=sys.stderr)
        return 0

    if needle in content:
        print("true")
    else:
        print("false")
        print(f"'{needle}' not found in {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
