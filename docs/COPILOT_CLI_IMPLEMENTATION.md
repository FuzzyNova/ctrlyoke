# Copilot CLI Integration - Implementation Plan

**Status**: Planning Phase  
**Date**: November 5, 2025  
**Author**: Nathan

## Executive Summary

Integrate GitHub Copilot CLI as an alternative to the chat window automation, providing:

- **Deterministic completion detection** (no polling, streaming detection, or tool callbacks needed)
- **Clean output parsing** (structured response format with usage statistics)
- **Simpler architecture** (child process execution vs. complex UI automation)
- **Better reliability** (command-line interface vs. UI interaction timing issues)
- **Session support** for multi-turn conversations

## Current Architecture Analysis

### Existing CopilotIntegration.ts Responsibilities

1. **Initialization & Polling**
   - Background polling to detect Copilot Chat availability
   - Status management: initializing → waiting → ready/unavailable
   - Extension activation on demand

2. **Prompt Execution**
   - Direct text insertion automation (focus → clear → type → submit)
   - Submit verification with retry logic using clipboard
   - Workflow progress tracking

3. **Response Detection** (Complex!)
   - Language Model Tool registration (`#flightpath_response_complete`)
   - Tool callback handling with duplicate prevention
   - Streaming detection via clipboard polling (3 consecutive stable checks)
   - Active loop cancellation when LLM calls tool multiple times

4. **Context Building**
   - XML-wrapped tool instructions
   - Final-form prompt assembly (context variables already resolved)

5. **Configuration**
   - Chat window location (panel/tab/window)
   - User-facing status updates

### Key Challenges with Current Chat Automation

1. **Timing Complexity**: Multiple delays (1000ms focus, 300ms select, 500ms type)
2. **Submit Verification**: Clipboard-based retry with exponential backoff
3. **Response Detection**: Two-layer system (tool callback + streaming detection)
4. **Race Conditions**: LLM loop prevention with active cancellation
5. **UI Dependencies**: Requires chat window to be visible and responsive

## CLI Advantages

### Deterministic Execution

```bash
$ copilot -p "Fix bug in main.js" --allow-all-tools
[Response text here]

Total usage est:       1 Premium request
Total duration (API):  4.0s
Total duration (wall): 5.4s
Total code changes:    0 lines added, 0 lines removed
```

- **Command returns when complete** - No polling needed!
- **Structured output** - Easy to parse response vs. statistics
- **No UI timing issues** - Pure command execution

### Advanced Features

- `--add-dir <directory>` - Control file access permissions
- `--allow-all-tools` / `--allow-tool` / `--deny-tool` - Fine-grained tool control
- `--model <model>` - Choose AI model (claude-sonnet-4.5, gpt-5, etc.)
- `--resume [sessionId]` - Multi-turn conversation support
- `--log-dir <directory>` - Debug logging

## Proposed Architecture

### Class Hierarchy Design

```typescript
// Base class with shared functionality
abstract class CopilotIntegration {
  // Shared state
  protected context: vscode.ExtensionContext;
  protected isAvailable: boolean = false;
  protected workflowStep: number = 0;
  protected totalSteps: number = 0;

  // Shared event emitters
  protected statusChangeEmitter = new vscode.EventEmitter<CopilotStatus>();
  public readonly onDidChangeStatus = this.statusChangeEmitter.event;

  protected responseCompleteEmitter = new vscode.EventEmitter<string>();
  public readonly onResponseComplete = this.responseCompleteEmitter.event;

  // Abstract methods (implemented by subclasses)
  abstract initialize(): Promise<void>;
  abstract sendPrompt(prompt: PromptItem): Promise<boolean>;
  abstract getStatus(): {
    available: boolean;
    message: string;
    strategy: string;
  };
  abstract isIntegrationAvailable(): boolean;

  // Shared utility methods
  protected async buildPromptText(prompt: PromptItem): Promise<string> {
    // Common prompt building logic (without tool instruction XML)
    return prompt.prompt.trim();
  }

  setWorkflowProgress(currentStep: number, totalSteps: number): void {
    this.workflowStep = currentStep;
    this.totalSteps = totalSteps;
  }
}

// CLI-based implementation (NEW)
class CopilotCommandLineIntegration extends CopilotIntegration {
  private sessionId?: string; // For multi-turn conversations

  async initialize(): Promise<void> {
    // Check if copilot CLI is available
    // Much simpler than chat polling!
  }

  async sendPrompt(prompt: PromptItem): Promise<boolean> {
    // Execute: copilot -p "<prompt>" --allow-all-tools
    // Parse output
    // Fire responseCompleteEmitter with response text
    // Return true/false based on exit code
  }

  async sendPromptWithContext(
    prompt: PromptItem,
    sessionId?: string
  ): Promise<boolean> {
    // Use --resume to continue conversation
  }
}

// Chat window implementation (EXISTING - REFACTORED)
class CopilotChatIntegration extends CopilotIntegration {
  // All existing chat automation code
  private isToolRegistered: boolean = false;
  private toolCalledForCurrentPrompt: boolean = false;

  private readonly TOOL_INSTRUCTION = `...`; // XML wrapper for tool call

  async initialize(): Promise<void> {
    // Existing background polling logic
    await this.startBackgroundPolling();
  }

  async sendPrompt(prompt: PromptItem): Promise<boolean> {
    // Existing direct automation logic
    // Focus → Clear → Type → Submit → Verify → Wait for tool + streaming
  }

  private registerResponseTool(): void {
    /* ... */
  }
  private async waitForCopilotToFinishStreaming(): Promise<boolean> {
    /* ... */
  }
  private async submitWithRetry(): Promise<boolean> {
    /* ... */
  }
  // ... all other existing chat-specific methods
}
```

### Factory Pattern for Instantiation

```typescript
// In FlightPathManager.ts
class FlightPathManager {
  private copilotIntegration: CopilotIntegration;

  constructor(context: vscode.ExtensionContext) {
    // Factory method based on user setting
    this.copilotIntegration = this.createCopilotIntegration(context);
  }

  private createCopilotIntegration(
    context: vscode.ExtensionContext
  ): CopilotIntegration {
    const config = vscode.workspace.getConfiguration("flightpath");
    const integrationMode = config.get<string>(
      "copilotIntegrationMode",
      "chat"
    );

    switch (integrationMode) {
      case "cli":
        return new CopilotCommandLineIntegration(context);
      case "chat":
      default:
        return new CopilotChatIntegration(context);
    }
  }
}
```

## Implementation Plan

### Phase 1: Architecture Refactoring (Breaking Changes OK - Pre-release)

#### Step 1.1: Create Base Class

- [ ] Create `src/flightpath/base/CopilotIntegrationBase.ts`
- [ ] Define abstract class with shared functionality
- [ ] Move common code from current CopilotIntegration.ts
- [ ] Define abstract methods that subclasses must implement

**Key Decisions**:

- Abstract methods: `initialize()`, `sendPrompt()`, `getStatus()`, `isIntegrationAvailable()`
- Shared methods: `buildPromptText()`, `setWorkflowProgress()`, event emitters
- Response complete event: Fire with **response text** (CLI provides this directly!)

#### Step 1.2: Refactor Chat Integration

- [ ] Create `src/flightpath/chat/CopilotChatIntegration.ts`
- [ ] Extend `CopilotIntegrationBase`
- [ ] Move all existing chat automation code
- [ ] Keep all chat-specific complexity: polling, tool registration, streaming detection, submit retry
- [ ] Update imports in dependent files

**Migration Strategy**:

```typescript
// OLD: import { CopilotIntegration } from "./CopilotIntegration";
// NEW: import { CopilotChatIntegration } from "./chat/CopilotChatIntegration";
```

#### Step 1.3: Create CLI Integration

- [ ] Create `src/flightpath/cli/CopilotCommandLineIntegration.ts`
- [ ] Extend `CopilotIntegrationBase`
- [ ] Implement simple CLI execution via `child_process.spawn()`
- [ ] Parse output to extract response vs. statistics
- [ ] Fire `responseCompleteEmitter` with parsed response text

#### Step 1.4: Add Factory Pattern

- [ ] Update `FlightPathManager.ts` to use factory method
- [ ] Add new setting: `flightpath.copilotIntegrationMode`
- [ ] Support dynamic switching (requires reload)

### Phase 2: CLI Implementation Details

#### Step 2.1: Core CLI Execution

```typescript
class CopilotCommandLineIntegration extends CopilotIntegrationBase {
  private async executeCopilotCommand(
    prompt: string,
    options: CopilotCliOptions = {}
  ): Promise<CopilotCliResult> {
    const args = ["-p", prompt, "--allow-all-tools"];

    // Add optional flags
    if (options.addDirs) {
      options.addDirs.forEach((dir) => args.push("--add-dir", dir));
    }
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.resumeSession) {
      args.push("--resume", options.resumeSession);
    }

    // Execute command
    const { stdout, stderr, exitCode } = await this.spawnProcess(
      "copilot",
      args
    );

    // Parse output
    const { response, statistics } = this.parseCliOutput(stdout);

    return {
      success: exitCode === 0,
      response,
      statistics,
      error: stderr,
    };
  }

  private parseCliOutput(output: string): {
    response: string;
    statistics: string;
  } {
    // Split on statistics section (starts with "Total usage est:")
    const parts = output.split(/\n\n(?=Total usage est:)/);

    return {
      response: parts[0]?.trim() || "",
      statistics: parts[1]?.trim() || "",
    };
  }
}
```

#### Step 2.2: Availability Detection

```typescript
async initialize(): Promise<void> {
  console.log("🔍 Checking Copilot CLI availability...");

  try {
    // Simple check: run `copilot --version`
    const { exitCode } = await this.spawnProcess('copilot', ['--version']);

    if (exitCode === 0) {
      console.log("✅ Copilot CLI available");
      this.isAvailable = true;
      this.statusChangeEmitter.fire("ready");
    } else {
      console.log("❌ Copilot CLI not found");
      this.isAvailable = false;
      this.statusChangeEmitter.fire("unavailable");
    }
  } catch (error) {
    console.error("❌ Error checking Copilot CLI:", error);
    this.isAvailable = false;
    this.statusChangeEmitter.fire("unavailable");
  }
}
```

#### Step 2.3: Prompt Execution with Response Extraction

```typescript
async sendPrompt(prompt: PromptItem): Promise<boolean> {
  try {
    console.log("🚀 Sending prompt via Copilot CLI...");

    // Build prompt text (no XML tool instruction needed!)
    const promptText = await this.buildPromptText(prompt);

    // Execute CLI command
    const result = await this.executeCopilotCommand(promptText, {
      addDirs: this.getWorkspaceDirs(),
      model: this.getConfiguredModel(),
      resumeSession: this.sessionId
    });

    if (result.success) {
      console.log("✅ Copilot CLI completed successfully");
      console.log(`📊 Response: ${result.response.substring(0, 200)}...`);

      // Fire response complete event WITH THE ACTUAL RESPONSE TEXT!
      this.responseCompleteEmitter.fire(result.response);

      return true;
    } else {
      console.error("❌ Copilot CLI failed:", result.error);
      return false;
    }
  } catch (error) {
    console.error("❌ CLI execution error:", error);
    return false;
  }
}
```

#### Step 2.4: Session Management (Multi-turn Conversations)

```typescript
private sessionId?: string;

async startNewSession(): Promise<void> {
  // Sessions are managed automatically by CLI
  // Each new execution without --resume is a fresh session
  this.sessionId = undefined;
}

async continueSession(sessionId: string): Promise<void> {
  // Use --resume flag to continue previous conversation
  this.sessionId = sessionId;
}

async getCurrentSession(): Promise<string | undefined> {
  return this.sessionId;
}
```

### Phase 3: Configuration & Settings

#### Step 3.1: Add Settings to package.json

```json
{
  "flightpath.copilotIntegrationMode": {
    "type": "string",
    "enum": ["cli", "chat"],
    "enumDescriptions": [
      "Use Copilot CLI (command-line automation - DEFAULT, better reliability & control)",
      "Use Copilot Chat window (legacy UI automation, fallback if CLI unavailable)"
    ],
    "default": "cli",
    "description": "Choose how FlightPath interacts with GitHub Copilot",
    "markdownDescription": "Choose how FlightPath interacts with GitHub Copilot. **CLI mode** (default) provides better reliability, deterministic completion, and model selection. Chat mode is available as fallback."
  },
  "flightpath.copilotCliModel": {
    "type": "string",
    "enum": [
      "claude-sonnet-4.5",
      "claude-sonnet-4",
      "claude-haiku-4.5",
      "gpt-5"
    ],
    "default": "claude-sonnet-4.5",
    "description": "AI model to use with Copilot CLI"
  },
  "flightpath.copilotCliAllowedDirs": {
    "type": "array",
    "items": { "type": "string" },
    "default": [],
    "description": "Additional directories to allow Copilot CLI to access (beyond workspace)"
  },
  "flightpath.copilotCliToolPermissions": {
    "type": "string",
    "enum": ["allowAll", "custom"],
    "enumDescriptions": [
      "Allow all tools (--allow-all-tools)",
      "Custom tool permissions (configure specific tools)"
    ],
    "default": "allowAll",
    "description": "Tool permission mode for Copilot CLI"
  }
}
```

#### Step 3.2: Configuration Helper Class

```typescript
// src/flightpath/cli/CopilotCliConfig.ts
export class CopilotCliConfig {
  static getModel(): string {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<string>("copilotCliModel", "claude-sonnet-4.5");
  }

  static getAllowedDirs(): string[] {
    const configured = vscode.workspace
      .getConfiguration("flightpath")
      .get<string[]>("copilotCliAllowedDirs", []);

    // Always include workspace folders
    const workspaceDirs =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];

    return [...workspaceDirs, ...configured];
  }

  static getToolPermissionArgs(): string[] {
    const mode = vscode.workspace
      .getConfiguration("flightpath")
      .get<string>("copilotCliToolPermissions", "allowAll");

    if (mode === "allowAll") {
      return ["--allow-all-tools"];
    }

    // TODO: Add custom tool permission configuration
    return ["--allow-all-tools"];
  }
}
```

### Phase 4: Response Handling Updates

#### Step 4.1: Update FlightPathManager

Since CLI provides response text directly, we can enhance end condition evaluation:

```typescript
// FlightPathManager.ts - Updated response handling
private async waitForCopilotResponse(timeout: number = 300000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`Response timeout after ${timeout}ms`));
    }, timeout);

    const disposable = this.copilotIntegration.onResponseComplete(
      (responseText: string) => {
        clearTimeout(timeoutHandle);
        disposable.dispose();
        console.log("✅ Response received from Copilot");
        resolve(responseText);
      }
    );
  });
}

// Enhanced end condition evaluation with response context
private async evaluateEndCondition(
  prompt: PromptItem,
  responseText: string
): Promise<boolean> {
  if (!prompt.endCondition) return true;

  // Pass response text to end condition script as environment variable
  const result = await this.endConditionEvaluator.evaluate(
    prompt.endCondition,
    { COPILOT_RESPONSE: responseText }
  );

  return result;
}
```

#### Step 4.2: Update Event Signature

```typescript
// Base class event signature change
protected responseCompleteEmitter = new vscode.EventEmitter<string>();
//                                                             ^^^^^^
//                                                      Now passes response text!

// Subclass implementations:
// CLI: this.responseCompleteEmitter.fire(result.response);
// Chat: this.responseCompleteEmitter.fire(""); // Empty string (no direct access to response)
```

### Phase 5: Testing & Validation

#### Step 5.1: Unit Tests

- [ ] Test CLI command building with various options
- [ ] Test output parsing (response vs. statistics)
- [ ] Test error handling (exit codes, stderr)
- [ ] Test session management
- [ ] Test configuration loading

#### Step 5.2: Integration Tests

- [ ] Test CLI availability detection
- [ ] Test full prompt execution flow
- [ ] Test switching between chat and CLI modes
- [ ] Test with real Copilot CLI commands

#### Step 5.3: Manual Testing Checklist

- [ ] Single prompt execution (CLI mode)
- [ ] Multi-prompt workflow (CLI mode)
- [ ] End condition evaluation with CLI responses
- [ ] Session continuity across multiple prompts
- [ ] Error handling when CLI not available
- [ ] Switching modes via settings
- [ ] Original chat mode still works (regression test)

### Phase 6: Documentation Updates

#### Step 6.1: User Documentation

- [ ] Update README.md with CLI mode instructions
- [ ] Add CLI installation guide
- [ ] Document settings configuration
- [ ] Add troubleshooting section

#### Step 6.2: Developer Documentation

- [ ] Update ARCHITECTURE.md with new class hierarchy
- [ ] Document base class design and extension points
- [ ] Add CLI integration implementation details
- [ ] Update type definitions

## Benefits Summary

### For Users

✅ **More Reliable**: No UI timing issues or race conditions  
✅ **Faster Setup**: CLI check is instant vs. 30s polling  
✅ **Better Debugging**: CLI logs and output are structured  
✅ **Model Choice**: Pick AI model per workflow (claude-sonnet-4.5, gpt-5, etc.)  
✅ **Session Support**: Multi-turn conversations work naturally  
✅ **No UI Dependencies**: Works in headless environments (future: CI/CD pipelines)

### For Developers

✅ **Simpler Code**: CLI integration ~200 lines vs. Chat ~1000 lines  
✅ **No Tool Registration**: No Language Model Tool complexity  
✅ **No Streaming Detection**: Command returns when complete  
✅ **No Submit Retry**: No clipboard verification needed  
✅ **Clean Architecture**: Base class enables future integrations  
✅ **CLI-First Future**: Opens path for standalone CLI-only FlightPath variant

## Risks & Mitigation

### Risk 1: CLI Not Installed

**Mitigation**: Graceful fallback to chat mode with clear error message and installation instructions

### Risk 2: CLI API Changes

**Mitigation**: Version detection and compatibility checks; maintain chat mode as stable fallback

### Risk 3: CLI Performance

**Mitigation**: Benchmark against chat mode; use `--stream on` if available in future

### Risk 4: Breaking Changes During Refactor

**Mitigation**: Pre-release status means we can break things; thorough testing before 1.0

## Open Questions & Decisions Needed

### Architecture Questions

1. **Base class name**: `CopilotIntegrationBase` vs. `CopilotIntegration` (keep current name)?
   - **✅ DECISION**: Keep `CopilotIntegration` as base, rename current to `CopilotChatIntegration`

2. **Response text in event**: Should `onResponseComplete` always provide response text?
   - **CLI**: Has direct access to response ✅
   - **Chat**: Would need to scrape via clipboard (add complexity)
   - **✅ DECISION**: Make response text optional (`string | undefined`)

3. **Session management**: Should sessions be explicit or automatic?
   - **✅ DECISION**: Start automatic (CLI handles it), expose explicit control in Phase 2

4. **Default mode**: Should CLI be default or chat?
   - **✅ DECISION**: **CLI is default immediately**
   - Pre-release status = perfect time to test CLI as primary mode
   - Model selection + deterministic completion = clear wins
   - Chat mode kept as fallback for users without CLI installed
   - Long-term vision: CLI-first architecture, potentially CLI-only FlightPath variant

### Implementation Questions

1. **Process management**: Should we use `child_process.spawn()` or `child_process.exec()`?
   - **Recommendation**: Use `spawn()` for better stream handling and large outputs

2. **Output parsing**: What if response contains "Total usage est:" in the middle?
   - **Recommendation**: Parse from end of string, look for statistics section pattern

3. **Timeout handling**: Should CLI timeout be different from chat timeout?
   - **Recommendation**: Make it configurable, default to same value (300s)

4. **Error classification**: How to distinguish CLI not found vs. CLI execution error?
   - **Recommendation**: Separate status codes: `cliNotFound`, `cliExecutionError`

## Success Criteria

### MVP (Minimum Viable Product)

- [ ] CLI mode works for single prompts
- [ ] Chat mode still works (no regression)
- [ ] User can switch between modes via settings
- [ ] Clear error messages when CLI not available

### Full Feature Set

- [ ] Session support for multi-turn conversations
- [ ] Response text available for end condition scripts
- [ ] Model selection per workflow
- [ ] Custom tool permissions configuration
- [ ] Comprehensive error handling and user feedback

### Quality Metrics

- [ ] CLI integration code < 300 lines (vs. 1000+ for chat)
- [ ] No background polling needed
- [ ] Zero clipboard operations
- [ ] Deterministic completion (100% reliable)
- [ ] All existing tests pass
- [ ] New tests for CLI integration (80%+ coverage)

## Timeline Estimate

- **Phase 1** (Architecture Refactoring): 4-6 hours
- **Phase 2** (CLI Implementation): 6-8 hours
- **Phase 3** (Configuration): 2-3 hours
- **Phase 4** (Response Handling): 2-3 hours
- **Phase 5** (Testing): 4-5 hours
- **Phase 6** (Documentation): 2-3 hours

**Total**: 20-28 hours (3-4 work days)

## Next Steps

1. ✅ **Review plan** - Complete, decisions finalized
2. ✅ **Clarify open questions** - All questions resolved (see decisions above)
3. **Create implementation branch**: `feature/copilot-cli-integration`
4. **Start with Phase 1.1**: Create base class
5. **Test CLI immediately**: Use as default mode from day one
6. **Iterate and validate**: Pre-release status allows aggressive testing

## Long-Term Vision: CLI-First Architecture

### Why CLI-First Makes Sense

**1. Control & Flexibility**

- Model selection per workflow (not possible with chat)
- Fine-grained tool permissions
- Directory access control
- Session management for complex workflows

**2. Reliability**

- Deterministic completion (no timing/polling heuristics)
- Structured output format
- Clear error codes and messages
- No UI state dependencies

**3. Extensibility**

- Headless operation (CI/CD pipelines, automated workflows)
- CLI-only FlightPath variant (lightweight, no VS Code dependency)
- Integration with other CLI tools
- Scriptable workflows

**4. Developer Experience**

- Simpler codebase (5x less complexity)
- Easier to debug and maintain
- Clear separation of concerns
- Standard CLI patterns

### Future Possibilities with CLI-First

**Standalone CLI FlightPath**

```bash
# Hypothetical future CLI-only FlightPath
flightpath run workflow.flightpath.json
flightpath prompt "Implement feature X"
flightpath session resume last
```

**CI/CD Integration**

```yaml
# GitHub Actions workflow
- name: Run FlightPath Analysis
  run: flightpath run .github/workflows/code-review.flightpath.json
```

**IDE-Agnostic**

- Core logic works anywhere Copilot CLI is installed
- VS Code extension becomes one interface among many
- Potential JetBrains, Vim, Emacs integrations

### Migration Path

**Phase 1** (Current): CLI as default in VS Code extension  
**Phase 2**: Optimize CLI integration, gather feedback  
**Phase 3**: Extract core CLI logic into standalone library  
**Phase 4**: Create CLI-only FlightPath tool  
**Phase 5**: Multi-IDE support using shared CLI core

## Appendix: CLI Command Reference

### Basic Usage

```bash
# Execute prompt
copilot -p "Fix bug in main.js" --allow-all-tools

# With specific model
copilot -p "Explain TypeScript interfaces" --model gpt-5

# With directory access
copilot -p "Refactor code" --add-dir ~/projects --allow-all-tools

# Resume session
copilot --resume --allow-all-tools
```

### Tool Permissions

```bash
# Allow all tools
copilot --allow-all-tools

# Allow specific tools
copilot --allow-tool 'write' --allow-tool 'shell(git:*)'

# Deny specific tools
copilot --allow-all-tools --deny-tool 'shell(rm:*)'
```

### Output Format

```
[Response text here - multiple lines possible]
[Empty line separator]

Total usage est:       1 Premium request
Total duration (API):  4.0s
Total duration (wall): 5.4s
Total code changes:    0 lines added, 0 lines removed
Usage by model:
    claude-sonnet-4.5    13.1k input, 41 output, 0 cache read, 0 cache write (Est. 1 Premium request)
```
