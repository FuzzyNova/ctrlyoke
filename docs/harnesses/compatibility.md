<!-- AUTO-GENERATED — run `npm run generate-compatibility-docs` to update -->

# Harness compatibility

ctrlyoke keeps one workflow model across six CLI harnesses, but some workflow
features are translated differently or are not enforced by every harness. This
page is generated from the adapter-owned compatibility registry. It records
the declared fidelity, mechanism, evidence, version scope, and the shared
caveat/remediation prose used by compatibility diagnostics.

## How to read the matrix

- **Exact** means the adapter's declared behavior matches the workflow
  contract for the capability.
- **Partial** means the adapter translates only part of the workflow value.
- **Unsupported** means the adapter does not enforce or attach that capability.
- **Evidence / verification scope** identifies the evidence kind, its basis,
  the covered harness versions, and the source used for the claim. Installed
  versions outside the listed ranges are shown as unverified by the dashboard.
- Caveats explain known architectural limits. Remediations are shared with
  author-time and preflight diagnostics; simplify the value or choose a
  harness with the required fidelity when a row is not exact.

## Portable workflow attachments and native discovery

Workflow [`agent` and `skills` attachments](/workflows/agents-and-skills) are
portable across all six harnesses. ctrlyoke resolves their selected files,
wraps agent content in `<agentInstructions>`, and supplies both categories as
prompt references. They are deliberately outside this conditional capability
matrix.

The optional **Agents & Skills** settings page is a separate convenience for
copying files into harness-native discovery directories. Native discovery can
enable ambient skills or native subagent spawning, and its layout and behavior
vary by harness. It does not determine whether a workflow's `agent` or
`skills` attachment works, and it is not the workflow property's execution
mechanism. See [Agents and skills](/workflows/agents-and-skills) for both
paths.

Uniform workflow features are intentionally absent from the table: execution
mode, sessions, MCP server injection, usage, workflow agents, and workflow
skills are shared ctrlyoke behavior rather than conditional harness claims.

## Compatibility matrix

| Harness | ID | Domain | Capability | Fidelity | Mechanism | Evidence / verification scope | Caveat | Remediation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GitHub Copilot CLI | copilot-cli | Permissions | Allowed Tools | exact | native | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping) | — | — |
| GitHub Copilot CLI | copilot-cli | Permissions | Denied Tools | exact | native | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping) | — | — |
| GitHub Copilot CLI | copilot-cli | Permissions | Mode | exact | native | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping) | — | — |
| GitHub Copilot CLI | copilot-cli | Prompt Inputs | Images | exact | native | manual; cli-version; >=0.0.384; [evidence](https://docs.github.com/en/copilot/github-copilot-in-the-cli/using-github-copilot-in-the-cli#adding-files-to-your-prompt) | — | — |
| GitHub Copilot CLI | copilot-cli | Hooks | Error | exact | workspace-config | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/copilot/CopilotNotificationMonitor.ts) | — | — |
| GitHub Copilot CLI | copilot-cli | Hooks | Permission Request | exact | workspace-config | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/copilot/CopilotNotificationMonitor.ts) | — | — |
| GitHub Copilot CLI | copilot-cli | Hooks | Post Tool Use | exact | workspace-config | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/copilot/CopilotNotificationMonitor.ts) | — | — |
| GitHub Copilot CLI | copilot-cli | Hooks | Pre Tool Use | exact | workspace-config | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/copilot/CopilotNotificationMonitor.ts) | — | — |
| GitHub Copilot CLI | copilot-cli | Hooks | Session Start | exact | workspace-config | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/copilot/CopilotNotificationMonitor.ts) | — | — |
| GitHub Copilot CLI | copilot-cli | Hooks | Stop | exact | workspace-config | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/copilot/CopilotNotificationMonitor.ts) | — | — |
| GitHub Copilot CLI | copilot-cli | Hooks | User Prompt Submit | exact | workspace-config | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/copilot/CopilotNotificationMonitor.ts) | — | — |
| GitHub Copilot CLI | copilot-cli | MCP | Per Server Tool Filtering | exact | translated-cli | manual; cli-version; >=0.0.384; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping) | — | — |
| Claude Code CLI | claude-cli | Permissions | Allowed Tools | exact | translated-cli | manual; cli-version; >=2.1.17; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping) | — | — |
| Claude Code CLI | claude-cli | Permissions | Denied Tools | exact | translated-cli | manual; cli-version; >=2.1.17; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping) | — | — |
| Claude Code CLI | claude-cli | Permissions | Mode | exact | native | manual; cli-version; >=2.1.17; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping) | — | — |
| Claude Code CLI | claude-cli | Prompt Inputs | Images | exact | native | manual; cli-version; >=2.1.17; [evidence](https://support.claude.com/en/articles/14554922-claude-code-user-faq) | — | — |
| Claude Code CLI | claude-cli | Hooks | Error | exact | workspace-config | manual; cli-version; >=2.0.76; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/claude/ClaudeNotificationMonitor.ts) | — | — |
| Claude Code CLI | claude-cli | Hooks | Permission Request | exact | workspace-config | manual; cli-version; >=2.0.76; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/claude/ClaudeNotificationMonitor.ts) | — | — |
| Claude Code CLI | claude-cli | Hooks | Post Tool Use | exact | workspace-config | manual; cli-version; >=2.0.76; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/claude/ClaudeNotificationMonitor.ts) | — | — |
| Claude Code CLI | claude-cli | Hooks | Pre Tool Use | exact | workspace-config | manual; cli-version; >=2.0.76; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/claude/ClaudeNotificationMonitor.ts) | — | — |
| Claude Code CLI | claude-cli | Hooks | Session Start | exact | workspace-config | manual; cli-version; >=2.0.76; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/claude/ClaudeNotificationMonitor.ts) | — | — |
| Claude Code CLI | claude-cli | Hooks | Stop | exact | workspace-config | manual; cli-version; >=2.0.76; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/claude/ClaudeNotificationMonitor.ts) | — | — |
| Claude Code CLI | claude-cli | Hooks | User Prompt Submit | exact | workspace-config | manual; cli-version; >=2.0.76; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/claude/ClaudeNotificationMonitor.ts) | — | — |
| Claude Code CLI | claude-cli | MCP | Per Server Tool Filtering | exact | translated-cli | manual; cli-version; >=2.1.17; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping) | — | — |
| Codex CLI | codex-cli | Permissions | Allowed Tools | unsupported | none | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#codex-partial-support-investigation) | because this harness uses sandbox/approval modes instead of individual tool patterns | Remove the rule or select a harness that enforces individual tool patterns. |
| Codex CLI | codex-cli | Permissions | Denied Tools | unsupported | none | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#codex-partial-support-investigation) | because this harness uses sandbox/approval modes instead of individual tool patterns | Remove the rule or select a harness that enforces individual tool patterns. |
| Codex CLI | codex-cli | Permissions | Mode | exact | native | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#codex-partial-support-investigation) | — | — |
| Codex CLI | codex-cli | Prompt Inputs | Images | exact | native | manual; cli-version; >=0.146.0; [evidence](https://developers.openai.com/codex/cli/reference/) | — | — |
| Codex CLI | codex-cli | Hooks | Error | unsupported | none | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/codex/CodexNotificationMonitor.ts) | — | Remove the affected hook event or select a harness with verified support for it. |
| Codex CLI | codex-cli | Hooks | Permission Request | exact | translated-cli | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/codex/CodexNotificationMonitor.ts) | — | — |
| Codex CLI | codex-cli | Hooks | Post Tool Use | exact | translated-cli | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/codex/CodexNotificationMonitor.ts) | — | — |
| Codex CLI | codex-cli | Hooks | Pre Tool Use | exact | translated-cli | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/codex/CodexNotificationMonitor.ts) | — | — |
| Codex CLI | codex-cli | Hooks | Session Start | exact | translated-cli | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/codex/CodexNotificationMonitor.ts) | — | — |
| Codex CLI | codex-cli | Hooks | Stop | exact | translated-cli | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/codex/CodexNotificationMonitor.ts) | — | — |
| Codex CLI | codex-cli | Hooks | User Prompt Submit | exact | translated-cli | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/codex/CodexNotificationMonitor.ts) | — | — |
| Codex CLI | codex-cli | MCP | Per Server Tool Filtering | exact | native | manual; cli-version; >=0.146.0; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#codex-partial-support-investigation) | — | — |
| OpenCode CLI | opencode-cli | Permissions | Allowed Tools | exact | translated-cli | behavioral-test; cli-version; >=1.18.10; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts) | — | — |
| OpenCode CLI | opencode-cli | Permissions | Denied Tools | exact | translated-cli | behavioral-test; cli-version; >=1.18.10; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts) | — | — |
| OpenCode CLI | opencode-cli | Permissions | Mode | exact | translated-cli | behavioral-test; cli-version; >=1.18.10; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts) | — | — |
| OpenCode CLI | opencode-cli | Prompt Inputs | Images | exact | native | manual; cli-version; >=1.18.10; [evidence](https://dev.opencode.ai/docs/cli/) | — | — |
| OpenCode CLI | opencode-cli | Hooks | Error | exact | native | manual; cli-version; >=1.1.48; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/scripts/ctrlyoke-opencode-plugin.ts) | — | — |
| OpenCode CLI | opencode-cli | Hooks | Permission Request | partial | native | manual; cli-version; >=1.1.48; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/scripts/ctrlyoke-opencode-plugin.ts) | — | Remove the affected hook event or select a harness with verified support for it. |
| OpenCode CLI | opencode-cli | Hooks | Post Tool Use | exact | native | manual; cli-version; >=1.1.48; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/scripts/ctrlyoke-opencode-plugin.ts) | — | — |
| OpenCode CLI | opencode-cli | Hooks | Pre Tool Use | exact | native | manual; cli-version; >=1.1.48; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/scripts/ctrlyoke-opencode-plugin.ts) | — | — |
| OpenCode CLI | opencode-cli | Hooks | Session Start | partial | native | manual; cli-version; >=1.1.48; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/scripts/ctrlyoke-opencode-plugin.ts) | — | Remove the affected hook event or select a harness with verified support for it. |
| OpenCode CLI | opencode-cli | Hooks | Stop | exact | native | manual; cli-version; >=1.1.48; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/scripts/ctrlyoke-opencode-plugin.ts) | — | — |
| OpenCode CLI | opencode-cli | Hooks | User Prompt Submit | exact | native | manual; cli-version; >=1.1.48; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/scripts/ctrlyoke-opencode-plugin.ts) | — | — |
| OpenCode CLI | opencode-cli | MCP | Per Server Tool Filtering | exact | translated-cli | behavioral-test; cli-version; >=1.18.10; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts) | — | — |
| Qwen Code CLI | qwen-cli | Permissions | Allowed Tools | exact | translated-cli | behavioral-test; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts) | — | — |
| Qwen Code CLI | qwen-cli | Permissions | Denied Tools | exact | translated-cli | behavioral-test; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts) | — | — |
| Qwen Code CLI | qwen-cli | Permissions | Mode | exact | translated-cli | behavioral-test; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts) | — | — |
| Qwen Code CLI | qwen-cli | Prompt Inputs | Images | unsupported | none | No version-scoped evidence recorded | because this harness has no verified native image-attachment path in the ctrlyoke CLI adapter | Remove the image reference or select a harness with verified native image-input support. |
| Qwen Code CLI | qwen-cli | Hooks | Error | unsupported | none | manual; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/qwen/QwenNotificationMonitor.ts) | — | Remove the affected hook event or select a harness with verified support for it. |
| Qwen Code CLI | qwen-cli | Hooks | Permission Request | exact | workspace-config | manual; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/qwen/QwenNotificationMonitor.ts) | — | — |
| Qwen Code CLI | qwen-cli | Hooks | Post Tool Use | exact | workspace-config | manual; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/qwen/QwenNotificationMonitor.ts) | — | — |
| Qwen Code CLI | qwen-cli | Hooks | Pre Tool Use | exact | workspace-config | manual; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/qwen/QwenNotificationMonitor.ts) | — | — |
| Qwen Code CLI | qwen-cli | Hooks | Session Start | exact | workspace-config | manual; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/qwen/QwenNotificationMonitor.ts) | — | — |
| Qwen Code CLI | qwen-cli | Hooks | Stop | exact | workspace-config | manual; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/qwen/QwenNotificationMonitor.ts) | — | — |
| Qwen Code CLI | qwen-cli | Hooks | User Prompt Submit | exact | workspace-config | manual; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/qwen/QwenNotificationMonitor.ts) | — | — |
| Qwen Code CLI | qwen-cli | MCP | Per Server Tool Filtering | exact | translated-cli | behavioral-test; cli-version; >=0.20.1; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts) | — | — |
| Antigravity CLI | antigravity-cli | Permissions | Allowed Tools | unsupported | none | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#antigravity) | because this harness uses coarse permission modes instead of individual tool patterns | Remove the rule or select a harness that enforces individual tool patterns. |
| Antigravity CLI | antigravity-cli | Permissions | Denied Tools | unsupported | none | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#antigravity) | because this harness uses coarse permission modes instead of individual tool patterns | Remove the rule or select a harness that enforces individual tool patterns. |
| Antigravity CLI | antigravity-cli | Permissions | Mode | partial | native | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#antigravity) | because this harness uses coarse permission modes instead of individual tool patterns | Use a harness with exact permission-mode support when the distinction matters. |
| Antigravity CLI | antigravity-cli | Prompt Inputs | Images | unsupported | none | No version-scoped evidence recorded | because this harness has no verified native image-attachment path in the ctrlyoke CLI adapter | Remove the image reference or select a harness with verified native image-input support. |
| Antigravity CLI | antigravity-cli | Hooks | Error | unsupported | none | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/antigravity/AntigravityNotificationMonitor.ts) | — | Remove the affected hook event or select a harness with verified support for it. |
| Antigravity CLI | antigravity-cli | Hooks | Permission Request | unsupported | none | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/antigravity/AntigravityNotificationMonitor.ts) | — | Remove the affected hook event or select a harness with verified support for it. |
| Antigravity CLI | antigravity-cli | Hooks | Post Tool Use | exact | workspace-config | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/antigravity/AntigravityNotificationMonitor.ts) | — | — |
| Antigravity CLI | antigravity-cli | Hooks | Pre Tool Use | exact | workspace-config | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/antigravity/AntigravityNotificationMonitor.ts) | — | — |
| Antigravity CLI | antigravity-cli | Hooks | Session Start | exact | workspace-config | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/antigravity/AntigravityNotificationMonitor.ts) | — | — |
| Antigravity CLI | antigravity-cli | Hooks | Stop | exact | workspace-config | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/antigravity/AntigravityNotificationMonitor.ts) | — | — |
| Antigravity CLI | antigravity-cli | Hooks | User Prompt Submit | unsupported | none | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/antigravity/AntigravityNotificationMonitor.ts) | — | Remove the affected hook event or select a harness with verified support for it. |
| Antigravity CLI | antigravity-cli | MCP | Per Server Tool Filtering | unsupported | none | manual; cli-version; >=1.1.12; [source](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#antigravity) | because this harness exposes no documented per-server tool filtering mechanism | Remove the server filter or select a harness with verified per-server MCP filtering. |

_This page is generated. Run `npm run check:compatibility-docs` to verify that
the checked-in page still matches the registry declarations._
