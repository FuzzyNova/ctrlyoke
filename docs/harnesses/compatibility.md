---
description: "Which workflow capabilities each harness supports, generated from the harness compatibility registry."
editLink: false
aside: false
---

<!-- AUTO-GENERATED — run `npm run generate-compatibility-docs` to update -->

# Harness compatibility

ctrlyoke keeps one workflow model across six CLI harnesses, but some workflow
features are translated differently or are not enforced by every harness. This
page is generated from the adapter-owned compatibility registry, the same
declarations that drive the dashboard's compatibility warnings.

## Compatibility matrix

✅ supported · ◐ partially supported · ❌ not supported · a superscript number links to the note that explains the limit.

| Capability | [Copilot](/harnesses/copilot-cli)<br>`copilot-cli` | [Claude Code](/harnesses/claude-cli)<br>`claude-cli` | [Codex](/harnesses/codex-cli)<br>`codex-cli` | [OpenCode](/harnesses/opencode-cli)<br>`opencode-cli` | [Qwen Code](/harnesses/qwen-cli)<br>`qwen-cli` | [Antigravity](/harnesses/antigravity-cli)<br>`antigravity-cli` |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **Permissions** |  |  |  |  |  |  |
| Allowed Tools | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-1">1</a></sup> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-2">2</a></sup> |
| Denied Tools | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-1">1</a></sup> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-2">2</a></sup> |
| Mode | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Partially supported">◐</span><sup><a href="#note-3">3</a></sup> |
| **Prompt Inputs** |  |  |  |  |  |  |
| Images | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-4">4</a></sup> | <span title="Not supported">❌</span><sup><a href="#note-4">4</a></sup> |
| **Hooks** |  |  |  |  |  |  |
| Error | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-5">5</a></sup> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-5">5</a></sup> | <span title="Not supported">❌</span><sup><a href="#note-5">5</a></sup> |
| Notification | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-5">5</a></sup> | <span title="Not supported">❌</span><sup><a href="#note-5">5</a></sup> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-5">5</a></sup> |
| Permission Request | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Partially supported">◐</span><sup><a href="#note-6">6</a></sup> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-5">5</a></sup> |
| Post Tool Use | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> |
| Pre Tool Use | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> |
| Session Start | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Partially supported">◐</span><sup><a href="#note-7">7</a></sup> | <span title="Supported">✅</span> | <span title="Supported">✅</span> |
| Stop | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> |
| User Prompt Submit | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-5">5</a></sup> |
| **MCP** |  |  |  |  |  |  |
| Per Server Tool Filtering | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Supported">✅</span> | <span title="Not supported">❌</span><sup><a href="#note-8">8</a></sup> |

### Notes

<a id="note-1"></a>**1.** Not supported because this harness uses sandbox/approval modes instead of individual tool patterns. _What to do:_ Remove the rule or select a harness that enforces individual tool patterns.<br>
Applies to **Codex**: Allowed Tools, Denied Tools.

<a id="note-2"></a>**2.** Not supported because this harness uses coarse permission modes instead of individual tool patterns. _What to do:_ Remove the rule or select a harness that enforces individual tool patterns.<br>
Applies to **Antigravity**: Allowed Tools, Denied Tools.

<a id="note-3"></a>**3.** Partially supported because this harness uses coarse permission modes instead of individual tool patterns. _What to do:_ Use a harness with exact permission-mode support when the distinction matters.<br>
Applies to **Antigravity**: Mode.

<a id="note-4"></a>**4.** Not supported because this harness has no verified native image-attachment path in the ctrlyoke CLI adapter. _What to do:_ Remove the image reference or select a harness with verified native image-input support.<br>
Applies to **Qwen Code**: Images · **Antigravity**: Images.

<a id="note-5"></a>**5.** Not supported because this harness exposes no native event ctrlyoke can map it to. _What to do:_ Remove the affected hook event or select a harness with verified support for it.<br>
Applies to **Codex**: Error, Notification · **OpenCode**: Notification · **Qwen Code**: Error · **Antigravity**: Error, Notification, Permission Request, User Prompt Submit.

<a id="note-6"></a>**6.** Partially supported because the hook fires but this harness's allow/deny response contract is unverified, so a returned decision may be ignored. _What to do:_ Remove the affected hook event or select a harness with verified support for it.<br>
Applies to **OpenCode**: Permission Request.

<a id="note-7"></a>**7.** Partially supported because this harness can start the main session before its plugin is listening, so the hook may not fire for it. _What to do:_ Remove the affected hook event or select a harness with verified support for it.<br>
Applies to **OpenCode**: Session Start.

<a id="note-8"></a>**8.** Not supported because this harness exposes no documented per-server tool filtering mechanism. _What to do:_ Remove the server filter or select a harness with verified per-server MCP filtering.<br>
Applies to **Antigravity**: Per Server Tool Filtering.

## How to read the matrix

- **Supported** means the adapter's behavior matches the workflow contract for
  the capability.
- **Partially supported** means the adapter translates or delivers only part
  of the workflow value.
- **Not supported** means the adapter does not enforce or attach that
  capability.
- The notes share their wording with author-time and preflight diagnostics.
  Simplify the value, or choose a harness that supports it, when a cell is
  not ✅.

## Verified versions

Each claim is backed by evidence for a harness version range. Installed
versions outside these ranges are shown as unverified by the dashboard.

| Domain | Copilot | Claude Code | Codex | OpenCode | Qwen Code | Antigravity |
| --- | --- | --- | --- | --- | --- | --- |
| Permissions | >=0.0.384 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping)) | >=2.1.17 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping)) | >=0.146.0 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#codex-partial-support-investigation)) | >=1.18.10 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts)) | >=0.20.1 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts)) | >=1.1.12 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#antigravity)) |
| Prompt Inputs | >=0.0.384 ([manual](https://docs.github.com/en/copilot/github-copilot-in-the-cli/using-github-copilot-in-the-cli#adding-files-to-your-prompt)) | >=2.1.17 ([manual](https://support.claude.com/en/articles/14554922-claude-code-user-faq)) | >=0.146.0 ([manual](https://developers.openai.com/codex/cli/reference/)) | >=1.18.10 ([manual](https://dev.opencode.ai/docs/cli/)) | — | — |
| Hooks | >=0.0.384 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/copilot/CopilotNotificationMonitor.ts)) | >=2.0.76 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/claude/ClaudeNotificationMonitor.ts)) | >=0.146.0 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/codex/CodexNotificationMonitor.ts)) | >=1.1.48 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/scripts/ctrlyoke-opencode-plugin.ts))<br>>=1.18.10 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/opencode/OpenCodeNotificationMonitor.ts)) | >=0.20.1 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/qwen/QwenNotificationMonitor.ts)) | >=1.1.12 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/antigravity/AntigravityNotificationMonitor.ts)) |
| MCP | >=0.0.384 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping)) | >=2.1.17 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping)) | >=0.146.0 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#codex-partial-support-investigation)) | >=1.18.10 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts)) | >=0.20.1 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts)) | >=1.1.12 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md#antigravity)) |

::: details How each harness implements these capabilities

- **native**: the harness supports the workflow value directly.
- **translated-cli**: ctrlyoke translates the value into the harness's CLI
  flags or inline configuration for each run.
- **workspace-config**: ctrlyoke writes the harness's workspace configuration
  (for example its hooks file) for the run.
- **mixed**: a combination of the mechanisms above.
- **none**: there is no mechanism; the capability is not supported.

| Capability | Copilot | Claude Code | Codex | OpenCode | Qwen Code | Antigravity |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **Permissions** |  |  |  |  |  |  |
| Allowed Tools | native | translated-cli | none | translated-cli | translated-cli | none |
| Denied Tools | native | translated-cli | none | translated-cli | translated-cli | none |
| Mode | native | native | native | translated-cli | translated-cli | native |
| **Prompt Inputs** |  |  |  |  |  |  |
| Images | native | native | native | native | none | none |
| **Hooks** |  |  |  |  |  |  |
| Error | workspace-config | workspace-config | none | native | none | none |
| Notification | workspace-config | workspace-config | none | none | workspace-config | none |
| Permission Request | workspace-config | workspace-config | translated-cli | native | workspace-config | none |
| Post Tool Use | workspace-config | workspace-config | translated-cli | native | workspace-config | workspace-config |
| Pre Tool Use | workspace-config | workspace-config | translated-cli | native | workspace-config | workspace-config |
| Session Start | workspace-config | workspace-config | translated-cli | native | workspace-config | workspace-config |
| Stop | workspace-config | workspace-config | translated-cli | native | workspace-config | workspace-config |
| User Prompt Submit | workspace-config | workspace-config | translated-cli | native | workspace-config | none |
| **MCP** |  |  |  |  |  |  |
| Per Server Tool Filtering | translated-cli | translated-cli | native | translated-cli | translated-cli | none |

:::

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

Uniform workflow features are intentionally absent from the matrix: execution
mode, sessions, MCP server injection, usage, workflow agents, and workflow
skills are shared ctrlyoke behavior rather than conditional harness claims.

_This page is generated. Run `npm run check:compatibility-docs` to verify that
the checked-in page still matches the registry declarations._
