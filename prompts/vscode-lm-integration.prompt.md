# FlightPath vscode.lm API Integration for Sub-Agents

## Objective

Implement VS Code Language Model API integration to enable AI-powered sub-agents within FlightPath workflows. This will primarily be used for intelligent end condition evaluation where an AI agent analyzes Copilot Chat outputs to determine workflow completion status.

<context>
This is a **future enhancement** for FlightPath that complements the main Copilot Chat automation. The primary use case is enabling AI-powered end condition evaluation:

1. User executes FlightPath workflow through enhanced Copilot Chat automation
2. Copilot Chat generates response to workflow step
3. **AI Sub-Agent** (using vscode.lm) analyzes the response
4. Sub-agent determines if end condition is met or if workflow should continue
5. FlightPath proceeds to next step or completes workflow

This enables more sophisticated workflow control than simple script-based end conditions.
</context>

<requirements>
### Primary Requirements
1. **vscode.lm API Integration**: Implement direct Language Model API access using existing Copilot subscription
2. **AI End Condition Evaluation**: Sub-agents that can analyze Copilot Chat outputs and make continuation decisions
3. **Context Awareness**: Provide workflow context and history to sub-agents for informed decisions
4. **Structured Response Handling**: Return standardized decision objects (continue/complete/retry/error)
5. **Tool Support**: Enable sub-agents to access custom tools for enhanced decision-making
6. **Performance Optimization**: Minimize API calls and latency for workflow efficiency

### Secondary Requirements

7. **Multi-Agent Orchestration**: Support multiple specialized sub-agents for different evaluation types
8. **Learning Capabilities**: Sub-agents can improve over time based on workflow outcomes
9. **Fallback Mechanisms**: Graceful degradation to script-based end conditions when LM API unavailable
10. **Debug and Observability**: Clear logging and debugging for sub-agent decision processes
    </requirements>

<code_quality_principles>

- **Single Responsibility**: Separate sub-agent logic from main Copilot Chat integration
- **Strategy Pattern**: Pluggable end condition evaluators (script-based, AI-based, hybrid)
- **Observer Pattern**: Sub-agents can observe and react to workflow state changes
- **Command Pattern**: Sub-agent decisions as executable commands
- **Factory Pattern**: Create appropriate sub-agents based on end condition type
- **Circuit Breaker**: Prevent cascading failures when sub-agents malfunction
  </code_quality_principles>

<architecture_plan>

### Phase 1: Core vscode.lm Integration

**New File**: `src/flightpath/SubAgentManager.ts`

**Key Components**:

1. **LanguageModelService**: Wrapper for vscode.lm API calls
2. **EndConditionSubAgent**: AI-powered end condition evaluator
3. **ContextBuilder**: Prepare workflow context for sub-agent analysis
4. **DecisionEngine**: Process sub-agent responses into workflow decisions
5. **ToolRegistry**: Custom tools available to sub-agents

### Phase 2: Specialized Sub-Agents

**New Files**:

- `src/flightpath/subagents/CodeQualityAgent.ts` - Evaluates code quality and completeness
- `src/flightpath/subagents/ErrorAnalysisAgent.ts` - Analyzes error messages and solutions
- `src/flightpath/subagents/TaskCompletionAgent.ts` - Determines if specific tasks are complete
- `src/flightpath/subagents/WorkflowOrchestratorAgent.ts` - Makes high-level workflow decisions

### Phase 3: Integration Points

**Modified Files**: `EndConditionEvaluator.ts`, `PromptQueue.ts`

**Updates**:

- Support AI-based end conditions alongside script-based
- Sub-agent decision integration with workflow state machine
- Performance monitoring and fallback mechanisms
  </architecture_plan>

<implementation_strategy>

### Step 1: vscode.lm Foundation

1. **Implement LanguageModelService**:
   - Use `vscode.lm.selectChatModels({ vendor: 'copilot' })`
   - Handle model selection and availability
   - Implement request/response patterns with proper error handling
   - Add conversation context management

2. **Create SubAgent Base Class**:
   - Abstract base for all AI sub-agents
   - Standard input/output interfaces
   - Tool calling capabilities
   - Decision result formatting

### Step 2: End Condition AI Integration

1. **Enhance EndConditionEvaluator**:
   - Support new end condition type: `"ai-evaluation"`
   - Route to appropriate sub-agent based on evaluation type
   - Fallback to script-based evaluation on AI failures

2. **Implement EndConditionSubAgent**:
   - Analyze Copilot Chat responses
   - Determine workflow completion status
   - Provide reasoning for decisions
   - Handle edge cases and ambiguous outputs

### Step 3: Tool System Implementation

1. **Create Custom Tools**:
   - File analysis tools
   - Code validation tools
   - Workspace inspection tools
   - Test execution tools

2. **Tool Registration and Management**:
   - Register tools with vscode.lm API
   - Provide tools to sub-agents as needed
   - Tool result processing and error handling

### Step 4: Advanced Sub-Agents

1. **Specialized Agent Implementation**:
   - Code quality assessment agents
   - Error analysis and resolution agents
   - Task completion verification agents
   - Workflow orchestration agents

2. **Multi-Agent Coordination**:
   - Agent communication patterns
   - Consensus mechanisms for complex decisions
   - Performance optimization across multiple agents
     </implementation_strategy>

<examples>
### Basic vscode.lm Integration

```typescript
export class LanguageModelService {
  private models: vscode.LanguageModelChat[] = [];

  async initialize(): Promise<void> {
    this.models = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: "gpt-4",
    });

    if (this.models.length === 0) {
      throw new Error("No Copilot models available for sub-agents");
    }
  }

  async sendRequest(
    messages: vscode.LanguageModelChatMessage[],
    tools?: vscode.LanguageModelTool[],
    token?: vscode.CancellationToken
  ): Promise<string> {
    const model = this.models[0];
    const options = tools ? { tools } : {};

    const response = await model.sendRequest(messages, options, token);

    let fullResponse = "";
    for await (const chunk of response.text) {
      fullResponse += chunk;
    }

    return fullResponse;
  }
}
```

### AI End Condition Evaluator

```typescript
export class EndConditionSubAgent extends BaseSubAgent {
  async evaluateEndCondition(
    copilotResponse: string,
    expectedOutcome: string,
    workflowContext: WorkflowContext
  ): Promise<EndConditionResult> {
    const messages = [
      vscode.LanguageModelChatMessage.User(`
                You are an AI workflow evaluator for FlightPath. Analyze the Copilot Chat response 
                and determine if the workflow step has been completed successfully.
                
                Expected Outcome: ${expectedOutcome}
                Workflow Context: ${JSON.stringify(workflowContext, null, 2)}
                
                Copilot Chat Response:
                ${copilotResponse}
                
                Respond with JSON in this format:
                {
                    "decision": "continue" | "complete" | "retry" | "error",
                    "confidence": 0.0-1.0,
                    "reasoning": "explanation of decision",
                    "nextAction": "suggested next step if applicable"
                }
            `),
    ];

    const response = await this.languageModelService.sendRequest(messages);
    return this.parseDecisionResponse(response);
  }

  private parseDecisionResponse(response: string): EndConditionResult {
    try {
      const parsed = JSON.parse(response);
      return {
        shouldContinue: parsed.decision !== "complete",
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        nextAction: parsed.nextAction,
        rawResponse: response,
      };
    } catch (error) {
      // Fallback to script-based evaluation on parse failure
      throw new SubAgentError("Failed to parse AI decision", error);
    }
  }
}
```

### Custom Tool Registration

```typescript
export class FlightPathTools {
  static registerAll(context: vscode.ExtensionContext): void {
    // File analysis tool
    context.subscriptions.push(
      vscode.lm.registerTool("flightpath_analyzeFile", new FileAnalysisTool())
    );

    // Code validation tool
    context.subscriptions.push(
      vscode.lm.registerTool(
        "flightpath_validateCode",
        new CodeValidationTool()
      )
    );

    // Workspace inspection tool
    context.subscriptions.push(
      vscode.lm.registerTool(
        "flightpath_inspectWorkspace",
        new WorkspaceInspectionTool()
      )
    );
  }
}

export class FileAnalysisTool
  implements vscode.LanguageModelTool<FileAnalysisParams>
{
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FileAnalysisParams>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { filePath, analysisType } = options.input;
    const fileContent = await vscode.workspace.fs.readFile(
      vscode.Uri.file(filePath)
    );

    // Perform analysis based on type
    const analysis = await this.analyzeFile(
      fileContent.toString(),
      analysisType
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(analysis)),
    ]);
  }
}
```

### Enhanced End Condition Configuration

```json
{
  "prompt": "Implement user authentication system",
  "endCondition": {
    "type": "ai-evaluation",
    "agent": "CodeQualityAgent",
    "expectedOutcome": "Complete authentication system with login, logout, and session management",
    "criteria": [
      "All authentication endpoints implemented",
      "Password hashing and validation working",
      "Session management functional",
      "Basic security measures in place"
    ],
    "confidence_threshold": 0.8,
    "fallback": {
      "type": "script",
      "script": "validate_auth_implementation.py"
    }
  }
}
```

</examples>

<success_criteria>

### Functional Requirements

- [ ] AI sub-agents can analyze Copilot Chat outputs with high accuracy (>80% correct decisions)
- [ ] End condition evaluation completes within reasonable time limits (< 10 seconds)
- [ ] Fallback to script-based evaluation when AI unavailable or uncertain
- [ ] Custom tools enhance sub-agent decision-making capabilities
- [ ] Multiple specialized agents work together effectively

### Technical Requirements

- [ ] Uses existing Copilot subscription without additional API costs
- [ ] Proper error handling and circuit breakers prevent workflow failures
- [ ] Tool calling works reliably with registered FlightPath tools
- [ ] Memory usage remains reasonable with conversation context
- [ ] TypeScript strict mode compliance with comprehensive interfaces

### User Experience Requirements

- [ ] Sub-agent decisions are explainable and debuggable
- [ ] Performance impact on workflows is minimal
- [ ] Clear indicators when AI vs script evaluation is used
- [ ] Workflow authors can configure AI evaluation preferences
- [ ] Graceful degradation maintains workflow functionality
      </success_criteria>

<instructions>
**Implementation Focus**: Create AI-powered sub-agents using vscode.lm API for intelligent workflow automation.

**Key Technical Approach**:

1. **LanguageModelService wrapper** - Clean interface over vscode.lm API
2. **BaseSubAgent architecture** - Extensible foundation for specialized agents
3. **Tool system integration** - Custom tools for enhanced AI decision-making
4. **Structured decision format** - Consistent JSON responses from all agents
5. **Fallback mechanisms** - Graceful degradation to script-based evaluation

**Primary Use Case - AI End Condition Evaluation**:

- Sub-agent receives Copilot Chat response text
- Analyzes response against expected outcomes and criteria
- Returns structured decision (continue/complete/retry/error) with confidence
- Provides reasoning for transparency and debugging
- Falls back to script evaluation on uncertainty or failure

**Future Extensions**:

- Code quality assessment agents
- Error analysis and resolution agents
- Multi-agent orchestration for complex decisions
- Learning and adaptation based on workflow outcomes

**Integration with Main FlightPath**:

- Complements (doesn't replace) enhanced Copilot Chat automation
- Plugs into existing EndConditionEvaluator architecture
- Maintains backward compatibility with script-based end conditions
- Uses same workflow configuration files with enhanced syntax

This sub-agent system will transform FlightPath from simple automation into intelligent workflow orchestration while preserving all existing functionality and user experience patterns.
</instructions>
