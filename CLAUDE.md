<!-- AUTO-GENERATED — run `npm run generate-agent-files` to update -->
# FlightPath Project Memory

## Core Project Context

Always read the main project instructions:

@.github/copilot-instructions.md

## Instruction Files

The `.github/instructions/` directory contains detailed implementation guidelines organized by file scope. Read the relevant file before modifying code in that area.

| File Pattern                                  | Instruction File                         |
| --------------------------------------------- | ---------------------------------------- |
| `src/completions/**`                          | completions.instructions.md              |
| `src/config/**`                               | config.instructions.md                   |
| `src/dev/**`                                  | dev.instructions.md                      |
| `src/extension.ts, src/mcp-server.ts`         | extension.instructions.md                |
| `src/flightpath/harness/chat/**`              | flightpath-chat.instructions.md          |
| `src/cli.ts,src/cli/**`                       | flightpath-cli-binary.instructions.md    |
| `src/flightpath/*.ts`                         | flightpath-core.instructions.md          |
| `src/flightpath/orchestration/**`             | flightpath-orchestration.instructions.md |
| `src/git/**`                                  | git.instructions.md                      |
| `src/flightpath/harness/**`                   | harness-integrations.instructions.md     |
| `src/platform/**`                             | platform.instructions.md                 |
| `src/scm/**`                                  | scm.instructions.md                      |
| `src/scripts/**`                              | scripts.instructions.md                  |
| `src/server/**`                               | server.instructions.md                   |
| `src/templates/**`                            | templates.instructions.md                |
| `src/test/**`                                 | test.instructions.md                     |
| `src/types/**`                                | types.instructions.md                    |
| `src/ui/**` (excl. `src/ui/webview-react/**`) | ui.instructions.md                       |
| `src/utils/**`                                | utils.instructions.md                    |
| `src/ui/webview-react/**`                     | webview-react.instructions.md            |

### How to Use

**Before editing files in a specific directory:**

1. Identify which pattern matches the files you're working on
2. Read the corresponding instruction file in `.github/instructions/[filename]`
3. Apply the patterns and conventions described in that file

### Example

```
Working on src/flightpath/WorkflowOrchestrator.ts?
→ Read: .github/instructions/flightpath-core.instructions.md

Working on src/flightpath/harness/CliIntegration.ts?
→ Read: .github/instructions/harness-integrations.instructions.md
```

## Project Status

Pre-release — No backward compatibility constraints. Prioritize clean architecture and bold improvements.

## Key Principles

- **SOLID principles**: Separation of concerns, always look for opportunities to single source code and follow the DRY principle.
- **DRY (SINGLE SOURCE)**: Never duplicate code that can be single sourced in a helper function or base class.
- **TypeScript strict mode**: Comprehensive type safety
- **Single source of truth**: No hardcoded string duplication across files
- **Security first**: Workspace-scoped operations, process isolation for scripts
