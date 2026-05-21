# Security Audit - 2026-05-10

Reviewed `src/` with emphasis on high-impact, directly exploitable issues. I only included findings with high confidence.

## Findings

1. `[File: src/utils/CliProcessManager.ts:62]`
   `[Severity: High]`
   `[Issue Description]`
   The simple-prompt gate in `HarnessIntegration.isSimplePrompt()` only protects the fast path where the raw user prompt is sent inline with no extra attachments (`src/flightpath/HarnessIntegration.ts:826`, `src/flightpath/harness/shared/CliPromptPreparer.ts:106`). It does **not** sanitize the later categorized instruction string that is built when direct file references are present. In that path, `CliPromptPreparer` converts attacker-controlled `sections.directFileRefs` into `directRefs` (`src/flightpath/harness/shared/CliPromptPreparer.ts:222`), `CliIntegration.formatDirectFileRef()` only adds quotes for spaces (`src/flightpath/harness/CliIntegration.ts:298`), and `HarnessIntegration.formatCategorizedInstruction()` splices those refs back into the final prompt text (`src/flightpath/HarnessIntegration.ts:453`). That final string is then embedded into shell-launched harness commands in both modes: headless mode through `executeHeadless()` + `spawn(..., shell:true)` (`src/flightpath/harness/shared/CliTransportCoordinator.ts:317`, `src/utils/CliProcessManager.ts:62`) and interactive mode through `buildInteractiveTuiCommand()` plus `spawnInteractive(shell:true)` / `pwsh -Command` / `sh -c` (`src/flightpath/harness/shared/CliTransportCoordinator.ts:65`, `:145`, `src/utils/CliProcessManager.ts:248`). Most providers only escape double quotes in prompt text, for example Claude (`src/flightpath/harness/claude/ClaudeCliProvider.ts:473`), Copilot (`src/flightpath/harness/copilot/CopilotCliProvider.ts:508`), Codex (`src/flightpath/harness/codex/CodexCliProvider.ts:570`), OpenCode (`src/flightpath/harness/opencode/OpenCodeCliProvider.ts:239`), Qwen (`src/flightpath/harness/qwen/QwenCliProvider.ts:519`), and Gemini (`src/flightpath/harness/gemini/GeminiCliProvider.ts:418`). As a result, an attacker who distributes an untrusted workspace or workflow containing a referenced filename with shell interpolation syntax can turn an ordinary prompt step into local code execution when the victim runs the workflow. This is materially different from explicit `type: "script"` execution because the dangerous behavior is hidden inside a normal file-reference prompt path rather than an overt script step.`
`[Proposed Fix]`
`Stop invoking harnesses through a shell wherever possible. Pass the executable and argument array directly to `spawn()` / PTY APIs without `shell:true`, and remove provider-side manual quote wrapping. Independently, harden direct file references by escaping them for the target shell or by forbidding shell-significant characters in any file path that is re-emitted into prompt instruction strings.`

2. `[File: src/flightpath/EndConditionEvaluator.ts:204]`
   `[Severity: High]`
   `[Issue Description]`
   The workspace-only script restriction is enforced with naive string-prefix checks: `scriptPath.startsWith(workspaceRoot)` and `fullPath.startsWith(workspaceRoot)` (`src/flightpath/EndConditionEvaluator.ts:204` and `:222`). That check is bypassable with sibling paths that share the same prefix, for example `C:\dev\FlightPath-evil\payload.ps1` versus workspace root `C:\dev\FlightPath`, or with equivalent path tricks after resolution. Because `evaluateCondition()` executes the resolved path as a script, a malicious workflow can escape the intended workspace boundary and run arbitrary code from outside the repository while still passing the “workspace-only” guard.`
`[Proposed Fix]`
`Canonicalize both the workspace root and candidate path with `fs.realpath()` and enforce a path-boundary check (`candidate === root || candidate.startsWith(root + path.sep)`). Apply the same canonical check to absolute, working-directory-relative, and workspace-relative resolutions before execution. Add regression tests covering sibling-prefix paths and symlink escapes.`

## Notes

No additional OWASP-top-10 issues in `src/` met the requested confidence threshold during this pass.
