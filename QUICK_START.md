# FlightPath - Quick Start Guide

## 🚀 Getting Started in 5 Minutes

### Step 1: Check Your Setup

Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and run:
```
FlightPath: Show Copilot Integration Status
```

You should see one of:
- ✅ **Zero-interaction automation available** - Best case! Full automation enabled
- ✅ **Automated workflow available** - Good! Minor interaction may be needed
- ⚠️ **Semi-automated** - Prompts copied, manual paste required
- ❌ **No automation available** - Check Copilot Chat installation

### Step 2: Test Automation (Optional but Recommended)

```
FlightPath: Test Automation
```

This sends a test message to Copilot Chat. If you see the message appear automatically, you're ready to go!

### Step 3: Create Your First Workflow

**Option A: Use Example File**
1. Navigate to `.flightpath/examples/` folder
2. Open `zero-interaction-demo.flightpath.json`
3. Run: `FlightPath: Take Off`
4. Select the demo file
5. Click "Take Off"
6. Watch prompts execute automatically! 🎉

**Option B: Create New File**
1. Run: `FlightPath: Create Prompt File`
2. Name it: `my-workflow.flightpath.json`
3. Add your prompts (see examples below)
4. Run: `FlightPath: Take Off`

### Step 4: Watch the Magic

When you click "Take Off":
- FlightPath opens Copilot Chat
- Types your prompts automatically
- Submits them one by one
- No manual intervention needed! ✨

---

## 📝 Workflow File Examples

### Simple Single Prompt

Create: `analyze-code.prompt.json`
```json
{
  "prompt": "Analyze this code for potential improvements",
  "context": {
    "includeCurrentFile": true
  }
}
```

### Multi-Step Workflow

Create: `refactor-workflow.flightpath.json`
```json
{
  "prompts": [
    {
      "prompt": "Identify code smells in this file",
      "context": {
        "includeCurrentFile": true
      }
    },
    {
      "prompt": "Suggest refactoring strategies"
    },
    {
      "prompt": "Show an example of the improved code"
    }
  ]
}
```

### Context-Aware Analysis

```json
{
  "prompts": [
    {
      "prompt": "Analyze the architecture of this project",
      "context": {
        "includeWorkspaceFiles": ["src/**/*.ts"]
      }
    },
    {
      "prompt": "What SOLID principles are being followed?",
      "context": {
        "includeWorkspaceFiles": ["src/flightpath/*.ts"]
      }
    }
  ]
}
```

---

## 🎯 Pro Tips

### 1. Use Copilot Chat Syntax

FlightPath automatically formats prompts with:
- `@workspace` - For workspace-wide context
- `#file:path` - For specific file references
- `/fix` - Auto-detected for fix prompts
- `/explain` - Auto-detected for explanations

Example: Your prompt "Fix the error" becomes → `/fix #file:yourfile.ts Fix the error`

### 2. Smart Context Inclusion

```json
{
  "context": {
    "includeCurrentFile": true,        // Current editor file
    "includeSelection": true,           // Selected text
    "includeWorkspaceFiles": [          // Specific files
      "src/**/*.ts",
      "package.json"
    ]
  }
}
```

### 3. Workflow Patterns

**Analysis → Suggestion → Implementation**
```json
{
  "prompts": [
    { "prompt": "Analyze current code" },
    { "prompt": "Suggest improvements" },
    { "prompt": "Show example implementation" }
  ]
}
```

**Incremental Refinement**
```json
{
  "prompts": [
    { "prompt": "Create a function to handle user input" },
    { "prompt": "Add error handling to the previous function" },
    { "prompt": "Add input validation and sanitization" }
  ]
}
```

---

## 🛠️ Troubleshooting

### Prompts Not Sending?

1. **Check Copilot Chat is open**: Look for the chat panel
2. **Check automation status**: Run `FlightPath: Show Copilot Integration Status`
3. **Test automation**: Run `FlightPath: Test Automation`
4. **Check console**: View → Output → FlightPath

### Automation Strategy Fallback?

If you see "Manual paste required":
1. FlightPath copies prompts to clipboard automatically
2. Click in Copilot Chat input
3. Press `Ctrl+V` (or `Cmd+V`)
4. Press `Enter`
5. FlightPath continues to next prompt

### Workflow Stuck?

- **Pause**: `FlightPath: Pause Execution`
- **Resume**: `FlightPath: Resume Execution`
- **Stop**: `FlightPath: Stop Execution`

---

## 📚 Where to Store Files

FlightPath looks for prompt files in:
```
your-workspace/
  .flightpath/          ← Recommended location
    *.prompt.json       ← Single prompts
    *.flightpath.json   ← Multi-prompt workflows
```

You can also store them anywhere in your workspace!

---

## 🎓 Learning Resources

- **Full Documentation**: See `COPILOT_INTEGRATION.md`
- **Implementation Details**: See `IMPLEMENTATION_SUMMARY.md`
- **Example Files**: Check `.flightpath/examples/`
- **Schema Files**: See `schemas/` for JSON validation

---

## 🆘 Common Commands

| Command | What It Does |
|---------|-------------|
| `FlightPath: Take Off` | Start a workflow |
| `FlightPath: Show Copilot Integration Status` | Check automation status |
| `FlightPath: Test Automation` | Test if automation works |
| `FlightPath: Create Prompt File` | Create new workflow file |
| `FlightPath: Pause Execution` | Pause current workflow |
| `FlightPath: Resume Execution` | Resume paused workflow |
| `FlightPath: Stop Execution` | Stop and reset workflow |

---

## 💡 Next Steps

1. ✅ Test automation with demo file
2. ✅ Create your first custom workflow
3. ✅ Experiment with context options
4. ✅ Try multi-step workflows
5. ✅ Share your workflows with team

---

**Happy Automating! 🚀**

*FlightPath - Automate GitHub Copilot with structured prompt workflows*
