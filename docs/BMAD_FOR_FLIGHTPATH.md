# BMAD for FlightPath

This document outlines how FlightPath can leverage and customize the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) (BMM) for fully automated workflow execution.

## Overview

**Goal**: Create FlightPath prompt queue templates that automate BMAD workflows end-to-end, requiring only the initial user input (project description, feature request, etc.) and then running autonomously through all phases.

**Problem with Current BMAD**: While BMAD provides excellent structure, the interactive nature creates friction:

1. Chatmodes are stubs that require LLMs to manually load agent files
2. Workflows pause at every `template-output` for approval
3. Agents wait for menu selection before executing
4. Fresh chat requirements mean manual context switching

**FlightPath Solution**: Pre-built `.flightpath.json` templates that:

1. Embed full agent instructions (no stub loading failures)
2. Force YOLO mode by default (no approval pauses)
3. Chain workflow steps automatically across prompts
4. Handle fresh chat context naturally (each prompt = new session)

---

## BMAD Architecture Summary

### Core Components

| Component           | Location                                           | Purpose                                                 |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| **Agents**          | `.bmad/bmm/agents/*.md`                            | Personas with menus and workflow handlers               |
| **Workflows**       | `.bmad/bmm/workflows/*/workflow.yaml`              | Step-by-step process definitions                        |
| **Instructions**    | `.bmad/bmm/workflows/*/instructions.md`            | Detailed execution steps for each workflow              |
| **Workflow Engine** | `.bmad/core/tasks/workflow.xml`                    | Core OS for executing BMAD workflows                    |
| **Config**          | `.bmad/bmm/config.yaml`                            | Project-level settings (user_name, output_folder, etc.) |
| **Status Tracking** | `docs/bmad/bmm-workflow-status.yaml`               | Tracks phase/workflow completion                        |
| **Workflow Paths**  | `.bmad/bmm/workflows/workflow-status/paths/*.yaml` | Defines workflow sequence per track                     |

### Workflow Execution Model

```
Agent Activated
    ↓
Load config.yaml (step 2 of activation)
    ↓
Show menu, wait for user input
    ↓
User selects workflow (e.g., *prd)
    ↓
Agent loads workflow.xml (core engine)
    ↓
Engine loads workflow.yaml + instructions.md
    ↓
Execute steps, pause at template-output unless #yolo
    ↓
Save outputs, update status file
```

### Execution Mode

Stock BMAD's `workflow.xml` defines two execution modes:

- **normal**: Full user interaction at all decision points
- **#yolo**: Skip all confirmations and elicitation, produce all output automatically

**FlightPath BMAD removes this distinction entirely.** Autonomous execution is the only mode—no "YOLO" flag needed. The rewritten workflow engine assumes non-interactive execution by default.

---

## FlightPath BMAD Templates

### Template Design Principles

1. **Self-Contained Prompts**: Each prompt includes full agent persona, not just stub references
2. **Autonomous by Default**: No confirmation pauses, no elicitation prompts, no menu waits
3. **Sequential Execution**: Each prompt maps to one workflow step
4. **Fresh Context**: `newChatSession: true` (default) mimics BMAD's "fresh chat" requirement
5. **Status-Aware**: Prompts can check/update `bmm-workflow-status.yaml` via end conditions

### Track Templates

#### Quick Flow Brownfield Template

Based on `quick-flow-brownfield.yaml`:

| Phase  | Workflow              | Agent   | FlightPath Prompt          |
| ------ | --------------------- | ------- | -------------------------- |
| Prereq | document-project      | analyst | Prompt 1 (if undocumented) |
| 1      | tech-spec             | pm      | Prompt 2                   |
| 2      | sprint-planning       | sm      | Prompt 3                   |
| 3+     | dev-story (per story) | dev     | Prompts 4-N                |

```json
{
  "prompts": [
    {
      "id": "quick-flow-tech-spec",
      "prompt": "./prompts/bmad/quick-flow-tech-spec.prompt.md",
      "model": "claude-sonnet-4.5",
      "endCondition": {
        "script": "test -f docs/bmad/tech-spec.md && echo 'true' || echo 'false'",
        "returns": "true"
      }
    },
    {
      "id": "quick-flow-sprint-planning",
      "prompt": "./prompts/bmad/quick-flow-sprint-planning.prompt.md",
      "model": "claude-sonnet-4.5",
      "endCondition": {
        "script": "test -f docs/bmad/sprint-status.yaml && echo 'true' || echo 'false'",
        "returns": "true"
      }
    },
    {
      "id": "quick-flow-dev-story-1",
      "prompt": "./prompts/bmad/dev-story.prompt.md",
      "model": "claude-sonnet-4.5",
      "allowDynamicExtension": true
    }
  ]
}
```

#### BMad Method Brownfield Template

Based on `method-brownfield.yaml`:

| Phase  | Workflow                        | Agent     | FlightPath Prompt          |
| ------ | ------------------------------- | --------- | -------------------------- |
| Prereq | document-project                | analyst   | Prompt 0 (if undocumented) |
| 1      | prd                             | pm        | Prompt 1                   |
| 2      | create-architecture             | architect | Prompt 2                   |
| 2      | create-epics-and-stories        | pm        | Prompt 3                   |
| 2      | implementation-readiness        | architect | Prompt 4                   |
| 3      | sprint-planning                 | sm        | Prompt 5                   |
| 3+     | create-story → dev-story (loop) | sm/dev    | Prompts 6-N                |

---

## FlightPath-Optimized Agent Format

### Problem with Current Chatmodes

Current BMAD chatmodes are stubs like:

```markdown
# Dev Agent

<agent-activation CRITICAL="TRUE">
1. LOAD the FULL agent file from @.bmad/bmm/agents/dev.md
2. READ its entire contents...
</agent-activation>
```

**Issue**: LLMs frequently forget to load the referenced file, losing the full persona/menu/handlers.

### Solution: Inline Full Agent Content

For FlightPath, we create **self-contained prompt files** that embed the full agent definition:

```markdown
<!-- prompts/bmad/dev-story.prompt.md -->

<agent name="Amelia" title="Developer Agent" icon="💻">
  <persona>
    <role>Senior Software Engineer</role>
    <identity>Executes approved stories with strict adherence to acceptance criteria...</identity>
    <communication_style>Ultra-succinct. Speaks in file paths and AC IDs...</communication_style>
    <principles>The User Story combined with the Story Context XML is the single source of truth...</principles>
  </persona>
  
  <activation>
    1. Load config from .bmad/bmm/config.yaml
    2. Read the story file specified below
    3. Locate 'Dev Agent Record' → 'Context Reference' and read referenced files
    4. Execute dev-story workflow - complete all tasks and tests without pausing
  </activation>
</agent>

<workflow>
Execute the dev-story workflow from .bmad/bmm/workflows/4-implementation/dev-story/workflow.yaml
</workflow>

<context>
Story file: #file:docs/bmad/sprint-artifacts/stories/{{STORY_FILE}}
Sprint status: #file:docs/bmad/sprint-status.yaml
Architecture: #file:docs/bmad/architecture.md
</context>
```

### Key Differences from Stock BMAD

| Aspect         | Stock BMAD                           | FlightPath BMAD                   |
| -------------- | ------------------------------------ | --------------------------------- |
| Agent loading  | Stub → manual load                   | Full content embedded             |
| Execution mode | Interactive (default), YOLO (opt-in) | Autonomous only (no toggle)       |
| Menu system    | Show menu, wait for selection        | Direct workflow execution         |
| Confirmations  | Pause at template-output             | None—continue automatically       |
| Fresh chats    | User manually opens new chat         | `newChatSession: true` per prompt |
| Context files  | Agent must discover/load             | `#file:` references pre-attached  |

---

## Implementation Plan

### Phase 1: Core Templates

1. **Create prompt directory**: `prompts/bmad/`
2. **Create base agent prompts** (self-contained, autonomous):
   - `analyst.prompt.md`
   - `pm.prompt.md`
   - `architect.prompt.md`
   - `sm.prompt.md`
   - `dev.prompt.md`

3. **Create workflow templates**:
   - `quick-flow-brownfield.flightpath.json`
   - `method-brownfield.flightpath.json`

### Phase 2: End Conditions

Create validation scripts for each workflow step:

```javascript
// scripts/bmad/check-prd-complete.js
const fs = require("fs");
const yaml = require("js-yaml");

const status = yaml.load(fs.readFileSync("docs/bmad/bmm-workflow-status.yaml"));
const prdComplete =
  status.workflow_status?.prd &&
  !["required", "optional", "recommended"].includes(status.workflow_status.prd);

console.log(prdComplete ? "true" : "false");
```

### Phase 3: Dynamic Queue Extension

Leverage FlightPath's dynamic queue feature to:

1. Read `sprint-status.yaml` to discover pending stories
2. Dynamically add `dev-story` prompts for each story
3. Chain `code-review` prompts after each implementation

---

## Distribution Options

### Option A: Internal to FlightPath Repo

```
prompts/
  bmad/
    agents/
      analyst-yolo.prompt.md
      pm-yolo.prompt.md
      ...
    workflows/
      tech-spec.prompt.md
      prd.prompt.md
      create-architecture.prompt.md
      ...
    templates/
      quick-flow-brownfield.flightpath.json
      method-brownfield.flightpath.json
scripts/
  bmad/
    check-prd-complete.js
    check-tech-spec-complete.js
    ...
```

**Pros**: Self-contained, easy to maintain, no external dependencies
**Cons**: Duplicates BMAD content, manual updates needed

### Option B: Fork BMAD-METHOD

Create `FlightPath-BMAD` fork with:

1. Modified agents (autonomous by default, no menu waits)
2. Simplified workflow engine (remove YOLO/normal mode distinction)
3. FlightPath-compatible workflow structure
4. Pre-built `.flightpath.json` templates

**Pros**: Full BMAD ecosystem, community updates
**Cons**: Fork maintenance overhead

### Option C: BMAD Integration Module

Propose to BMAD-METHOD upstream:

- New `flightpath/` module alongside `bmm/`
- CLI command: `npx bmad-method install --module=flightpath`
- Generates FlightPath templates from existing workflows

**Pros**: Official integration, community benefit
**Cons**: Requires upstream buy-in

---

## Template Variables

FlightPath templates can use these variable patterns:

| Variable                  | Source                         | Example                             |
| ------------------------- | ------------------------------ | ----------------------------------- |
| `{{PROJECT_NAME}}`        | User input or config.yaml      | "FlightPath"                        |
| `{{FEATURE_DESCRIPTION}}` | User input (first prompt)      | "Add retry logic to end conditions" |
| `{{STORY_FILE}}`          | Parsed from sprint-status.yaml | "story-epic1-1.md"                  |
| `{{EPIC_NUM}}`            | Current epic number            | "1"                                 |
| `{{STORY_NUM}}`           | Current story number           | "1"                                 |

These are resolved at runtime by FlightPath before sending to Copilot.

---

## Example: Quick Flow Automation

### User Experience

1. User creates feature description file:

   ```markdown
   <!-- feature-request.md -->

   Add retry logic to end condition validation with configurable max retries.
   ```

2. User runs: `FlightPath: Take Off` → selects `bmad-quick-flow.flightpath.json`

3. FlightPath executes:
   - **Prompt 1**: PM agent creates tech-spec
   - **End condition**: Verify `tech-spec.md` exists
   - **Prompt 2**: SM agent creates sprint plan
   - **End condition**: Verify `sprint-status.yaml` exists
   - **Prompt 3**: DEV agent implements story 1
   - **Dynamic extension**: Queue adds story 2, 3, ... based on sprint-status.yaml

4. User reviews completed implementation

### Total User Interaction

- **Before**: ~20+ manual interactions (menu selections, approvals, fresh chats)
- **After**: 1 interaction (select template and start)

---

## Open Questions

1. **Variable injection**: How should user input (feature description) flow through the template?
   - Option A: First prompt captures it, saves to file, subsequent prompts reference
   - Option B: Template has `{{FEATURE_DESCRIPTION}}` placeholder, FlightPath prompts at start

2. **Failure handling**: What if a workflow step fails validation?
   - Use `maxRetries` with `retryPrompt` including error context
   - Or: Stop queue, require manual intervention

3. **Story iteration**: How to dynamically add dev-story prompts?
   - Use `allowDynamicExtension: true` on final prompt
   - Copilot reads sprint-status.yaml and modifies .flightpath.json

4. **BMAD version sync**: How to track upstream BMAD changes?
   - Option A: Pin to specific BMAD version, manual updates
   - Option B: Script to diff and merge upstream changes

---

## Related Documentation

- [FlightPath Dynamic Queue](./DYNAMIC_QUEUE_USAGE.md) - Queue extension during execution
- [BMAD Quick Start](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/src/modules/bmm/docs/quick-start.md)
- [BMAD Scale Adaptive System](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/src/modules/bmm/docs/scale-adaptive-system.md)

---

## Appendix: BMAD Workflow Paths Reference

### Quick Flow Brownfield (`quick-flow-brownfield.yaml`)

```yaml
phases:
  - prerequisite: document-project (if undocumented)
  - phase 0: Discovery (optional)
      - brainstorm-project (optional)
      - research (optional)
  - phase 1: Planning
      - tech-spec (required) ← PM agent
  - phase 2:
      Implementation
      - sprint-planning (required) ← SM agent
      # Then: dev-story loop
```

### BMad Method Brownfield (`method-brownfield.yaml`)

```yaml
phases:
  - prerequisite: document-project (if undocumented)
  - phase 0: Discovery (optional)
      - brainstorm-project, research, product-brief
  - phase 1: Planning
      - prd (required) ← PM agent
      - validate-prd (optional)
      - create-design (if UI) ← UX agent
  - phase 2: Solutioning
      - create-architecture (recommended) ← Architect
      - create-epics-and-stories (required) ← PM agent
      - test-design (recommended) ← TEA agent
      - validate-architecture (optional)
      - implementation-readiness (required) ← Architect
  - phase 3:
      Implementation
      - sprint-planning (required) ← SM agent
      # Then: create-story → dev-story → code-review loop
```
