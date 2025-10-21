# Copilot Response Handling - Research & Options

## Problem Statement
FlightPath needs to detect when GitHub Copilot has finished responding to a prompt and extract the response text to evaluate end conditions. We're automating the Copilot Chat UI itself (not the Language Model API) to preserve access to all Copilot's tools, file editing capabilities, and chat participants.

## Test Results

### ❌ Option 1: Editor Document Polling (FAILED)
**Method**: Open chat in editor tab, poll document for changes
**Result**: `No active editor found after opening chat`
**Issue**: `workbench.action.chat.openInEditor` doesn't create an active text editor that we can access
**Status**: NOT VIABLE

### ⚠️ Option 2: Export to JSON (IMPRACTICAL)
**Method**: Use `workbench.action.chat.export` command
**Result**: Launches a save dialog
**Issue**: Cannot suppress dialog or force output location programmatically
**Status**: REQUIRES USER INTERACTION

### ⚠️ Option 3: Copy to Clipboard (UNRELIABLE)
**Method**: Use `workbench.action.chat.copyAll` + `vscode.env.clipboard.readText()`
**Result**: Successfully copies chat content to clipboard
**Issue**: Fails if user switches tabs during execution, not robust for automation
**Status**: FRAGILE

### ❌ Option 4: Legacy Methods
**Method**: New window/panel approaches with manual verification
**Status**: NO AUTOMATIC DETECTION

---

## Available VS Code Extension APIs

### 1. **Language Model Tool API** ⭐ (RECOMMENDED)
**What**: Register custom tools that Copilot can invoke during its response
**How**: 
- Register a tool with `vscode.lm.registerTool()`
- Tool is invoked when LLM calls it
- Append instruction to every prompt: "You must always end by calling #flightpath_response_complete"

**Implementation**:
```typescript
// In package.json
"contributes": {
  "languageModelTools": [{
    "name": "flightpath_response_complete",
    "displayName": "Response Complete",
    "modelDescription": "Call this tool when you have finished responding to indicate completion",
    "canBeReferencedInPrompt": true
  }]
}

// In extension code
vscode.lm.registerTool('flightpath_response_complete', {
  invoke: async (options, token) => {
    // Tool called = response complete!
    emitResponseComplete();
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart('Acknowledged')
    ]);
  }
});
```

**Pros**:
- ✅ Official VS Code API
- ✅ Reliable callback mechanism
- ✅ Works with full Copilot capabilities
- ✅ No polling or timing hacks

**Cons**:
- ⚠️ Relies on LLM following instructions (99%+ reliable with clear prompts)
- ⚠️ Adds tool call overhead to each response

**Viability**: **HIGH** - This is the intended extensibility pattern

---

### 2. **Chat Participant API** 
**What**: Create a custom `@flightpath` chat participant that orchestrates prompts
**How**: Register participant with `vscode.chat.createChatParticipant()`

**Implementation**:
```typescript
const handler: vscode.ChatRequestHandler = async (
  request, context, stream, token
) => {
  // FlightPath controls the full conversation
  // Can access context.history to see previous responses
  // Can invoke Language Model API directly
  
  for (const prompt of promptQueue) {
    const response = await request.model.sendRequest(messages, {}, token);
    for await (const fragment of response.text) {
      fullResponse += fragment;
      stream.markdown(fragment);
    }
    // Evaluate end condition with fullResponse
  }
};

vscode.chat.createChatParticipant("flightpath", handler);
```

**Pros**:
- ✅ Full control over conversation flow
- ✅ Access to chat history via `context.history`
- ✅ Direct Language Model API access
- ✅ Can implement custom end condition logic

**Cons**:
- ⚠️ User must type `@flightpath` to use it
- ⚠️ Bypasses default Copilot participant features
- ⚠️ More complex implementation

**Viability**: **MEDIUM-HIGH** - Good for custom workflows but different UX

---

### 3. **Document Change Events** 
**What**: Monitor text document changes with `workspace.onDidChangeTextDocument`
**How**: If chat creates/modifies a document, listen for changes

**Implementation**:
```typescript
vscode.workspace.onDidChangeTextDocument(event => {
  // Check if this is the chat document
  if (isChatDocument(event.document.uri)) {
    // Monitor for stable state
    detectStableContent(event.document.getText());
  }
});
```

**Pros**:
- ✅ Standard VS Code event API

**Cons**:
- ❌ Chat UI may not expose documents we can monitor
- ❌ No clear way to identify "chat documents"
- ❌ Requires polling for stable state

**Viability**: **LOW** - Chat UI internals not exposed

---

### 4. **Webview API + Custom UI**
**What**: Create a custom webview panel that wraps Copilot Chat
**How**: Build custom UI that embeds chat functionality

**Pros**:
- ✅ Complete control over UI
- ✅ Message passing between webview and extension

**Cons**:
- ❌ Cannot embed actual Copilot Chat UI
- ❌ Would need to reimplement chat interface
- ❌ Massive development effort
- ❌ Loses all native chat features

**Viability**: **NOT APPLICABLE** - Wrong approach for this problem

---

### 5. **Tree View / Custom View**
**What**: Create sidebar view to manage FlightPath workflows
**How**: Use `window.registerTreeDataProvider()` or `window.createTreeView()`

**Pros**:
- ✅ Good for workflow management UI
- ✅ Can trigger chat automations

**Cons**:
- ❌ Doesn't solve response detection problem
- ✅ Could complement other solutions

**Viability**: **SUPPLEMENTARY** - Good for UI, not for detection

---

### 6. **Commands with Return Values** (Research Needed)
**What**: Check if any chat commands return response data
**Commands to Test**:
- `github.copilot.chat.debug.saveCurrentMarkdown` - Save response as markdown
- `github.copilot.chat.debug.exportPromptLogsAsJson` - Export logs
- `vscode.copilot.chat.showRequestHtmlItem` - Show request HTML

**Status**: NEEDS TESTING - May provide internal hooks

---

### 7. **Clipboard + Active Document Combo**
**What**: Hybrid approach using clipboard with document locking
**How**:
- Lock active document before submitting
- Use clipboard to get response
- Verify user hasn't changed focus

**Viability**: **LOW** - Still fragile, not production-ready

---

## Recommended Approach: Language Model Tool

### Implementation Plan

1. **Register Tool** (`flightpath_response_complete`)
   - Simple tool with no input parameters
   - Called by Copilot to signal completion

2. **Modify Prompt Strategy**
   - Append to every prompt: 
     ```
     IMPORTANT: You must always call the #flightpath_response_complete tool 
     when you have finished your response to signal completion.
     ```

3. **Tool Callback**
   - Emits event when called
   - Triggers end condition evaluation
   - Moves to next prompt in queue

4. **Fallback Mechanisms**
   - Timeout if tool not called within expected time
   - Optional clipboard fallback for error cases

### Code Structure
```typescript
class CopilotIntegration {
  private responseCompleteEmitter = new vscode.EventEmitter<void>();
  onResponseComplete = this.responseCompleteEmitter.event;
  
  async initialize() {
    this.registerResponseTool();
  }
  
  private registerResponseTool() {
    const tool = vscode.lm.registerTool(
      'flightpath_response_complete',
      this.handleResponseComplete.bind(this)
    );
    this.subscriptions.push(tool);
  }
  
  private async handleResponseComplete(options, token) {
    console.log('✅ Copilot response complete');
    this.responseCompleteEmitter.fire();
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart('Complete')
    ]);
  }
  
  async sendPrompt(prompt: string): Promise<string> {
    const enhancedPrompt = `${prompt}\n\nIMPORTANT: Call #flightpath_response_complete when done.`;
    
    // Submit to chat UI
    await this.submitToChat(enhancedPrompt);
    
    // Wait for tool callback or timeout
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Response timeout'));
      }, 60000);
      
      const disposable = this.onResponseComplete(() => {
        clearTimeout(timeout);
        disposable.dispose();
        // Get response using clipboard as fallback
        resolve(this.getChatResponse());
      });
    });
  }
}
```

---

## Alternative: Chat Participant Approach

If tool reliability is insufficient, create a custom `@flightpath` participant:

```typescript
const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  // Parse FlightPath workflow from request
  const workflow = await parseFlightPathWorkflow(request.prompt);
  
  for (const step of workflow.steps) {
    // Send to language model
    const response = await request.model.sendRequest([
      vscode.LanguageModelChatMessage.User(step.prompt)
    ], {}, token);
    
    let fullResponse = '';
    for await (const fragment of response.text) {
      fullResponse += fragment;
      stream.markdown(fragment);
    }
    
    // Evaluate end condition
    if (step.endCondition) {
      const passed = await evaluateCondition(step.endCondition, fullResponse);
      if (!passed) {
        stream.markdown('\n\n⚠️ End condition not met, retrying...');
        // Retry logic
      }
    }
  }
};
```

---

## Next Steps

1. ✅ **Implement Language Model Tool approach** (Primary)
2. ⚠️ Test tool reliability with various prompts
3. 🔄 Implement clipboard fallback for edge cases
4. 📋 Consider Chat Participant as alternative UX
5. 🧪 Test with real FlightPath workflows

---

## References

- [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools)
- [Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat)
- [Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- VS Code Extension Samples: [chat-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-sample)
