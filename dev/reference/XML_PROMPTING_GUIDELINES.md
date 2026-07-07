# XML Prompting Guidelines for FlightPath

## Overview

FlightPath uses XML tags to structure prompts sent to GitHub Copilot (which is powered by Claude). This document explains why XML is preferred and how to use it effectively in this project.

## 🎉 Hidden Feature: Invisible Automation Instructions

**Discovery**: Copilot Chat UI hides XML tags from the chat view but still processes them correctly!

This means:

- ✅ FlightPath's `<criticalInstruction>` tag is completely hidden from users
- ✅ Chat history stays clean and readable
- ✅ Copilot still follows the automation instructions perfectly
- ✅ Users see only their actual prompts, not our internal automation logic

This is a **perfect** solution for embedding automation directives without cluttering the UI!

**Note**: The `<criticalInstruction>` tag is used for Dynamic Queue Extension instructions when enabled. It informs Copilot about the MCP tools available (`flightpath_queue_status`, `flightpath_append_queue`) for extending workflows. Completion detection for Chat mode is handled via VS Code chat session file monitoring (`ChatSessionMonitor.ts`).

## Why XML?

Based on Anthropic's official recommendations and extensive testing, XML tags provide:

1. **Semantic Clarity**: XML tags clearly define the purpose of each section
2. **Improved Accuracy**: Reduces misinterpretation by the AI
3. **Better Parseability**: Easier to extract and process structured responses
4. **Consistency**: Standardized approach across all prompts
5. **Nested Structure**: Hierarchical organization for complex instructions
6. **Hidden in UI**: Certain XML tags (like automation directives) are hidden from chat view while still being processed

**Source**: [Anthropic's XML Prompting Documentation](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags)

## FlightPath's XML Structure

### Outgoing Prompts (Sent to Copilot)

Every prompt sent to Copilot follows this structure:

```
[User's prompt text with context variables like @path/to/file, #file:path, slash commands, etc.]
```

For prompts with Dynamic Queue Extension enabled:

```
[User's prompt text]

<criticalInstruction>
You are executing prompt X of Y in a FlightPath workflow.

DYNAMIC QUEUE EXTENSION:
If you need additional steps to complete this task, you can extend the workflow...
[Instructions for extending the workflow by modifying the prompt file]
</criticalInstruction>
```

**Key Discovery**: Copilot Chat UI hides XML tags in the chat view but still processes them correctly!

- User prompt is sent as plain text → Visible in chat history
- Dynamic queue instructions wrapped in `<criticalInstruction>` XML tag → Hidden from chat UI but processed by Copilot
- This gives us clean chat history while maintaining automation functionality

**Completion Detection**: FlightPath uses **VS Code chat session file monitoring** for Chat mode. The extension monitors VS Code's internal `chatSessions/*.json` files for response-complete markers to detect when Copilot has finished responding. This replaced the earlier log-file approach for improved reliability.

**Implementation**: See `ChatSessionMonitor.ts` (used by `CopilotChatIntegration.ts`)

### Why User Prompts Aren't Wrapped in XML

Originally, we wrapped user prompts in `<request>` tags, but discovered that Copilot hides ALL XML tags from the chat view. This meant:

- ❌ User prompts wrapped in `<request>` disappeared from chat history (confusing!)
- ✅ Tool instructions wrapped in `<criticalInstruction>` hide perfectly (clean chat!)

So we only wrap FlightPath's automation instructions in XML, keeping user prompts as plain text.

### Incoming Prompts (User Requests to You)

You are currently reading prompts wrapped in `<userRequest>` tags. When you see this structure, understand that:

- The `<userRequest>` contains the actual user instruction
- Any `<criticalInstruction>` is a FlightPath automation directive (always follow it!)

## XML Best Practices for This Project

### 1. Be Consistent

Use the same tag names throughout. Don't mix `<instruction>` and `<instructions>` randomly.

✅ Good:

```xml
<context>Background info</context>
<task>Main task</task>
```

❌ Bad:

```xml
<context>Background info</context>
<task_description>Main task</task_description>
```

### 2. Use Descriptive Tag Names

Tag names should clearly indicate their content.

✅ Good:

```xml
<technicalStack>
- TypeScript 5.x
- Node.js 22.17.0
</technicalStack>
```

❌ Bad:

```xml
<info>
- TypeScript 5.x
- Node.js 22.17.0
</info>
```

### 3. Nest Tags When Appropriate

Use hierarchical structure for related content.

✅ Good:

```xml
<architecturePrinciples>
  <promptFormat>
    Final-form storage with no runtime injection
  </promptFormat>
  <solidPrinciples>
    Single responsibility per component
  </solidPrinciples>
</architecturePrinciples>
```

### 4. Always Close Tags

Self-explanatory but critical.

✅ Good:

```xml
<task>Fix the bug</task>
```

❌ Bad:

```xml
<task>Fix the bug
```

### 5. Combine with Other Techniques

XML works great with:

- **Examples**: Use `<examples>` with nested `<example>` tags
- **Chain of Thought**: Use `<thinking>` and `<answer>` tags
- **Requirements**: Use `<requirements>` with nested `<item>` tags

## Common XML Tags in FlightPath

### Documentation Tags (copilot-instructions.md)

- `<projectPurpose>` - High-level project description
- `<technicalStack>` - Tech stack list
- `<architecturePrinciples>` - Architectural decisions
- `<promptFormat>` - Prompt formatting rules
- `<solidPrinciples>` - SOLID principles application
- `<codeQuality>` - Quality standards
- `<coreComponents>` - Component descriptions

### Prompt Tags (sent to Copilot)

- `<criticalInstruction>` - FlightPath automation directive (hidden in chat UI)
- User prompts are NOT wrapped in XML (kept as plain text for chat visibility)

**Note**: Users can add their own XML structure in prompts if they want (e.g., `<context>`, `<requirements>`), but FlightPath doesn't wrap them automatically.

### Response Tags (when asking Copilot to structure output)

- `<thinking>` - Reasoning process
- `<answer>` - Final answer
- `<code>` - Code blocks
- `<explanation>` - Code explanations
- `<analysis>` - Analysis sections

## Examples

### Simple Task Prompt

```
/fix #file:src/extension.ts Fix the activation error
```

**What user sees in chat**: `/fix #file:src/extension.ts Fix the activation error`
**How completion is detected**: VS Code chat session file monitoring via `ChatSessionMonitor.ts`

### Complex Prompt with User-Defined XML Structure

Users can add their own XML tags within their prompts if they want:

```
<task>
Refactor the CopilotIntegration class to improve error handling
</task>

<context>
The current implementation catches errors but doesn't provide detailed user feedback. We need better error messages and retry logic.
</context>

<requirements>
- Add specific error types for different failure modes
- Implement exponential backoff for retries
- Log all errors to console with timestamps
- Show user-friendly messages in VS Code notifications
</requirements>

<constraints>
- Must maintain backward compatibility with existing workflows
- Keep response detection mechanism unchanged
- Follow SOLID principles
</constraints>
```

**What user sees in chat**: All the XML tags (task, context, requirements, constraints) are visible! Only FlightPath's internal `<criticalInstruction>` tags are hidden.

**Why?** Copilot only hides XML tags it recognizes as automation directives. User-defined tags in the prompt text are displayed normally.

### Asking for Structured Output

When you want Copilot to provide structured responses:

```
Analyze the current error handling strategy in FlightPathManager.

Please structure your response as:
<analysis>
  <current_approach>...</current_approach>
  <strengths>...</strengths>
  <weaknesses>...</weaknesses>
  <recommendations>...</recommendations>
</analysis>
```

## When NOT to Use XML

- **User-facing messages**: VS Code notifications, status bar text, error messages shown to users should remain plain strings
- **Console logs**: Keep logs simple and readable (unless logging structured data)
- **File names and paths**: Never wrap file paths in XML tags
- **JSON files**: Prompt files (`.flightpath.yaml`, `.flightpath.json`) remain valid JSON - users can put XML in the prompt string value if they want, but the file structure is JSON

## Migrating Existing Prompts

If you find prompts without XML structure:

1. **Don't break them**: Old-style prompts still work
2. **Wrap when updating**: If you're editing a prompt, consider adding XML structure for complex instructions
3. **Keep user prompts plain text**: Only FlightPath's internal automation uses `<criticalInstruction>` tags - user prompts remain plain text for chat visibility

## Testing XML Prompts

To verify XML structure works:

1. Check console logs in VS Code Output panel (FlightPath channel)
2. Look for log messages showing the prompt being sent
3. Verify the full prompt shows proper XML tags when dynamic queue is enabled
4. For Chat mode, completion is detected via session file monitoring (`ChatSessionMonitor.ts`)

## References

- [Anthropic: Use XML Tags](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags)
- [Anthropic: Prompt Engineering](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview)
- [XML Tags vs Other Dividers](https://beginswithai.com/xml-tags-vs-other-dividers-in-prompt-quality/)

## Questions?

If you're unsure whether to use XML for a specific prompt, default to YES. The benefits outweigh the minor verbosity cost.
