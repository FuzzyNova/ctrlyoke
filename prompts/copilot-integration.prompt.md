# ctrlyoke Copilot Chat Integration Implementation

## ✅ PROVEN FEASIBILITY

**Direct Copilot Chat automation has been successfully tested and validated!**

A proof-of-concept implementation in `extension.ts` (lines 9-98, function `testCopilotAutomation()`) has confirmed that the following automation sequence works reliably:

1. **Focus Chat**: `workbench.panel.chat.view.copilot.focus` - Successfully focuses Copilot Chat panel
2. **Clear Input**: `editor.action.selectAll` - Clears any existing text in chat input
3. **Type Message**: `type` command with `{ text: message }` - Directly inserts text into chat input
4. **Submit**: `workbench.action.chat.submit` - Automatically submits the message

**Validated Timing Requirements** (from successful test):

- Focus delay: **1000ms** (allows chat panel to fully initialize)
- Clear delay: **300ms** (ensures selection completes)
- Type delay: **500ms** (allows typing to complete before submission)

This proves that **zero-interaction automation is achievable** - users can truly "press go and leave" while ctrlyoke executes multi-prompt workflows automatically.

## Objective

Replace the stub implementation in `CopilotIntegration.ts` with the proven Copilot Chat automation approach. Enable ctrlyoke's automated prompt workflows to seamlessly integrate with Copilot Chat through direct command-based automation, eliminating manual paste steps entirely.

<context>
ctrlyoke is a VS Code extension that automates GitHub Copilot through structured JSON prompt workflows. The current CopilotIntegration.ts contains a stub implementation (lines 69-71) that falls back to clipboard copying and manual chat opening.

**PROVEN AUTOMATION APPROACH**: The proof-of-concept test in `extension.ts:testCopilotAutomation()` successfully validated direct chat automation using VS Code commands.

Current ctrlyoke workflow:

1. User executes `ctrlyoke.takeOff` command
2. CtrlYokeManager loads .ctrlyoke.json or .prompt.json files
3. PromptQueue processes prompts sequentially with end condition validation
4. CopilotIntegration.sendPrompt() needs real implementation for automated execution

Architecture details available in .github/copilot-instructions.md (automatically included in context).
</context>

<requirements>
### Primary Requirements
1. **Replace Stub Implementation**: Transform the current fallback implementation into enhanced Copilot Chat automation
2. **Maintain Workflow Automation**: Preserve ctrlyoke's core value proposition of automated prompt sequences
3. **Context Awareness**: Properly format workspace context, files, and selections using Copilot Chat syntax
4. **User Guidance**: Provide clear instructions and progress tracking for manual paste workflow steps
5. **Error Handling**: Graceful degradation with clear user feedback when Copilot Chat is unavailable
6. **Backward Compatibility**: Existing command-based workflows must continue to work

### Secondary Requirements

7. **Progress Indicators**: Show workflow progress with status bar updates and notifications
8. **Prompt Preview**: Allow users to preview generated prompts before copying to clipboard
9. **Workflow State**: Maintain workflow progress and context across multiple prompt steps
10. **Cancellation Support**: Proper handling of user cancellation and workflow pause/resume
    </requirements>

<code_quality_principles>

- **Single Responsibility**: Keep CopilotIntegration focused on LLM communication, delegate UI concerns to separate classes
- **Open/Closed**: Design for extensibility - support multiple LLM backends and response formats
- **Dependency Inversion**: Abstract the LLM API behind interfaces for testability
- **Error Boundaries**: Comprehensive error handling with user-friendly messages
- **Type Safety**: Leverage TypeScript strict mode for compile-time safety
- **KISS Principle**: Start with core LLM integration, add chat participant as enhancement
  </code_quality_principles>

<architecture_plan>

### Phase 1: Direct Command Automation (Primary - PROVEN)

**File**: `src/core/CopilotIntegration.ts`

**Key Changes** (Based on validated proof-of-concept):

1. Replace `openCopilotChatWithPrompt()` stub with proven direct command automation
2. Implement the validated command sequence: focus → clear → type → submit
3. Use proven timing delays: 1000ms (focus), 300ms (clear), 500ms (type)
4. Implement intelligent Copilot Chat syntax formatting (`@workspace`, `#file`, `/fix`)
5. Improve context building from PromptItem.context configuration
6. Add fallback chain for environments where commands are unavailable
7. Maintain workflow state across multiple prompt interactions

**New Methods**:

- `buildCopilotChatPrompt(prompt: PromptItem): Promise<string>`
- `formatContextForCopilotChat(context: ContextConfig): Promise<string>`
- `openCopilotChatWithEnhancedPrompt(prompt: string): Promise<boolean>`
- `trackWorkflowProgress(step: number, total: number): Promise<void>`

### Phase 2: Workflow Management Enhancement (Secondary)

**Files**: `CtrlYokeManager.ts`, `StatusBarManager.ts`

**Features**:

- Enhanced progress tracking with visual indicators
- User feedback collection for workflow continuation decisions
- Improved error handling and recovery mechanisms
- Workflow pause/resume capabilities with state persistence

### Phase 3: Integration Points

**Files**: `CtrlYokeManager.ts`, `PromptQueue.ts`

**Updates**:

- Support dual execution modes: command-based (existing) and chat-based (new)
- Progress callback mechanism for chat streaming
- Enhanced error reporting for chat interface
  </architecture_plan>

<implementation_strategy>

### Step 1: Research and Setup

1. Examine current VS Code Language Model API access patterns
2. Identify required package.json updates for proposed APIs
3. Test LLM API availability detection

### Step 2: True Chat Automation (Joyride-Style)

**APPROACH**: Direct automation of Copilot Chat input using VS Code's built-in commands, eliminating manual paste steps entirely.

**CORE AUTOMATION STRATEGY**:

1. **Multi-Strategy Automation Implementation**:
   - **Primary**: Direct text insertion using `type` command for zero-interaction automation
   - **Secondary**: Enhanced clipboard + command sequencing with auto-submission
   - **Fallback**: Improved clipboard automation with user guidance
   - **Advanced**: Direct Language Model API integration for complete automation

2. **Key VS Code Commands for Chat Automation**:

   ```typescript
   // Chat-specific commands
   "workbench.panel.chat.view.copilot.focus"; // Open/focus Copilot Chat
   "workbench.action.chat.submit"; // Submit chat message
   "workbench.action.chat.clear"; // Clear chat history
   "workbench.action.chat.newSession"; // Start new chat session

   // Text manipulation commands
   "type"; // Insert text at cursor
   "editor.action.selectAll"; // Select all text in input
   "editor.action.clipboardPasteAction"; // Paste from clipboard
   "deleteAllLeft"; // Clear input field

   // Navigation commands
   "workbench.action.focusChatInput"; // Focus chat input field
   "workbench.action.nextChatResponse"; // Navigate responses
   ```

3. **Direct Text Insertion (Zero-Interaction)**:
   - Use `type` command to insert formatted prompts directly into chat input
   - Automatic command sequencing with proper timing controls
   - No manual paste or enter key required
   - Maintains all Copilot Chat features (@workspace, slash commands, etc.)

4. **Enhanced Context Building**:
   - Automatically detect and include relevant workspace files
   - Format file references using Copilot Chat syntax (`#file:filename`)
   - Include current selection with `#selection` when appropriate
   - Add workspace context with `@workspace` for broader understanding
   - Apply intelligent slash commands (`/fix`, `/explain`, `/new`) based on prompt content

### Step 3: Error Handling and Fallbacks

1. Detect LLM API availability with graceful degradation
2. Enhanced clipboard fallback with better user guidance
3. Progress indicators and status updates
4. Proper cancellation token handling

### Step 4: Chat Participant Implementation

1. Create CtrlYokeChatParticipant class
2. Register participant in extension activation
3. Implement command handlers for workflow control
4. Add progress streaming to chat interface

### Step 5: Integration and Testing

1. Update CtrlYokeManager for dual execution modes
2. Test with existing .ctrlyoke.json workflows
3. Validate end condition script compatibility
4. Performance testing with large context files
   </implementation_strategy>

<examples>
### Zero-Interaction Chat Automation (Option A - Primary)

```typescript
// Direct text insertion automation - NO manual paste required
// ✅ PROVEN APPROACH: Validated in extension.ts:testCopilotAutomation()
private async sendPromptWithDirectAutomation(prompt: PromptItem): Promise<boolean> {
    const chatPrompt = await this.buildCopilotChatPrompt(prompt);

    try {
        // 1. Focus Copilot Chat
        await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');

        // 2. Wait for focus to settle (PROVEN: 1000ms required for reliability)
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 3. Clear any existing input
        await vscode.commands.executeCommand('editor.action.selectAll');
        await new Promise(resolve => setTimeout(resolve, 300)); // Allow selection to complete

        // 4. Type the prompt directly into the focused input
        await vscode.commands.executeCommand('type', { text: chatPrompt });
        await new Promise(resolve => setTimeout(resolve, 500)); // Allow typing to complete

        // 5. Submit the prompt automatically
        await vscode.commands.executeCommand('workbench.action.chat.submit');

        return true;
    } catch (error) {
        console.error('Direct automation failed:', error);
        // Fallback to enhanced clipboard method
        return await this.sendPromptWithEnhancedClipboard(prompt);
    }
}

// Enhanced command sequencing automation
private async sendPromptWithCommandSequence(prompt: PromptItem): Promise<boolean> {
    const chatPrompt = await this.buildCopilotChatPrompt(prompt);

    // Copy to clipboard as backup
    await vscode.env.clipboard.writeText(chatPrompt);

    // Execute command sequence with proper timing
    const commands = [
        'workbench.panel.chat.view.copilot.focus',
        () => new Promise(resolve => setTimeout(resolve, 300)),
        'editor.action.selectAll',
        () => new Promise(resolve => setTimeout(resolve, 100)),
        'editor.action.clipboardPasteAction',
        () => new Promise(resolve => setTimeout(resolve, 200)),
        'workbench.action.chat.submit'
    ];

    for (const cmd of commands) {
        if (typeof cmd === 'function') {
            await cmd();
        } else {
            await vscode.commands.executeCommand(cmd);
        }
    }

    return true;
}

// Multi-strategy automation with fallback chain
async sendPrompt(prompt: PromptItem): Promise<boolean> {
    // Strategy 1: Direct text insertion (cleanest)
    if (await this.isDirectAutomationSupported()) {
        const result = await this.sendPromptWithDirectAutomation(prompt);
        if (result) return true;
    }

    // Strategy 2: Command sequence automation
    if (await this.isCommandSequenceSupported()) {
        const result = await this.sendPromptWithCommandSequence(prompt);
        if (result) return true;
    }

    // Strategy 3: Enhanced clipboard fallback
    return await this.sendPromptWithEnhancedClipboard(prompt);
}

private async isDirectAutomationSupported(): Promise<boolean> {
    try {
        const commands = await vscode.commands.getCommands();
        return commands.includes('workbench.action.chat.submit') &&
               commands.includes('type') &&
               commands.includes('workbench.panel.chat.view.copilot.focus');
    } catch {
        return false;
    }
}
```

### Enhanced Copilot Chat Prompt Formatting

```typescript
// Enhanced prompt formatting for Copilot Chat
private async buildCopilotChatPrompt(prompt: PromptItem): Promise<string> {
    let chatPrompt = '';

    // Add workspace context using Copilot Chat variables
    if (prompt.context?.includeWorkspaceFiles) {
        chatPrompt += '@workspace ';
    }

    // Add specific file references
    if (prompt.context?.includeCurrentFile) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const fileName = vscode.workspace.asRelativePath(activeEditor.document.uri);
            chatPrompt += `@file:${fileName} `;
        }
    }

    // Add selection context
    if (prompt.context?.includeSelection) {
        chatPrompt += '@selection ';
    }

    // Add the main prompt
    chatPrompt += prompt.prompt;

    // Add relevant slash commands if applicable
    if (prompt.prompt.includes('fix') || prompt.prompt.includes('error')) {
        chatPrompt = `/fix ${chatPrompt}`;
    } else if (prompt.prompt.includes('explain')) {
        chatPrompt = `/explain ${chatPrompt}`;
    }

    return chatPrompt;
}

// Enhanced clipboard fallback with better UX
private async sendPromptWithEnhancedClipboard(prompt: PromptItem): Promise<boolean> {
    const chatPrompt = await this.buildCopilotChatPrompt(prompt);

    // Copy formatted prompt to clipboard
    await vscode.env.clipboard.writeText(chatPrompt);

    // Open Copilot Chat
    await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');

    // Show helpful notification with workflow progress
    const action = await vscode.window.showInformationMessage(
        'ctrlyoke: Prompt ready! Paste (Ctrl+V) and press Enter to continue workflow.',
        { modal: false },
        'Continue Workflow',
        'Preview Prompt',
        'Pause Workflow'
    );

    if (action === 'Preview Prompt') {
        // Show the formatted prompt in a preview document
        const doc = await vscode.workspace.openTextDocument({
            content: `ctrlyoke Copilot Chat Prompt:\n\n${chatPrompt}`,
            language: 'markdown'
        });
        await vscode.window.showTextDocument(doc, { preview: true });
    }

    return action === 'Continue Workflow';
}
```

### Workflow Progress Tracking

```typescript
// Enhanced workflow progress with user feedback
private async trackWorkflowProgress(
  workflowStep: number,
  totalSteps: number,
  currentPrompt: string
): Promise<void> {
  // Update status bar with progress
  const progress = `${workflowStep}/${totalSteps}`;
  vscode.window.setStatusBarMessage(
    `ctrlyoke: Step ${progress} - Waiting for Copilot Chat response...`,
    5000
  );

  // Show progress notification
  const action = await vscode.window.showInformationMessage(
    `ctrlyoke Workflow Progress (${progress}): Ready for next step?`,
    'Continue', 'Pause', 'Stop'
  );

  if (action === 'Pause') {
    this.pauseWorkflow();
  } else if (action === 'Stop') {
    this.stopWorkflow();
  }
}
```

### Enhanced Context Formatting for Clipboard

```typescript
private async formatContextForCopilotChat(context: ContextConfig): Promise<string> {
    const contextParts: string[] = [];

    // Add workspace files with proper Copilot Chat syntax
    if (context.includeWorkspaceFiles) {
        for (const pattern of context.includeWorkspaceFiles) {
            const files = await vscode.workspace.findFiles(pattern, null, 5);
            for (const file of files) {
                const fileName = vscode.workspace.asRelativePath(file);
                contextParts.push(`#file:${fileName}`);
            }
        }
    }

    // Add current file if specified
    if (context.includeCurrentFile) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const fileName = vscode.workspace.asRelativePath(activeEditor.document.uri);
            contextParts.push(`#file:${fileName}`);
        }
    }

    // Add selection context
    if (context.includeSelection) {
        contextParts.push('#selection');
    }

    return contextParts.join(' ');
}
```

</examples>

<success_criteria>

### Functional Requirements (✅ Core Automation PROVEN in POC)

- [ ] **Zero-Interaction Automation**: ctrlyoke workflows execute with NO manual paste/enter steps required ✅ VALIDATED
- [ ] **Multi-Strategy Implementation**: Primary direct automation (proven) with fallback chain for maximum reliability
- [ ] **True Workflow Automation**: Sequential prompt execution with automatic submission and progression ✅ VALIDATED
- [ ] **Context Awareness**: Workspace files, selections, and context properly formatted with Copilot Chat syntax
- [ ] **End Condition Integration**: Scripts can evaluate responses and automatically trigger next workflow steps
- [ ] **Backward Compatibility**: Existing .ctrlyoke.json and .prompt.json workflows continue to work unchanged

### Technical Requirements (✅ Command Sequence PROVEN)

- [ ] **Command-Based Automation**: Uses `type`, `workbench.action.chat.submit` for direct text insertion and submission ✅ VALIDATED
- [ ] **Proven Timing Delays**: 1000ms (focus), 300ms (clear), 500ms (type) ✅ VALIDATED
- [ ] **Availability Detection**: Automatically detects which automation commands are available in current VS Code version
- [ ] **Fallback Chain**: Multiple automation strategies with graceful degradation
- [ ] **Performance**: Context building completes quickly even with large workspace files (< 5 seconds)
- [ ] **Memory Management**: Reasonable usage with large context files and long workflow chains
- [ ] **Error Handling**: Comprehensive error boundaries with user-friendly messages and automatic recovery
- [ ] **TypeScript Compliance**: Strict mode compliance with full type safety

### User Experience Requirements

- [ ] **"Press Go and Leave"**: True set-and-forget workflow execution requiring no user interaction
- [ ] **Progress Indicators**: Real-time status bar and notification updates during workflow execution
- [ ] **Workflow Control**: Pause, resume, and stop capabilities during automated execution
- [ ] **Preview Options**: Ability to preview generated prompts before execution when desired
- [ ] **Error Recovery**: Clear feedback when automation fails with actionable next steps
- [ ] **Configuration**: User choice of automation level (direct, enhanced clipboard, etc.)

### Automation Strategy Success Criteria

- [ ] **Primary Strategy**: Direct `type` command automation works reliably for zero-interaction workflows
- [ ] **Secondary Strategy**: Command sequence automation provides backup when direct typing unavailable
- [ ] **Tertiary Strategy**: Enhanced clipboard automation maintains workflow continuity with minimal user interaction
- [ ] **Detection Logic**: Accurate identification of available VS Code commands and chat automation capabilities
- [ ] **Timing Control**: Proper async sequencing prevents race conditions in command execution
      </success_criteria>

<instructions>
**Primary Focus**: Implement the PROVEN zero-interaction Copilot Chat automation using VS Code's built-in command system.

**✅ VALIDATION**: The proof-of-concept test in `extension.ts:testCopilotAutomation()` (lines 9-98) has successfully validated this automation approach. Use it as a reference implementation.

**IMPLEMENTATION APPROACH - Direct Chat Automation (Proven & Tested)**:

This approach has been validated through successful testing and achieves complete automation while preserving ALL Copilot Chat features:

🎯 **Zero-Interaction Automation Goal**:

- **"Press Go and Leave Computer"**: User starts workflow, no further interaction required
- **Automatic Prompt Submission**: Uses `type` and `workbench.action.chat.submit` commands
- **Sequential Workflow Execution**: Automated progression through multi-prompt workflows
- **End Condition Integration**: Scripts evaluate responses and trigger next steps automatically

✅ **Preserves Full Copilot Chat Experience**:

- `@workspace`, `@vscode` agents and context awareness
- `/fix`, `/explain`, `/new` slash commands
- Chat variables like `@selection`, `@file`
- Conversation history in actual Copilot Chat UI
- All Copilot Chat enhancements and tools

🔧 **Multi-Strategy Implementation**:

1. **Primary Strategy - Direct Text Insertion**:
   - Use `vscode.commands.executeCommand('type', { text: prompt })` for direct input
   - Use `vscode.commands.executeCommand('workbench.action.chat.submit')` for automatic submission
   - Zero manual steps required - true automation

2. **Secondary Strategy - Command Sequence**:
   - Enhanced clipboard + automatic paste and submit sequence
   - Fallback when direct typing is unavailable
   - Still maintains workflow automation

3. **Tertiary Strategy - Enhanced Clipboard**:
   - Improved user guidance with minimal interaction
   - Preserves workflow state and progress tracking
   - Graceful degradation for unsupported environments

**Core Implementation Requirements**:

1. **Multi-Strategy sendPrompt() Method**:
   - Detect available VS Code commands (`type`, `workbench.action.chat.submit`)
   - Implement fallback chain for maximum compatibility
   - Return execution status for end condition evaluation

2. **Direct Automation Implementation** (✅ PROVEN in extension.ts:testCopilotAutomation):
   - Focus chat window: `workbench.panel.chat.view.copilot.focus` + 1000ms delay
   - Clear input: `editor.action.selectAll` + 300ms delay
   - Insert prompt: `type` command with formatted text + 500ms delay
   - Submit automatically: `workbench.action.chat.submit`
   - **CRITICAL**: Use proven timing delays - these are not arbitrary, they're validated!

3. **Intelligent Context Formatting**:
   - Format prompts with Copilot Chat syntax (`@workspace`, `@file`, `/fix`)
   - Build rich context packages (workspace files, selections, chat variables)
   - Apply slash commands based on prompt analysis

4. **Workflow Integration**:
   - Maintain workflow state across multiple automated prompts
   - Progress tracking with status bar updates
   - End condition script integration for response evaluation
   - Automatic continuation to next workflow step

**Key Technical Implementation Details**:

```typescript
// Core automation method structure
async sendPrompt(prompt: PromptItem): Promise<boolean> {
  // 1. Try direct automation first (zero-interaction)
  if (await this.isDirectAutomationSupported()) {
    return await this.sendPromptWithDirectAutomation(prompt);
  }

  // 2. Fallback to command sequence automation
  if (await this.isCommandSequenceSupported()) {
    return await this.sendPromptWithCommandSequence(prompt);
  }

  // 3. Final fallback to enhanced clipboard
  return await this.sendPromptWithEnhancedClipboard(prompt);
}
```

**Testing and Validation Strategy**:

- Test all automation strategies across different VS Code versions
- Validate command availability detection logic
- Test with existing .ctrlyoke.json workflow files
- Verify end condition script integration works with automated responses
- Performance test with large context and long workflow chains
- Test error handling and fallback mechanisms

**Architecture Integration**:

- Follow existing SOLID principles and separation of concerns
- Maintain compatibility with existing CtrlYokeManager and PromptQueue
- Use dependency injection for testability of different automation strategies
- Implement proper error boundaries and user feedback mechanisms

**Success Definition**:

Transform ctrlyoke into a true "set-and-forget AI workflow orchestrator" where users can:

1. Load a .ctrlyoke.json file with multiple prompts
2. Execute `ctrlyoke.takeOff` command
3. Walk away from computer
4. Return to completed workflow with all prompts executed and end conditions evaluated

This achieves the ultimate goal of **automated sequential AI interactions** with zero human intervention required.
</instructions>
