# Copilot Chat Harness Archival and Removal Plan

## Decision

This pre-release project has no active users and no backward-compatibility
commitment. Make a clean, hard removal of the `copilot-chat` harness; do not
ship it, hide it, deprecate it, or retain a compatibility path.

The current implementation automates VS Code Chat through command IDs that are
not documented as a stable extension contract, invokes `github.copilot.chat.*`
commands, and reads VS Code's private `workspaceStorage/**/chatSessions` files
across workspaces. GitHub's Copilot Extension Developer Policy prohibits use of
unpublished APIs, even though its exact applicability to a conventional VS Code
extension needs legal confirmation. This is an unacceptable release risk without
written GitHub/Microsoft approval for this exact integration.

This is a product-risk decision, not legal advice. Keep the source research and
vendor correspondence with the release-compliance record.

### Relevant primary sources

- [GitHub Copilot Extension Developer Policy](https://docs.github.com/en/site-policy/github-terms/github-copilot-extension-developer-policy)
- [GitHub Generative AI Services Terms](https://github.com/customer-terms/github-generative-ai-services-terms)
- [VS Code Command API](https://code.visualstudio.com/api/extension-guides/command)
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model)

## Goals

1. No released ctrlyoke artifact exposes, detects, creates, or executes the
   `copilot-chat` harness.
2. No released code accesses VS Code Copilot Chat commands or persisted Chat
   session storage.
3. Preserve the removed implementation only in Git history. Do not create a
   ZIP, source archive, in-product copy, dynamically loadable archive, or
   hidden configuration switch.
4. Leave the six supported harnesses and their shared abstractions clean and
   type-safe.

## Removal Scope

### Delete the implementation and tests

- Delete `src/core/harness/chat/**`.
- Delete Chat-only tests, including `src/test/chatSessionParser.test.ts` and
  `src/test/integration/chat.integration.test.ts`.
- Remove Chat-only developer commands and test fixtures from `src/dev/**`.
- Remove the `copilot-chat` branch from `VsCodeIntegrationFactory` and any
  Chat-only orchestration lifecycle code.

### Remove the public surface

- Remove `HARNESS_IDS.COPILOT_CHAT`, its display metadata, icons, model
  namespace, settings, defaults, schemas, and all `HarnessId` exclusions.
- Remove Chat options and conditional UI from the React dashboard, including
  hidden-dropdown-option behavior. A hidden option is insufficient.
- Remove all user documentation, templates, README tables, package description,
  and harness-installation guidance that name Copilot Chat.
- Remove the Chat-only MCP definition provider and its activation wiring if it
  has no use after the harness is gone.

### Clean shared code deliberately

Audit every `copilot-chat` reference with `rg -n "copilot-chat|Copilot Chat"`.
For each reference, either remove it or simplify the surrounding abstraction;
do not retain dormant branches, comments, type unions, or settings for a
potential return.

Pay particular attention to:

- `src/types/DashboardConstants.ts`
- `src/types/CtrlYokeTypes.ts`
- `src/types/CtrlYokeSettings.ts`
- `src/core/IntegrationFactory.ts` and `src/core/VsCodeIntegrationFactory.ts`
- `src/core/WorkflowOrchestrator.ts`, `WorkflowInstance.ts`, and
  `WorkflowExecutor.ts`
- `src/utils/ConfigurationUtils.ts`, `ModelConstants.ts`, and `ModelRegistry.ts`
- `src/ui/CtrlYokeMcpServerProvider.ts`
- `src/ui/webview-react/**`

## Clean-Break Handling

There are no active users and no backward-compatibility requirement. Remove
`copilot-chat` from the schema, types, settings, and runtime immediately. Do
not add a deprecation window, migration shim, legacy diagnostic, or automatic
substitution.

Update or delete any repository-owned workflow, fixture, documentation, and
template that names `copilot-chat`. A user-supplied legacy workflow will fail
normal schema validation; that is the intended clean-break behavior.

## Archival Procedure

1. Rely on the Git commit history as the archive. Do not copy the source into a
   ZIP, runtime folder, packaged extension, documentation site, or a separate
   archival artifact.
2. Do not archive actual Chat session files, prompts, outputs, or clipboard
   contents. They may contain workspace code or user data.

## Verification

- `rg -n -i "copilot-chat|copilot chat|github\.copilot\.chat|chatSessions" src
  docs README.md package.json` returns no production references.
- `npm run typecheck`, `npm run lint`, and the relevant extension/UI test suites
  pass.
- Build and inspect the VSIX: it contains no Chat harness implementation and
  no `copilot-chat` user-facing strings.
- Verify repository-owned workflows and fixtures no longer specify
  `harness: copilot-chat`.
- Run representative workflows for each remaining harness to confirm factory,
  settings, and dashboard behavior.

## Conditions for Reconsidering a VS Code-Based Copilot Integration

Do not restore this archived implementation. A future integration requires all
of the following:

1. Written GitHub/Microsoft authorization for the proposed use case, or a
   public, documented, supported API that covers it.
2. No invocation of unpublished commands and no reading of private Chat session
   storage.
3. Explicit user initiation and the consent flow required by the public API.
4. Rate-limit handling, clear automation disclosure, stop controls, human
   oversight for consequential actions, and tests against supported APIs only.

The preferred technical direction is the public VS Code Language Model API,
which supports extension requests to selected models with user consent. It is a
new integration design, not a compatibility layer for the removed UI harness.
