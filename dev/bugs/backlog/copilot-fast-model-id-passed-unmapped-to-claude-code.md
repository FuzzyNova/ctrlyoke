# Copilot `claude-opus-4.8-fast` passed unmapped to Claude Code

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/ModelConstants.ts` (`getClaudeModelName`)
- **Severity:** medium

## Symptom

A claude-cli step whose model is the Copilot ID `claude-opus-4.8-fast` (listed in
`COPILOT_CLI_MODEL_IDS`) now runs `claude --model claude-opus-4.8-fast`. Claude Code
rejects that model name, so the step fails. Before ~188f3d612 the same ID was mapped to
the `opus` alias, and `docs/harnesses/claude-cli.md` still says "A Copilot-style ID such
as `claude-sonnet-4.6` is mapped to the alias for its family".

## Steps to Reproduce

1. `getClaudeModelName("claude-opus-4.8-fast")`.
2. Expected `"opus"` (Copilot-style dotted ID). Actual: `"claude-opus-4.8-fast"`.
3. In a workflow: set `model: claude-opus-4.8-fast` on a step and run it with
   `harness: claude-cli` (for example after switching the workflow's harness from
   copilot-cli). Claude Code receives an invalid `--model`.

## Root Cause

~188f3d612 replaced the substring family mapping with
`CLAUDE_ALIAS_SPELLING_PATTERN`
(`/^(?:claude-(fable|sonnet|opus|haiku)-\d+(?:\.\d+)+|…)$/`), which is anchored at the
end right after the dotted version. Copilot's variant suffixes (`-fast`) do not match, so
the ID falls through to the "contains `claude`" pass-through branch and is returned as
written.

## Suggested Fix

Allow Copilot's trailing variant suffix in the dotted-ID alternative, e.g.
`claude-(family)-\d+(?:\.\d+)+(?:-[a-z]+)*`. The dot is what distinguishes Copilot IDs
from Anthropic's dashed pinned IDs and Bedrock/Vertex IDs (`-v1:0`, `@2025…`), so those
keep passing through. Add a `ModelConstants.test.ts` case asserting every
`claude-*` entry in `COPILOT_CLI_MODEL_IDS` that has a dotted version maps to its family
alias, so a future Copilot ID with a new suffix is caught.
