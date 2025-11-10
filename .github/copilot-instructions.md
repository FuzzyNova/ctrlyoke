# FlightPath VS Code Extension

<projectPurpose>
Automate GitHub Copilot Chat through structured JSON-based prompt workflows with automated execution, response detection, and context awareness.
</projectPurpose>

<technicalStack>
- TypeScript 5.x (strict mode)
- Node.js 22.17.0
- esbuild (bundling)
- VS Code Extension API (Language Model Tool API, Chat integration)
- JSON Schema validation (AJV)
- Mocha (testing)
</technicalStack>

<architecturePrinciples>

<promptFormat>
**Final-form storage**: Prompts stored in JSON files are ready to send to Copilot with all context variables (@workspace, #file:path:line-line, slash commands) included directly in the text. No runtime context injection.

**XML structure**: FlightPath wraps automation instructions in XML tags:

- User prompt sent as-is (visible in chat history)
- FlightPath automation instructions wrapped in `<criticalInstruction>` tag (hidden in chat UI but processed correctly)

**Note**: Copilot Chat UI hides XML tags in the chat view but still processes them. This allows FlightPath to send automation instructions that Copilot follows without cluttering the user's chat history.
</promptFormat>

<solidPrinciples>
SOLID principles with strict separation of concerns:

- FlightPathManager: Orchestration and command handling
- PromptQueue: Sequential execution and state management
- CopilotIntegration (abstract base): Defines integration contract
  - CopilotChatIntegration: Chat window automation with UI interactions
  - CopilotCommandLineIntegration: CLI-based automation (default)
- PromptFileParser: JSON validation and parsing
- EndConditionEvaluator: Script execution and validation
  </solidPrinciples>

<codeQuality>
TypeScript strict mode, comprehensive error handling, no duplication.
</codeQuality>

</architecturePrinciples>

## Project Structure

```
src/
├── extension.ts                  # Entry point
├── completions/                  # IntelliSense providers
│   └── PromptCompletionProvider.ts  # File/selection completions for prompt files
├── flightpath/                   # Core logic
│   ├── base/
│   │   └── CopilotIntegration.ts # Abstract base class
│   ├── chat/
│   │   └── CopilotChatIntegration.ts  # Chat window automation
│   ├── cli/
│   │   └── CopilotCommandLineIntegration.ts  # CLI automation (default)
│   ├── FlightPathManager.ts      # Orchestration with factory pattern
│   ├── PromptQueue.ts            # Execution queue
│   ├── PromptFileParser.ts       # JSON parsing
│   └── EndConditionEvaluator.ts  # Script validation
├── templates/                    # End condition script templates
│   ├── check_condition.py        # Python template
│   ├── check_condition.js        # JavaScript template
│   ├── check_condition.sh        # Bash template
│   └── check_condition.bat       # Windows batch template
├── types/                        # Type definitions
└── test/                         # Tests
schemas/                          # JSON schemas (source)
└── prompt-schema.json            # Unified schema for both file types
```

**Build Output**:

- Templates copied from `src/templates/` to `out/templates/` during build
- Schemas copied from `schemas/` to `out/schemas/` during build
- Single source of truth: `/schemas/prompt-schema.json` used for both VS Code IntelliSense and runtime validation

<coreComponents>

## FlightPathManager

Main orchestrator handling commands, lifecycle, and workflow execution. Coordinates PromptQueue and CopilotIntegration. Subscribes to status changes and response completion events.

## PromptQueue

Manages sequential prompt execution with pause/resume/cancel. Tracks state and progress. Does not directly handle response detection (delegated to FlightPathManager).

## CopilotIntegration

**Architecture**: Abstract base class with two implementations selected via factory pattern.

**Automatic File Attachment**:

- Processes `#file:path` and `#file:path:startLine-endLine` references in prompts
- Reads file content and builds Copilot's internal attachment XML format
- Prepends attachment XML to prompt before sending (keeps `#file:` syntax in prompt text for LLM context)
- Supports both entire files and specific line ranges
- Works with both CLI and Chat modes
- Can be disabled via `flightpath.autoAttachFiles` setting (default: enabled)
- See docs/CONTEXT_ATTACHMENT.md for implementation details

### CopilotCommandLineIntegration (Default)

- **Deterministic completion**: Command returns when complete (no polling needed)
- **Structured output**: Parses response text and statistics separately
- **Model selection**: User-configurable AI model (claude-sonnet-4.5, gpt-5, etc.)
- **Simple initialization**: Check `copilot --version` for availability
- **Response text**: Directly available for end condition evaluation
- **No UI dependencies**: Pure command-line execution

### CopilotChatIntegration (Fallback)

- Direct text insertion: Focus (1000ms) → Clear (300ms) → Type (500ms) → Submit
- Background polling: 5s intervals, 30s max, detects Copilot availability on startup
- States: initializing | waiting | ready | unavailable
- Response detection: Language Model Tool (flightpath_response_complete)
- Automatic prompt augmentation: Appends tool instruction in `<criticalInstruction>` XML tag (hidden in chat UI but processed correctly)
- Submit verification: Clipboard-based retry with exponential backoff
- Streaming detection: Polls chat stability (3 consecutive stable checks)

### Response Completion Detection

Uses hybrid approach combining Language Model Tool + clipboard polling:

**Tool Callback (Intent Signal):**

1. Tool registration: flightpath_response_complete registered after Copilot activates
2. Prompt augmentation: Every prompt gets tool-calling instruction appended automatically
3. Tool invocation: When called, fires responseCompleteEmitter event (ONLY FIRST CALL)
4. Duplicate protection: toolCalledForCurrentPrompt flag ignores subsequent calls in same response

**Clipboard Polling (Verification):**

1. Tool callback triggers streaming detection (not immediate polling)
2. Polls chat content every 500ms via clipboard
3. Requires 3 consecutive stable checks (1.5s) to confirm completion
4. Efficient: only polls after tool indicates "near completion"

**LLM Loop Prevention:**

- LLMs often call tools multiple times (output → tool → output → tool loop)
- Two-layer defense: flag in CopilotIntegration + flag in FlightPathManager
- **Active cancellation**: Calls `workbench.action.chat.cancel` when loop detected
- Stops LLM from continuing to generate unwanted text in the loop
- Saves tokens and prevents workflow disruption

Implementation notes:

- Tool registered only once (isToolRegistered flag prevents duplicates)
- Instruction emphasizes "EXACTLY ONCE" and "FINAL action"
- Single active workflow limitation (no chat session metadata in tool invocations)
- See docs/COPILOT_RESPONSE_HANDLING.md for full research and design decisions

### PromptFileParser

- Schema validation with AJV using single unified schema (prompt-schema.json)
- Both .prompt.json and .flightpath.json use the same schema
- Supports both single prompt and multiple prompts format (via oneOf)
- Validates final-form prompts (no runtime context injection)
- Detailed validation error reporting

## PromptCompletionProvider

IntelliSense provider for prompt files with context-aware completions:

- **JSON files** (`.prompt.json`, `.flightpath.json`): Triggers on `#` inside "prompt" string values
- **Markdown files** (`.prompt.md`): Triggers on `#` anywhere in the document
- **File completions**: Shows all workspace files with fuzzy filtering
- **Selection completions**: Captures current editor selection as `#file:path:startLine-endLine`
- **Performance**: 5-second file cache, limited to 500 results
- **Multiple selections**: Supports multiple visible editors with selections

## EndConditionEvaluator

- Path validation and process isolation
- Supports Python, JavaScript, shell scripts (.py, .js, .ts, .sh, .bat, .ps1)
- Configurable timeouts (default 30s)
- Scripts cannot access file system directly
- Template files stored in `src/templates/` and copied to `out/templates/` during build
- `createSampleScript()` copies from bundled templates at runtime using `context.extensionPath`

</coreComponents>

## File Formats & Schema

**Important: Prompts are stored in final-form format** - All context variables (@workspace, #file:path, slash commands) are included directly in the prompt text.

**Schema: Both file types use the same unified schema (prompt-schema.json)**

Both `.prompt.json` and `.flightpath.json` files support the same two formats:

### Single Prompt Format

```json
{
  "prompt": "/explain #file:src/extension.ts Analyze and improve this code",
  "model": "claude-haiku-4.5",
  "endCondition": {
    "script": "validate_improvements.py",
    "returns": "true",
    "timeout": 30000
  }
}
```

### Multiple Prompts Format

```json
{
  "prompts": [
    {
      "prompt": "/explain @workspace Step 1: Analyze code structure",
      "model": "claude-sonnet-4.5",
      "endCondition": { "script": "check_analysis.js", "returns": "true" }
    },
    {
      "prompt": "Step 2: Implement improvements",
      "endCondition": { "script": "verify_changes.py", "returns": "true" }
    }
  ]
}
```

### Markdown Prompt Format

For simple single prompts, use `.prompt.md` files (no JSON needed):

```markdown
Analyze the FlightPath extension architecture and suggest improvements for better code organization. Focus on the separation of concerns between components.
```

**Markdown file handling**:

- `.prompt.md` files are read as plain text (entire file content becomes the prompt)
- No JSON parsing or schema validation needed
- Cannot include `model` override or `endCondition` (single prompt execution only)
- Supports same context variables: `@workspace`, `#file:path`, slash commands
- Use context menu (right-click) to execute: **Send to CLI** or **Send to Chat**

**Optional Fields:**

- `model` - Override the AI model for a specific prompt. Valid values: `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `gpt-5`. If omitted, uses the default configured in settings (`flightpath.copilotCliModel`).

**File naming conventions:**

- `.prompt.md` - Single markdown-based prompts (no JSON, simplest format)
- `.prompt.json` - Typically for single prompts or simple workflows
- `.flightpath.json` - Typically for complex multi-step workflows

All three formats support context menu execution with mode override (Send to CLI / Send to Chat).

## Commands

12 registered commands:

- flightpath.takeOff: Start workflow
- flightpath.openPanel: Open panel
- flightpath.createPromptFile: Create file
- flightpath.createEndConditionScript: Create end condition script from templates
- flightpath.pause/resume/stop: Execution control
- flightpath.debugState: Debug state
- flightpath.showCopilotStatus: Show status
- flightpath.testAutomation: Test automation
- flightpath.retryCopilotDetection: Retry polling

Status bar shows: Initializing, Waiting, Ready, Running, Paused, Setup Required

## Testing

- Unit tests: Core logic with mocking
- Integration tests: VS Code API interactions
- Test files: extension.test.ts, flightpath.test.ts
- Framework: Mocha with VS Code test utilities

## Security

Script execution:

- Path validation: Scripts must be in .flightpath/ directory
- Process isolation: Separate child processes
- Timeout protection: Default 30s
- No network access or direct file modification

File system:

- Operations limited to workspace scope
- JSON validated against strict schemas

## Development

- F5 debugging with breakpoints
- npm run watch for compilation
- TypeScript strict mode
- ESLint + Prettier for code quality

## Implementation Status

Completed:

- Automatic file attachment for `#file:` references (CLI and Chat modes)
- Copilot CLI integration with factory pattern architecture
- CLI deterministic completion detection (no polling needed)
- Output Channel integration for real-time CLI output visibility
- User-configurable CLI settings (model, directories, tool permissions)
- Zero-interaction Copilot Chat automation (fallback mode)
- Language Model Tool for response detection (chat mode)
- Clipboard-based submit verification and streaming detection (chat mode)
- Background polling with progressive activation (chat mode)
- User-configurable chat window location
- Automatic prompt augmentation with tool instructions (chat mode)
- JSON schema validation with IntelliSense
- Command registration and lifecycle management
- Status bar integration with real-time updates
- File system monitoring and prompt discovery

Planned:

- End condition script execution with response text validation
- WebView UI panel for workflow visualization
- Session management for multi-turn CLI conversations
- Custom tool permission configuration
- Comprehensive test coverage

## Extension Settings

- flightpath.promptsDirectory (string, default: ".flightpath")
- flightpath.scriptTimeout (number, default: 30000)
- flightpath.autoAttachFiles (boolean, default: true) - Automatically process #file: references and attach file content
- flightpath.copilotIntegrationMode (enum: "cli" | "chat", default: "cli")
- flightpath.copilotCliModel (enum: "claude-sonnet-4.5" | "claude-sonnet-4" | "claude-haiku-4.5" | "gpt-5", default: "claude-sonnet-4.5")
- flightpath.copilotCliAllowedDirs (array of strings, default: [])
- flightpath.copilotCliToolPermissions (enum: "allowAll" | "custom", default: "allowAll")
- flightpath.showCliOutput (boolean, default: true) - Show CLI prompts/responses/statistics in Output panel
- flightpath.chatWindowLocation (enum: "chatPanel" | "newTab" | "newWindow", default: "chatPanel")

When adding settings:

1. Add to package.json under contributes.configuration.properties
2. Use enum with enumDescriptions for dropdowns
3. Set sensible defaults
4. Retrieve: vscode.workspace.getConfiguration("flightpath").get<Type>("settingName", defaultValue)

## Development Guidelines

**Project Status**: Pre-release - No backward compatibility required. Break things freely to improve architecture.

When adding features:

1. Follow SOLID principles - single responsibility per component
2. Add TypeScript types - leverage strict mode for safety
3. Include error handling - comprehensive user feedback
4. Write tests first - TDD approach for reliability
5. Update schemas - maintain JSON validation for prompt files
6. Document changes - keep README and examples current

Code review focus:

- Type safety with strict mode
- Error boundaries for all external operations
- Security validation for script execution and file system access
- Performance: avoid blocking operations, use async/await
- User experience: clear feedback and status communication

**Breaking Changes**: Since this extension is not yet released, prioritize clean architecture over backward compatibility. Make bold improvements without hesitation.

## Extension Goals

FlightPath bridges manual AI assistance and full automation through:

- Structured automation via JSON configuration
- Script-based validation of AI outputs
- Fine-grained control over AI interaction sequences
- Seamless VS Code integration with context awareness
- Secure script execution with clear boundaries
