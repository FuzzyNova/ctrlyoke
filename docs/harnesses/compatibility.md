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

<span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> supported · <span class="codicon codicon-color-mode compat-icon compat-partial" role="img" aria-label="Partially supported" title="Partially supported"></span> partially supported · <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span> not supported · a superscript number links to the note that explains the limit.

| Capability | [Copilot](/harnesses/copilot-cli)<br>`copilot-cli` | [Claude Code](/harnesses/claude-cli)<br>`claude-cli` | [Codex](/harnesses/codex-cli)<br>`codex-cli` | [OpenCode](/harnesses/opencode-cli)<br>`opencode-cli` | [Qwen Code](/harnesses/qwen-cli)<br>`qwen-cli` | [Antigravity](/harnesses/antigravity-cli)<br>`antigravity-cli` |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **Permissions** |  |  |  |  |  |  |
| Allowed Tools | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-color-mode compat-icon compat-partial" role="img" aria-label="Partially supported" title="Partially supported"></span><sup><a href="#note-1">1</a></sup> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-2">2</a></sup> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-3">3</a></sup> |
| Denied Tools | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-color-mode compat-icon compat-partial" role="img" aria-label="Partially supported" title="Partially supported"></span><sup><a href="#note-4">4</a></sup> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-3">3</a></sup> |
| Mode | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-color-mode compat-icon compat-partial" role="img" aria-label="Partially supported" title="Partially supported"></span><sup><a href="#note-5">5</a></sup> |
| **Prompt Inputs** |  |  |  |  |  |  |
| Images | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> |
| **Hooks** |  |  |  |  |  |  |
| Error | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-6">6</a></sup> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-6">6</a></sup> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-6">6</a></sup> |
| Notification | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-6">6</a></sup> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-6">6</a></sup> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-6">6</a></sup> |
| Permission Request | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-color-mode compat-icon compat-partial" role="img" aria-label="Partially supported" title="Partially supported"></span><sup><a href="#note-7">7</a></sup> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-6">6</a></sup> |
| Post Tool Use | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> |
| Pre Tool Use | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-color-mode compat-icon compat-partial" role="img" aria-label="Partially supported" title="Partially supported"></span><sup><a href="#note-8">8</a></sup> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> |
| Session Start | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-color-mode compat-icon compat-partial" role="img" aria-label="Partially supported" title="Partially supported"></span><sup><a href="#note-9">9</a></sup> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> |
| Stop | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> |
| User Prompt Submit | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-6">6</a></sup> |
| **MCP** |  |  |  |  |  |  |
| Per Server Tool Filtering | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-pass-compact compat-icon compat-supported" role="img" aria-label="Supported" title="Supported"></span> | <span class="codicon codicon-error-compact compat-icon compat-unsupported" role="img" aria-label="Not supported" title="Not supported"></span><sup><a href="#note-10">10</a></sup> |

### Notes

<a id="note-1"></a>**1.** Partially supported: Claude's own settings allow rules can add to this list in headless mode.<br>
Applies to **Claude Code**: Allowed Tools.

<a id="note-2"></a>**2.** Not supported because this harness uses sandbox/approval modes instead of individual tool patterns. _What to do:_ Remove the rule or select a harness that enforces individual tool patterns.<br>
Applies to **Codex**: Allowed Tools.

<a id="note-3"></a>**3.** Not supported because this harness uses coarse permission modes instead of individual tool patterns. _What to do:_ Remove the rule or select a harness that enforces individual tool patterns.<br>
Applies to **Antigravity**: Allowed Tools, Denied Tools.

<a id="note-4"></a>**4.** Partially supported because this harness enforces only mcp__&lt;server&gt;__&lt;tool&gt; denials for MCP servers the workflow attaches, and uses sandbox/approval modes instead of other tool patterns. _What to do:_ Narrow the rule to the supported subset or select a harness with exact list support.<br>
Applies to **Codex**: Denied Tools.

<a id="note-5"></a>**5.** Partially supported because this harness uses coarse permission modes instead of individual tool patterns. _What to do:_ Use a harness with exact permission-mode support when the distinction matters.<br>
Applies to **Antigravity**: Mode.

<a id="note-6"></a>**6.** Not supported because this harness exposes no native event ctrlyoke can map it to. _What to do:_ Remove the affected hook event or select a harness with verified support for it.<br>
Applies to **Codex**: Error, Notification · **OpenCode**: Notification · **Qwen Code**: Error · **Antigravity**: Error, Notification, Permission Request, User Prompt Submit.

<a id="note-7"></a>**7.** Partially supported because OpenCode delivers this event as notification-only; allow and deny decisions are not supported. _What to do:_ Remove the affected hook event or select a harness with verified support for it.<br>
Applies to **OpenCode**: Permission Request.

<a id="note-8"></a>**8.** Partially supported because this harness's pre-tool hook fires but cannot block the tool call. _What to do:_ Remove the affected hook event or select a harness with verified support for it.<br>
Applies to **OpenCode**: Pre Tool Use.

<a id="note-9"></a>**9.** Partially supported because this harness can start the main session before its plugin is listening, so the hook may not fire for it. _What to do:_ Remove the affected hook event or select a harness with verified support for it.<br>
Applies to **OpenCode**: Session Start.

<a id="note-10"></a>**10.** Not supported because this harness exposes no documented per-server tool filtering mechanism. _What to do:_ Remove the server filter or select a harness with verified per-server MCP filtering.<br>
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
  not marked supported.

## Supported versions

ctrlyoke supports each harness CLI release from roughly the past six months.
**Minimum** is the oldest supported release. A CLI older than that is still
launched, but ctrlyoke warns that it may not work correctly when a workflow
that uses it starts, the harness picker shows its update command, and a failed
step repeats that warning. Nothing warns when your
CLI is at or above the minimum. **Tested with** is the release this version of
ctrlyoke passed its harness test suite against, usually the latest at release
time; it is informational only, and newer releases are expected to work too.
Some features (for example context-window or usage indicators) can need a newer
CLI than the minimum, and so do most new models: the minimum covers ctrlyoke's
own features, not every model a CLI can run. When a CLI rejects a model, the
step fails with the CLI's own error. The minimum moves forward on that rolling window, or
sooner when a CLI release breaks something older versions can't work around.

|  | Copilot | Claude Code | Codex | OpenCode | Qwen Code | Antigravity |
| --- | --- | --- | --- | --- | --- | --- |
| Minimum | 1.0.19 | 2.1.94 | 0.129.0 | 1.3.16 | 0.15.5 | 1.2.6 |
| Tested with | 1.0.103 | 2.1.308 | 0.163.0 | 1.19.4 | 0.26.0 | 1.4.5 |
| Update | `copilot update` | `claude update` | `codex update` | `opencode upgrade` | `npm install -g @qwen-code/qwen-code@latest` | `agy update` |

## Verified versions

Each feature is backed by evidence for a harness version range. When a
workflow uses a feature and the installed CLI is outside its range, the
dashboard marks that feature as unverified; the harness itself still runs.

| Feature | Copilot | Claude Code | Codex | OpenCode | Qwen Code | Antigravity |
| --- | --- | --- | --- | --- | --- | --- |
| Permissions | >=0.0.384 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=2.1.17 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=0.129.0 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=1.3.16 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts)) | >=0.15.5 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts)) | >=1.1.12 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) |
| Images | >=0.0.384 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=2.1.17 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=0.129.0 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=1.3.16 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=0.15.5 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=1.4.4 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) |
| Hooks | >=1.0.19 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/copilot/CopilotNotificationMonitor.ts))<br>>=1.0.19 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=2.1.94 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=0.129.0 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/codex/CodexNotificationMonitor.ts))<br>>=0.129.0 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=1.3.16 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts))<br>>=1.3.16 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/opencode/OpenCodeNotificationMonitor.ts)) | >=0.15.5 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/qwen/QwenNotificationMonitor.ts))<br>>=0.15.5 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=1.1.12 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/antigravity/AntigravityNotificationMonitor.ts))<br>>=1.1.12 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) |
| Per Server Tool Filtering | >=0.0.384 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=2.1.17 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=0.129.0 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/capabilities.harness.test.ts)) | >=1.3.16 ([manual](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/core/harness/opencode/OpenCodeToolPermissionMapper.ts)) | >=0.15.5 ([behavioral-test](https://github.com/FuzzyNova/ctrlyoke/blob/main/src/test/harness/inline-config.harness.test.ts)) | >=1.1.12 (manual) |

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
