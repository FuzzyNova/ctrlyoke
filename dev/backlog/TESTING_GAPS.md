# Testing Gaps

_Auto-generated — do not edit by hand. Regenerated automatically by `npm run test:coverage` (extension host) and `npm run test:ui:coverage` (webview dashboard)._

Hand this file to a fresh agent to start closing coverage gaps without needing to run or parse coverage output first.

---

## Extension host — 81.73% statements covered (as of 2026-07-25 20:56 UTC)

Ranked by uncovered statement count (biggest win first). Full report: `coverage/extension/index.html`.

| File                                                     | Coverage | Uncovered / Total |
| -------------------------------------------------------- | -------: | ----------------: |
| `src/ui/CtrlYokeWebviewProvider.ts`                      |       0% |       1334 / 1334 |
| `src/dev/DevCommands.ts`                                 |       0% |         766 / 766 |
| `src/ui/WebviewMessageRouter.ts`                         |    51.5% |        723 / 1491 |
| `src/core/harness/CliLogMonitor.ts`                      |   22.06% |         618 / 793 |
| `src/core/WorkingFileManager.ts`                         |   65.27% |        606 / 1745 |
| `src/completions/PromptLinkProvider.ts`                  |       0% |         588 / 588 |
| `src/scripts/ctrlyoke-opencode-plugin.ts`                |       0% |         542 / 542 |
| `src/scripts/ctrlyoke-hook-utils.js`                     |       0% |         526 / 526 |
| `src/cli/CliTerminalFormatter.ts`                        |       0% |         504 / 504 |
| `src/completions/PromptCompletionProvider.ts`            |       0% |         498 / 498 |
| `src/completions/PromptPropertyCompletionProvider.ts`    |       0% |         468 / 468 |
| `src/core/harness/qwen/QwenResponseParser.ts`            |       0% |         384 / 384 |
| `src/ui/DashboardBroadcastHub.ts`                        |       0% |         368 / 368 |
| `src/completions/ContextMenuReferenceCommands.ts`        |       0% |         320 / 320 |
| `src/platform/vscode-shim.ts`                            |       0% |         313 / 313 |
| `src/core/WorkflowInstance.ts`                           |    92.7% |        270 / 3703 |
| `src/core/PromptQueue.ts`                                |   89.36% |        227 / 2134 |
| `src/core/WorkflowExecutor.ts`                           |   92.02% |        217 / 2720 |
| `src/scripts/ctrlyoke-antigravity-hook.js`               |       0% |         213 / 213 |
| `src/ui/NotificationManager.ts`                          |       0% |         193 / 193 |
| `src/core/orchestration/WorkflowLineageRepository.ts`    |   64.28% |         190 / 532 |
| `src/scripts/ctrlyoke-copilot-hook.js`                   |       0% |         189 / 189 |
| `src/core/WorkflowOrchestrator.ts`                       |    96.7% |        174 / 5281 |
| `src/core/harness/copilot/CopilotNotificationMonitor.ts` |       0% |         169 / 169 |
| `src/scripts/ctrlyoke-claude-hook.js`                    |       0% |         161 / 161 |
| `src/core/orchestration/HistorySearchIndexService.ts`    |   83.56% |         157 / 955 |
| `src/scripts/ctrlyoke-codex-notify.js`                   |       0% |         146 / 146 |
| `src/scm/ScmCommitCommand.ts`                            |       0% |         146 / 146 |
| `src/scripts/ctrlyoke-qwen-hook.js`                      |       0% |         142 / 142 |
| `src/core/harness/shared/CliExecutionRunner.ts`          |   84.47% |         132 / 850 |

_76 more file(s) below 100% not shown — see the HTML report._

---

## Webview dashboard (React) — 40.2% statements covered (as of 2026-07-10 17:27 UTC)

Ranked by uncovered statement count (biggest win first). Full report: `src/ui/webview-react/coverage/index.html`.

| File                                                                              | Coverage | Uncovered / Total |
| --------------------------------------------------------------------------------- | -------: | ----------------: |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`                     |    12.1% |         639 / 727 |
| `src/ui/webview-react/hooks/useOutputVirtualization.ts`                           |       0% |         411 / 411 |
| `src/ui/webview-react/hooks/useMessageHandler.ts`                                 |   48.23% |         395 / 763 |
| `src/ui/webview-react/components/editor/PromptEditor.tsx`                         |       0% |         294 / 294 |
| `src/ui/webview-react/components/output/TerminalInstance.tsx`                     |    1.36% |         288 / 292 |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx`              |       0% |         278 / 278 |
| `src/ui/webview-react/components/shared/UndoRedoControl.tsx`                      |       0% |         241 / 241 |
| `src/ui/webview-react/hooks/useDesktopLayout.ts`                                  |       0% |         234 / 234 |
| `src/ui/webview-react/components/settings/TerminalSection.tsx`                    |       0% |         225 / 225 |
| `src/ui/webview-react/components/output/OutputMinimap.tsx`                        |       0% |         212 / 212 |
| `src/ui/webview-react/components/workspace-viewer/WorkspaceSourceControlPane.tsx` |       0% |         209 / 209 |
| `src/ui/webview-react/components/settings/McpManagerSection.tsx`                  |   55.15% |         200 / 446 |
| `src/ui/webview-react/components/output/OutputRow.tsx`                            |   34.14% |         189 / 287 |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx`                     |       0% |         171 / 171 |
| `src/ui/webview-react/hooks/useOutputScrollSeek.ts`                               |       0% |         167 / 167 |
| `src/ui/webview-react/components/output/CliOutput.tsx`                            |   44.44% |         165 / 297 |
| `src/ui/webview-react/components/output/MarkdownText.tsx`                         |   47.46% |         145 / 276 |
| `src/ui/webview-react/components/workflow/TemplateModal.tsx`                      |       0% |         144 / 144 |
| `src/ui/webview-react/utils/markdownExport.ts`                                    |   39.05% |         142 / 233 |
| `src/ui/webview-react/components/output/TerminalView.tsx`                         |     4.1% |         140 / 146 |
| `src/ui/webview-react/components/shared/McpServersEditor.tsx`                     |    1.42% |         138 / 140 |
| `src/ui/webview-react/hooks/useOutputRowsModel.ts`                                |       0% |         126 / 126 |
| `src/ui/webview-react/utils/browserNotifications.ts`                              |    0.81% |         122 / 123 |
| `src/ui/webview-react/components/layout/OutputSection.tsx`                        |   69.05% |         121 / 391 |
| `src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx`                   |   56.08% |         119 / 271 |
| `src/ui/webview-react/components/output/UndoChangesDialog.tsx`                    |    42.5% |         115 / 200 |
| `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx`      |   55.85% |         113 / 256 |
| `src/ui/webview-react/components/settings/ServerSection.tsx`                      |       0% |         101 / 101 |
| `src/ui/webview-react/store/workflowStore.ts`                                     |    62.4% |          97 / 258 |
| `src/ui/webview-react/components/search/HistorySearchDrawer.tsx`                  |       0% |           92 / 92 |

_113 more file(s) below 100% not shown — see the HTML report._
