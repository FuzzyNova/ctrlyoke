# FlightPath Claude Code CLI Integration - Epic Breakdown

**Author:** Nathan  
**Date:** 2025-11-28  
**Project Level:** Brownfield Enhancement  
**Target Scale:** VS Code Extension - Developer Tool  
**Implementation Status:** ✅ Epics 1-4 Complete (17/21 stories)

---

## Overview

This document provides the complete epic and story breakdown for FlightPath Claude Code CLI Integration, decomposing the requirements from the [PRD](./prd.md) into implementable stories.

**Living Document Notice:** This is the initial version created from PRD requirements. It will be updated after UX Design and Architecture workflows add interaction and technical details to stories.

### Epic Summary

| Epic | Title                          | Goal                                                        | Stories | Status  |
| ---- | ------------------------------ | ----------------------------------------------------------- | ------- | ------- |
| 1    | Foundation & Configuration     | Enable Claude CLI as a provider option with proper settings | 4       | ✅ Done |
| 2    | CLI Detection & Initialization | Users can seamlessly detect and connect to Claude Code CLI  | 4       | ✅ Done |
| 3    | Prompt Execution & Streaming   | Users can send prompts and receive real-time responses      | 5       | ✅ Done |
| 4    | Session Management             | Users can maintain conversation context across prompts      | 4       | ✅ Done |
| 5    | Dashboard & Status Integration | Users can monitor Claude CLI activity in the FlightPath UI  | 4       | 🔲 TODO |

**Total: 5 Epics, 21 Stories (17 Complete, 4 Remaining)**

---

## Functional Requirements Inventory

| FR #     | Category                | Description                                                                          |
| -------- | ----------------------- | ------------------------------------------------------------------------------------ |
| **FR1**  | Core Integration        | System can detect if Claude Code CLI is installed by running `claude --version`      |
| **FR2**  | Core Integration        | System reports Claude CLI availability status (Ready, Unavailable, Initializing)     |
| **FR3**  | Core Integration        | System can send prompts to Claude Code using `-p` flag for non-interactive execution |
| **FR4**  | Core Integration        | System receives complete response when Claude Code CLI command exits                 |
| **FR5**  | Core Integration        | System can stream response chunks in real-time during execution                      |
| **FR6**  | Model Selection         | Users can configure default Claude model via VS Code settings                        |
| **FR7**  | Model Selection         | Prompts can override model on a per-prompt basis via `model` field                   |
| **FR8**  | Model Selection         | System validates model against supported models and warns on unsupported             |
| **FR9**  | Model Selection         | System supports both model aliases (`sonnet`) and full names                         |
| **FR10** | Session Management      | System can start new conversation sessions                                           |
| **FR11** | Session Management      | System can continue most recent session using `-c` flag                              |
| **FR12** | Session Management      | System can resume specific session by ID using `-r` flag                             |
| **FR13** | Session Management      | `newChatSession: true` in prompt starts fresh session                                |
| **FR14** | Session Management      | `newChatSession: false` continues existing session                                   |
| **FR15** | Directory & Permissions | System automatically adds workspace directories via `--add-dir`                      |
| **FR16** | Directory & Permissions | Users can configure additional allowed directories                                   |
| **FR17** | Directory & Permissions | System can skip all permission prompts with `--dangerously-skip-permissions`         |
| **FR18** | Directory & Permissions | Users can configure specific allowed/disallowed tool patterns                        |
| **FR19** | Directory & Permissions | Tool permission configuration mirrors Copilot CLI patterns                           |
| **FR20** | Output Handling         | System parses Claude response from stdout                                            |
| **FR21** | Output Handling         | System can use JSON output format for structured parsing                             |
| **FR22** | Output Handling         | System extracts token usage statistics when available                                |
| **FR23** | Output Handling         | System provides response text to end condition evaluators                            |
| **FR24** | Output Handling         | System logs prompts and responses to Output channel (when enabled)                   |
| **FR25** | Event System            | System fires status change events (Initializing → Ready/Unavailable)                 |
| **FR26** | Event System            | System fires response complete events with response text                             |
| **FR27** | Event System            | System fires streaming chunk events during execution                                 |
| **FR28** | Event System            | System fires prompt ready events before execution starts                             |
| **FR29** | Error Handling          | System handles Claude CLI not found gracefully                                       |
| **FR30** | Error Handling          | System handles execution errors with user-friendly messages                          |
| **FR31** | Error Handling          | System handles timeout with configurable duration                                    |
| **FR32** | Error Handling          | System provides enhanced error messages for common issues                            |
| **FR33** | Cancellation            | Users can cancel running Claude CLI process                                          |
| **FR34** | Cancellation            | Cancellation kills active process cleanly                                            |
| **FR35** | Cancellation            | System resets state properly after cancellation                                      |
| **FR36** | Dashboard Integration   | Dashboard displays Claude CLI prompts and responses                                  |
| **FR37** | Dashboard Integration   | Dashboard shows token statistics when available                                      |
| **FR38** | Dashboard Integration   | Dashboard indicates which CLI provider is active                                     |
| **FR39** | Dashboard Integration   | Status bar reflects Claude CLI status                                                |

---

## FR Coverage Map

| Epic                                   | Functional Requirements Covered                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Epic 1: Foundation & Configuration     | FR6, FR7, FR8, FR9, FR15, FR16, FR17, FR18, FR19                                            |
| Epic 2: CLI Detection & Initialization | FR1, FR2, FR25, FR29, FR32                                                                  |
| Epic 3: Prompt Execution & Streaming   | FR3, FR4, FR5, FR20, FR21, FR22, FR23, FR24, FR26, FR27, FR28, FR30, FR31, FR33, FR34, FR35 |
| Epic 4: Session Management             | FR10, FR11, FR12, FR13, FR14                                                                |
| Epic 5: Dashboard & Status Integration | FR36, FR37, FR38, FR39                                                                      |

**Coverage Validation:** ✅ All 39 FRs mapped to epics and stories

---

## Epic 1: Foundation & Configuration ✅ COMPLETED

**Goal:** Enable Claude CLI as a provider option in FlightPath with proper type definitions, model constants, and VS Code settings so users can configure their preferred CLI provider.

**User Value:** After this epic, users can select Claude Code CLI as their provider and configure model preferences, directory access, and tool permissions through VS Code settings.

---

### Story 1.1: Add Claude Model Constants and Type Definitions ✅ DONE

As a **developer**,  
I want **Claude model constants and type definitions added to the codebase**,  
So that **the type system supports Claude CLI integration with proper validation**.

**Acceptance Criteria:**

**Given** the FlightPath extension codebase  
**When** I add Claude model constants to `src/types/ModelConstants.ts`  
**Then** the following constants are defined:

- `CLAUDE_CLI_MODEL_ALIASES` array with `["sonnet", "opus", "haiku"]`
- `CLAUDE_CLI_MODELS` array with full model names (e.g., `claude-sonnet-4-5-20250929`)
- `CLAUDE_CLI_DEFAULT_MODEL` constant set to `"sonnet"`

**And** I add to `src/types/FlightPathTypes.ts`:

- `"claude-cli"` added to `IntegrationMode` type union
- `ClaudeCliStatus` type with `"Initializing" | "Ready" | "Unavailable"` states

**And** all existing TypeScript compilation passes without errors

**Prerequisites:** None (first story)

**Technical Notes:**

- Follow existing pattern in `ModelConstants.ts` for Copilot models
- Keep model aliases lowercase for user convenience
- Full model names should match Claude's official naming convention

---

### Story 1.2: Add Claude CLI Settings to package.json ✅ DONE

As a **user**,  
I want **Claude CLI configuration options in VS Code settings**,  
So that **I can configure my preferred Claude model and permissions**.

**Acceptance Criteria:**

**Given** the FlightPath extension `package.json`  
**When** I add Claude CLI settings under `contributes.configuration.properties`  
**Then** the following settings are available:

| Setting                               | Type  | Default     | Description                                             |
| ------------------------------------- | ----- | ----------- | ------------------------------------------------------- |
| `flightpath.claudeCliModel`           | enum  | `"sonnet"`  | Default model (sonnet, opus, haiku)                     |
| `flightpath.claudeCliToolPermissions` | enum  | `"skipAll"` | Permission mode (skipAll, custom)                       |
| `flightpath.cliAllowedTools`          | array | `[]`        | Shared tool patterns (Copilot format, auto-converted)   |
| `flightpath.cliDeniedTools`           | array | `[]`        | Shared denied patterns (Copilot format, auto-converted) |
| `flightpath.claudeCliOutputFormat`    | enum  | `"json"`    | Output format (json, text)                              |

**Note:** Tool settings are shared between Copilot and Claude CLI. Patterns use Copilot CLI format and are auto-converted for Claude (`shell` → `Bash`, `write` → `Write`).

**And** `flightpath.copilotIntegrationMode` enum is updated to include:

- `"copilot-cli"` (replaces current `"cli"`)
- `"claude-cli"` (new option)
- `"copilot-chat"` (existing, renamed from `"chat"`)

**And** each setting has `enumDescriptions` for user-friendly dropdowns

**Prerequisites:** Story 1.1

**Technical Notes:**

- Follow existing naming pattern: `flightpath.claudeCli*`
- Use `markdownDescription` for rich formatting in settings UI
- Ensure backward compatibility: `"cli"` should still work (maps to `"copilot-cli"`)

---

### Story 1.3: Create ClaudeCommandLineIntegration Class Skeleton ✅ DONE

As a **developer**,  
I want **a skeleton `ClaudeCommandLineIntegration` class that extends `CopilotIntegration`**,  
So that **the class hierarchy is established for Claude CLI implementation**.

**Acceptance Criteria:**

**Given** the abstract `CopilotIntegration` base class  
**When** I create `src/flightpath/cli/ClaudeCommandLineIntegration.ts`  
**Then** the class:

- Extends `CopilotIntegration` abstract base class
- Implements all required abstract methods with placeholder/stub implementations
- Has constructor accepting `ExtensionContext` and `OutputChannel`
- Initializes with `"Initializing"` status

**And** the class compiles without TypeScript errors  
**And** all abstract methods throw `"Not implemented"` errors as stubs

**Prerequisites:** Story 1.1

**Technical Notes:**

- Mirror structure of `CopilotCommandLineIntegration.ts`
- Abstract methods to implement: `initialize()`, `sendPrompt()`, `cancelCurrentOperation()`, `getStatus()`
- Import from `../base/CopilotIntegration`

---

### Story 1.4: Update FlightPathManager Factory Pattern ✅ DONE

As a **user**,  
I want **FlightPathManager to instantiate the correct CLI integration based on settings**,  
So that **I can switch between Copilot and Claude CLI by changing one setting**.

**Acceptance Criteria:**

**Given** the `flightpath.copilotIntegrationMode` setting  
**When** the setting value is `"claude-cli"`  
**Then** `FlightPathManager.createCopilotIntegration()` returns a `ClaudeCommandLineIntegration` instance

**And** when the setting value is `"copilot-cli"` or `"cli"`  
**Then** it returns a `CopilotCommandLineIntegration` instance (existing behavior)

**And** when the setting value is `"copilot-chat"` or `"chat"`  
**Then** it returns a `CopilotChatIntegration` instance (existing behavior)

**And** the factory method logs which integration mode was selected to the output channel

**Prerequisites:** Story 1.2, Story 1.3

**Technical Notes:**

- Update `createCopilotIntegration()` method in `FlightPathManager.ts`
- Handle backward compatibility for old setting values (`"cli"` → `"copilot-cli"`)
- Import `ClaudeCommandLineIntegration` at top of file

---

## Epic 2: CLI Detection & Initialization ✅ COMPLETED

**Goal:** Enable FlightPath to detect whether Claude Code CLI is installed and report availability status to users, providing helpful guidance when CLI is not available.

**User Value:** After this epic, users see clear status indicators showing whether Claude CLI is available, with helpful error messages guiding installation if needed.

---

### Story 2.1: Implement Claude CLI Detection ✅ DONE

As a **user**,  
I want **FlightPath to automatically detect if Claude Code CLI is installed**,  
So that **I know whether I can use Claude as my AI provider**.

**Acceptance Criteria:**

**Given** the `ClaudeCommandLineIntegration.initialize()` method  
**When** initialization is triggered  
**Then** the system executes `claude --version` command

**And** if the command succeeds (exit code 0):

- Status changes to `"Ready"`
- Version string is logged to output channel
- `onStatusChange` event fires with `"Ready"`

**And** if the command fails (exit code non-zero or command not found):

- Status changes to `"Unavailable"`
- Error message logged to output channel
- `onStatusChange` event fires with `"Unavailable"`

**And** the detection completes within 5 seconds (NFR1)

**Prerequisites:** Epic 1 complete

**Technical Notes:**

- Use Node.js `child_process.spawn` with timeout
- Cross-platform: Windows uses `claude.cmd`, Unix uses `claude`
- Parse version from stdout: expect format like `claude-code v1.x.x`

---

### Story 2.2: Implement Status Change Event System ✅ DONE

As a **developer**,  
I want **status change events fired during Claude CLI lifecycle**,  
So that **the UI can react to availability changes**.

**Acceptance Criteria:**

**Given** the `ClaudeCommandLineIntegration` class  
**When** the class initializes  
**Then** it fires `onStatusChange` event with `"Initializing"`

**And** when detection completes successfully  
**Then** it fires `onStatusChange` event with `"Ready"`

**And** when detection fails  
**Then** it fires `onStatusChange` event with `"Unavailable"`

**And** consumers can subscribe via `integration.onStatusChange((status) => {...})`

**Prerequisites:** Story 2.1

**Technical Notes:**

- Use VS Code's `EventEmitter` pattern (already in base class)
- Status type: `"Initializing" | "Ready" | "Unavailable"`
- Matches existing Copilot CLI event pattern

---

### Story 2.3: Add Enhanced Error Messages for Common Issues ✅ DONE

As a **user**,  
I want **helpful error messages when Claude CLI is not available**,  
So that **I can quickly resolve installation issues**.

**Acceptance Criteria:**

**Given** Claude CLI detection fails  
**When** the error is "command not found" / ENOENT  
**Then** the error message includes:

- "Claude Code CLI not found"
- Installation instructions: `npm install -g @anthropic-ai/claude-code`
- Link to Claude Code documentation

**And** when the error is permission denied  
**Then** the message suggests checking PATH and permissions

**And** when the error is timeout  
**Then** the message suggests checking system resources and retrying

**And** all error messages are logged to FlightPath output channel

**Prerequisites:** Story 2.1

**Technical Notes:**

- Create error message constants in a dedicated file or section
- Include actionable next steps in each message
- Consider VS Code notification for critical errors

---

### Story 2.4: Add getStatus() Method Implementation ✅ DONE

As a **developer**,  
I want **a `getStatus()` method that returns current Claude CLI status**,  
So that **other components can query availability synchronously**.

**Acceptance Criteria:**

**Given** the `ClaudeCommandLineIntegration` class  
**When** `getStatus()` is called  
**Then** it returns the current status: `"Initializing"`, `"Ready"`, or `"Unavailable"`

**And** the status accurately reflects the last detection result  
**And** the method is synchronous (no async/await needed)

**Prerequisites:** Story 2.1

**Technical Notes:**

- Store status in private class property
- Initialize as `"Initializing"`
- Update after detection completes

---

## Epic 3: Prompt Execution & Streaming ✅ COMPLETED

**Goal:** Enable users to send prompts to Claude Code CLI and receive responses with real-time streaming, proper output parsing, and robust error handling.

**User Value:** After this epic, users can execute FlightPath workflows using Claude Code CLI with the same seamless experience as Copilot CLI - including streaming responses, token statistics, and reliable error handling.

---

### Story 3.1: Implement Basic Prompt Execution ✅ DONE

As a **user**,  
I want **to send prompts to Claude Code CLI**,  
So that **I can use Claude for my FlightPath workflows**.

**Acceptance Criteria:**

**Given** a prompt string and Claude CLI is Ready  
**When** `sendPrompt(prompt, options)` is called  
**Then** the system spawns `claude -p "<prompt>"` command

**And** the command includes:

- `--output-format json` flag (for structured parsing)
- `--model <model>` flag with configured or default model
- `--add-dir <workspace>` flag with workspace root path
- `--dangerously-skip-permissions` flag (when `toolPermissions: "skipAll"`)

**And** the process stdout is captured  
**And** on process exit, the response is parsed and returned

**Prerequisites:** Epic 2 complete

**Technical Notes:**

- Use `child_process.spawn` for streaming capability
- Escape prompt string properly for shell
- Handle both Windows and Unix command execution
- Respect `flightpath.claudeCliModel` setting for default model

---

### Story 3.2: Implement Streaming Output with Chunk Events ✅ DONE

As a **user**,  
I want **to see Claude's response streaming in real-time**,  
So that **I get immediate feedback during long operations**.

**Acceptance Criteria:**

**Given** a prompt is being executed  
**When** Claude CLI outputs data to stdout  
**Then** each chunk is emitted via `onStreamingChunk` event within 100ms (NFR2)

**And** chunks are emitted as they arrive (no buffering entire response)  
**And** the Output channel shows streaming content in real-time  
**And** the final `onResponseComplete` event contains the full accumulated response

**Prerequisites:** Story 3.1

**Technical Notes:**

- Listen to `process.stdout.on('data', ...)`
- Emit chunks via existing `onStreamingChunk` EventEmitter
- Accumulate chunks for final response
- Consider JSON streaming parsing if needed

---

### Story 3.3: Implement JSON Output Parsing ✅ DONE

As a **user**,  
I want **Claude's JSON output properly parsed for response content and statistics**,  
So that **I see clean response text and token usage information**.

**Acceptance Criteria:**

**Given** Claude CLI output with `--output-format json`  
**When** the response is received  
**Then** the system parses JSON structure to extract:

- Response text content
- Token usage (input tokens, output tokens, total)
- Model used
- Session ID (if available)

**And** if JSON parsing fails, fall back to raw text parsing  
**And** token statistics are included in `onResponseComplete` event data  
**And** statistics are logged to Output channel when `showCliOutput` is enabled

**Prerequisites:** Story 3.1

**Technical Notes:**

- Claude JSON format: `{ "result": "...", "usage": { "input_tokens": N, "output_tokens": N } }`
- Create interface for Claude JSON response structure
- Graceful degradation: if not JSON, treat as plain text response

---

### Story 3.4: Implement Cancellation Support ✅ DONE

As a **user**,  
I want **to cancel a running Claude CLI operation**,  
So that **I can stop long-running or incorrect prompts**.

**Acceptance Criteria:**

**Given** a Claude CLI process is running  
**When** `cancelCurrentOperation()` is called  
**Then** the running process is terminated (SIGTERM, then SIGKILL if needed)

**And** the cancellation completes within 1 second (NFR3)  
**And** the cancellation flag is set to prevent further processing  
**And** the state is reset for the next operation  
**And** no `onResponseComplete` event fires for cancelled operations

**Prerequisites:** Story 3.1

**Technical Notes:**

- Store `ChildProcess` reference for active operation
- Use `process.kill()` with appropriate signal
- Windows: may need `taskkill` for process tree
- Clear process reference after termination

---

### Story 3.5: Implement Error Handling and Timeout ✅ DONE

As a **user**,  
I want **clear error messages when Claude CLI operations fail**,  
So that **I understand what went wrong and how to fix it**.

**Acceptance Criteria:**

**Given** a Claude CLI operation  
**When** the process exits with non-zero code  
**Then** an error message is logged with:

- Exit code
- Stderr content (if any)
- Suggestion for resolution

**And** when the operation exceeds configured timeout  
**Then** the process is killed and timeout error is reported

**And** when there's a JSON parsing error  
**Then** the raw response is preserved and parsing error is logged

**And** errors are surfaced via `onResponseComplete` with error flag

**Prerequisites:** Story 3.1, Story 3.3

**Technical Notes:**

- Use existing `flightpath.scriptTimeout` setting for timeout
- Create custom error types for different failure modes
- Include stderr in error context for debugging

---

## Epic 4: Session Management ✅ COMPLETED

**Goal:** Enable users to maintain conversation context across multiple prompts within a workflow, supporting both new sessions and session continuation.

**User Value:** After this epic, users can run multi-step workflows where Claude remembers context from previous prompts, just like with Copilot CLI.

---

### Story 4.1: Implement New Session Creation ✅ DONE

As a **user**,  
I want **each workflow to start with a fresh Claude session by default**,  
So that **previous conversations don't interfere with new workflows**.

**Acceptance Criteria:**

**Given** a new workflow starts  
**When** the first prompt is sent  
**Then** no session flags are passed (Claude starts fresh session)

**And** the session ID from Claude's response is captured and stored  
**And** subsequent prompts in the same workflow use this session ID

**Prerequisites:** Epic 3 complete

**Technical Notes:**

- Parse session ID from JSON response
- Store session ID in class instance property
- Clear session ID when workflow completes

---

### Story 4.2: Implement Session Continuation with -c Flag ✅ DONE

As a **user**,  
I want **prompts within a workflow to continue the same session**,  
So that **Claude remembers context from previous prompts**.

**Acceptance Criteria:**

**Given** a workflow with multiple prompts  
**When** the second and subsequent prompts are sent  
**Then** the `-c` flag is included to continue the most recent session

**And** if `newChatSession: false` is set on a prompt  
**Then** the `-c` flag is used

**And** the conversation context is maintained across prompts

**Prerequisites:** Story 4.1

**Technical Notes:**

- Add logic to include `-c` when session continuation is desired
- Check `prompt.newChatSession` property
- Default behavior: continue session within workflow

---

### Story 4.3: Implement Session Resume with -r Flag ✅ DONE

As a **user**,  
I want **to resume a specific session by ID**,  
So that **I can continue previous conversations explicitly**.

**Acceptance Criteria:**

**Given** a stored session ID  
**When** a prompt specifies session resume  
**Then** the `-r <session-id>` flag is included

**And** if the session ID is invalid/expired  
**Then** Claude starts a new session and the error is logged

**And** the new session ID is captured and stored

**Prerequisites:** Story 4.1

**Technical Notes:**

- Session ID format: expect UUID or similar from Claude
- Handle session expiration gracefully
- Consider adding session ID to workflow state for persistence

---

### Story 4.4: Implement newChatSession Prompt Option ✅ DONE

As a **user**,  
I want **to force a new session for specific prompts in my workflow**,  
So that **I can reset context when needed**.

**Acceptance Criteria:**

**Given** a prompt with `newChatSession: true`  
**When** the prompt is executed  
**Then** neither `-c` nor `-r` flags are passed (forces new session)

**And** the new session ID is captured and stored  
**And** subsequent prompts without `newChatSession: true` continue this new session

**Prerequisites:** Story 4.2

**Technical Notes:**

- Check `prompt.newChatSession` boolean
- `true` = new session, `false` = continue, `undefined` = continue (default)
- Clear previous session ID when forcing new session

---

## Epic 5: Dashboard & Status Integration

**Goal:** Integrate Claude CLI with the FlightPath dashboard and status bar so users can monitor activity, see token statistics, and understand which provider is active.

**User Value:** After this epic, users have full visibility into Claude CLI operations through the familiar FlightPath UI - same great experience, different AI brain.

---

### Story 5.1: Display Claude CLI Prompts and Responses in Dashboard

As a **user**,  
I want **to see Claude CLI prompts and responses in the FlightPath dashboard**,  
So that **I can monitor workflow execution**.

**Acceptance Criteria:**

**Given** a Claude CLI prompt is executed  
**When** the response is received  
**Then** the dashboard displays:

- Prompt text (with step number if applicable)
- Response text (streaming or complete)
- Timestamp
- Status (running, complete, error)

**And** the display format matches existing Copilot CLI display  
**And** long responses are scrollable

**Prerequisites:** Epic 3 complete

**Technical Notes:**

- Use existing dashboard message types
- Ensure Claude responses use same data structure as Copilot
- No dashboard code changes needed if data format matches

---

### Story 5.2: Display Token Statistics in Dashboard

As a **user**,  
I want **to see token usage statistics in the dashboard**,  
So that **I can monitor Claude API usage**.

**Acceptance Criteria:**

**Given** a Claude CLI response with token statistics  
**When** the response is displayed  
**Then** the dashboard shows:

- Input tokens
- Output tokens
- Total tokens
- Model used

**And** if statistics are unavailable, the section is hidden (not showing zeros)  
**And** cumulative statistics are shown for the entire workflow

**Prerequisites:** Story 5.1, Story 3.3

**Technical Notes:**

- Extract stats from parsed JSON response
- Add to existing response display component
- Consider adding workflow-level token totals

---

### Story 5.3: Indicate Active CLI Provider in Dashboard

As a **user**,  
I want **the dashboard to clearly show which CLI provider is active**,  
So that **I know whether I'm using Copilot or Claude**.

**Acceptance Criteria:**

**Given** the FlightPath dashboard  
**When** Claude CLI is the active provider  
**Then** the dashboard header shows "Claude Code CLI" indicator

**And** the indicator includes:

- Provider name ("Claude Code" or "Copilot")
- Current model (e.g., "sonnet")
- Status (Ready, Running, etc.)

**And** the indicator updates when provider setting changes

**Prerequisites:** Story 5.1

**Technical Notes:**

- Add provider indicator to dashboard header
- Use distinct styling/icon for each provider
- Update on settings change via workspace configuration listener

---

### Story 5.4: Update Status Bar for Claude CLI

As a **user**,  
I want **the VS Code status bar to reflect Claude CLI status**,  
So that **I can see availability at a glance**.

**Acceptance Criteria:**

**Given** Claude CLI is the configured provider  
**When** the status changes  
**Then** the status bar item shows:

- "FlightPath: Claude Ready" (green) when Ready
- "FlightPath: Claude Unavailable" (red) when Unavailable
- "FlightPath: Claude Initializing" (yellow) when Initializing
- "FlightPath: Claude Running" (blue) when executing

**And** clicking the status bar shows provider details  
**And** the tooltip includes model and session info

**Prerequisites:** Story 5.1, Epic 2 complete

**Technical Notes:**

- Update existing status bar logic in `FlightPathManager`
- Use `StatusBarItem.text` and `StatusBarItem.color`
- Include provider name in status text for clarity

---

## FR Coverage Matrix

| FR   | Description                                            | Epic | Story         |
| ---- | ------------------------------------------------------ | ---- | ------------- |
| FR1  | Detect Claude CLI via `claude --version`               | 2    | 2.1           |
| FR2  | Report status (Ready, Unavailable, Initializing)       | 2    | 2.1, 2.2, 2.4 |
| FR3  | Send prompts via `-p` flag                             | 3    | 3.1           |
| FR4  | Receive response on command exit                       | 3    | 3.1           |
| FR5  | Stream response chunks in real-time                    | 3    | 3.2           |
| FR6  | Configure default model via settings                   | 1    | 1.2           |
| FR7  | Override model per-prompt                              | 3    | 3.1           |
| FR8  | Validate model and warn on unsupported                 | 1    | 1.1, 3.1      |
| FR9  | Support model aliases and full names                   | 1    | 1.1           |
| FR10 | Start new conversation sessions                        | 4    | 4.1           |
| FR11 | Continue most recent session with `-c`                 | 4    | 4.2           |
| FR12 | Resume specific session with `-r`                      | 4    | 4.3           |
| FR13 | `newChatSession: true` starts fresh                    | 4    | 4.4           |
| FR14 | `newChatSession: false` continues session              | 4    | 4.2, 4.4      |
| FR15 | Auto-add workspace directories via `--add-dir`         | 3    | 3.1           |
| FR16 | Configure additional allowed directories               | 1    | 1.2           |
| FR17 | Skip permissions with `--dangerously-skip-permissions` | 3    | 3.1           |
| FR18 | Configure allowed/disallowed tool patterns             | 1    | 1.2           |
| FR19 | Tool permissions mirror Copilot CLI patterns           | 1    | 1.2           |
| FR20 | Parse response from stdout                             | 3    | 3.1, 3.3      |
| FR21 | Use JSON output format for parsing                     | 3    | 3.3           |
| FR22 | Extract token usage statistics                         | 3    | 3.3           |
| FR23 | Provide response to end condition evaluators           | 3    | 3.1           |
| FR24 | Log to Output channel when enabled                     | 3    | 3.1, 3.2      |
| FR25 | Fire status change events                              | 2    | 2.2           |
| FR26 | Fire response complete events                          | 3    | 3.1           |
| FR27 | Fire streaming chunk events                            | 3    | 3.2           |
| FR28 | Fire prompt ready events                               | 3    | 3.1           |
| FR29 | Handle CLI not found gracefully                        | 2    | 2.3           |
| FR30 | Handle execution errors with messages                  | 3    | 3.5           |
| FR31 | Handle timeout with configurable duration              | 3    | 3.5           |
| FR32 | Provide enhanced error messages                        | 2    | 2.3           |
| FR33 | Cancel running CLI process                             | 3    | 3.4           |
| FR34 | Kill process cleanly on cancel                         | 3    | 3.4           |
| FR35 | Reset state after cancellation                         | 3    | 3.4           |
| FR36 | Display prompts/responses in dashboard                 | 5    | 5.1           |
| FR37 | Show token statistics in dashboard                     | 5    | 5.2           |
| FR38 | Indicate active CLI provider                           | 5    | 5.3           |
| FR39 | Status bar reflects Claude CLI status                  | 5    | 5.4           |

**Coverage: 39/39 FRs (100%)**

---

## Summary

### Epic Breakdown Complete

| Epic                              | Stories | Key Deliverables                                               |
| --------------------------------- | ------- | -------------------------------------------------------------- |
| 1. Foundation & Configuration     | 4       | Type definitions, settings, class skeleton, factory pattern    |
| 2. CLI Detection & Initialization | 4       | Version check, status events, error messages, getStatus()      |
| 3. Prompt Execution & Streaming   | 5       | Prompt sending, streaming, JSON parsing, cancellation, errors  |
| 4. Session Management             | 4       | New sessions, -c continuation, -r resume, newChatSession       |
| 5. Dashboard & Status Integration | 4       | Dashboard display, token stats, provider indicator, status bar |

**Total: 5 Epics, 21 Stories**

### Recommended Execution Order

1. **Epic 1** - Foundation (must be first - establishes types and settings)
2. **Epic 2** - Detection (depends on Epic 1 - needs class skeleton)
3. **Epic 3** - Execution (depends on Epic 2 - needs working initialization)
4. **Epic 4** - Sessions (depends on Epic 3 - needs prompt execution)
5. **Epic 5** - Dashboard (depends on Epic 3 - needs response data)

### Success Criteria Alignment

| Success Criterion     | Addressed By                         |
| --------------------- | ------------------------------------ |
| Feature Parity        | All 39 FRs covered across 5 epics    |
| Seamless Switching    | Story 1.4 (factory pattern)          |
| Zero Workflow Changes | Story 3.1 (same prompt format works) |
| Same User Experience  | Epic 5 (dashboard integration)       |
| Reliable Detection    | Epic 2 (cross-platform detection)    |

---

_For implementation: Use the `create-story` workflow to generate individual story implementation plans from this epic breakdown._

_This document will be updated after UX Design and Architecture workflows to incorporate interaction details and technical decisions._

---

## Related Documentation

- [CLAUDE_CLI_DESIGN.md](../CLAUDE_CLI_DESIGN.md) - Complete Claude CLI integration reference
- [COPILOT_CLI_DESIGN.md](../COPILOT_CLI_DESIGN.md) - Parallel Copilot CLI reference
- [prd.md](./prd.md) - Product Requirements Document for this feature
- [ARCHITECTURE.md](../ARCHITECTURE.md) - Overall FlightPath architecture
