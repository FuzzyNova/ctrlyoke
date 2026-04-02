# Workflow-Level Additional Instructions Plan

Add `additionalInstructions` as a new three-tier execution property that injects a custom instruction block into every prompt in a workflow — without requiring a custom agent file.

---

## Background

FlightPath workflows often need a small number of cross-cutting behavioral rules that apply to every step. The current options are:

- **Agent file** (`.agent.md`) — full-featured, but heavyweight. Requires creating a file on disk, referencing it in every workflow, and maintaining it separately. For a single instruction like "respond in British English" it's overkill.
- **Repeating the instruction in every prompt** — violates DRY and makes workflows hard to maintain.
- **Harness-level agent settings** — applies globally, not per-workflow.

`additionalInstructions` fills the gap: a plain string, defined at the workflow level (or global settings), injected into every prompt automatically. Prompt-level override allows specific prompts (e.g., a final gate) to suppress the instructions with `null`.

### Compelling Use Cases

- **Perpetual workflows:** `"Before ending your turn, always append a new prompt to the FlightPath queue using the flightpath MCP server."` Combined with `mcpServers: [flightpath]`, this creates self-extending workflows without hardcoding the instruction in every step.
- **Language/tone:** `"Always respond in British English."`
- **Scope constraints:** `"You are working in a monorepo. Never touch files outside the packages/api/ directory."`
- **Project-specific rules:** Injecting house-style conventions without a full agent file.
- **Suppression on final prompt:** A summary or gate prompt that uses `additionalInstructions: null` to avoid polluting its output with workflow instructions.

This is not a replacement for agent files — it is a simpler, inline alternative for lightweight cross-cutting rules.

---

## Field Design

**Field name:** `additionalInstructions`

**Type:** `string | null | undefined`

Three-state semantics follow the `additionalArgs` pattern exactly:

| Value       | Meaning                                                               |
| ----------- | --------------------------------------------------------------------- |
| `undefined` | Inherit from the next tier (workflow, then global settings)           |
| `null`      | Explicitly suppress — do not inject instructions for this prompt/workflow |
| `string`    | Use this instruction text (overrides lower tiers)                     |

**Three-tier precedence:**

1. Prompt-level `additionalInstructions` (highest — `null` here suppresses all instructions for this prompt)
2. Workflow-level `additionalInstructions`
3. Global VS Code setting `flightpath.additionalInstructions`

**Empty string handling:** Treat `""` the same as `undefined` — fall through to the next tier. A blank string is never injected.

**Prompt-level `null` use case:** A workflow may set instructions for all steps, but the final validation gate should return clean JSON with no extra verbiage. That step can use `additionalInstructions: null` to suppress the injection.

---

## Schema Changes

File: `schemas/prompt-schema.json`

Add the field to the `executionProperties` definition (shared by workflow root and per-prompt items via `$ref`):

```json
"additionalInstructions": {
  "oneOf": [{ "type": "string" }, { "type": "null" }],
  "description": "Custom instruction text injected into every prompt in this workflow, wrapped in <additionalInstructions> XML tags. Use null at prompt level to explicitly suppress workflow-level or global additional instructions for a specific prompt. Omit to inherit from the workflow, then from global settings."
}
```

Because `executionProperties` is referenced by both the workflow root properties and the `promptItem` definition via `allOf`, adding it to `executionProperties` covers both tiers in a single change. No separate per-prompt addition needed.

After editing `schemas/prompt-schema.json`, run `npm run generate-schema` to regenerate the YAML schema.

---

## Type Changes

File: `src/types/FlightPathTypes.ts`

Add to the `ExecutionProperties` interface alongside `additionalArgs`:

```typescript
/**
 * Custom instruction text injected into each prompt, wrapped in <additionalInstructions> XML tags.
 *
 * Follows three-tier precedence: prompt > workflow > global VS Code settings.
 * - string: Inject this text
 * - null: Explicitly suppress — do not inject instructions for this prompt
 * - undefined: Inherit from workflow, then settings
 *
 * Empty string is treated as undefined (falls through).
 *
 * Use case: lightweight cross-cutting rules without a full agent file.
 * Use null on specific prompts (e.g., a final gate) to suppress the injection.
 */
additionalInstructions?: string | null;
```

No other type files need changes. `PromptFile` extends `ExecutionProperties`, so it inherits the field at the workflow level automatically. `PromptItem` also extends (or includes) `ExecutionProperties` via the schema's `allOf` approach, and its runtime type should similarly inherit the field.

---

## PropertyResolver

File: `src/utils/PropertyResolver.ts`

Add `additionalInstructions?: string` to the `ResolvedProperties` interface (the output type holds a resolved, non-null value or `undefined`).

Add a `resolveAdditionalInstructions` private static method following the exact same pattern as `resolveAdditionalArgs`:

```typescript
private static resolveAdditionalInstructions(
  prompt: PromptItem,
  workflow: PromptFile
): string | undefined {
  // 1. Prompt-level override (highest priority)
  if (prompt.additionalInstructions !== undefined) {
    if (prompt.additionalInstructions === null || prompt.additionalInstructions === "") {
      return undefined; // null = explicit suppress
    }
    return prompt.additionalInstructions;
  }

  // 2. Workflow-level default
  if (workflow.additionalInstructions !== undefined) {
    if (workflow.additionalInstructions === null || workflow.additionalInstructions === "") {
      return undefined;
    }
    return workflow.additionalInstructions;
  }

  // 3. VS Code setting fallback
  const globalInstructions = ConfigurationUtils.getAdditionalInstructions();
  return globalInstructions || undefined;
}
```

Call it in the main `resolve()` method alongside the other field resolutions:

```typescript
additionalInstructions: this.resolveAdditionalInstructions(prompt, workflow),
```

---

## Injection in CliPromptPreparer

File: `src/flightpath/harness/shared/CliPromptPreparer.ts`

### Where it fits in the assembly order

Current assembly order (conceptual):
1. `<agentInstructions>` block
2. Skill content
3. `<priorContext>` block (if configured)
4. Excerpt refs
5. User prompt text

`additionalInstructions` belongs **after agent instructions, before the user prompt** — it is a behavioral overlay, not a data reference. Suggested position: after agent/skill content, before prior context (or if prior context is removed, directly before the user prompt).

### Implementation

`resolvedProperties.additionalInstructions` flows into `preparePrompt()` which already receives `resolvedProperties`. The injected XML wrapping:

```
<additionalInstructions>
{content}
</additionalInstructions>
```

In `createCategorizedPromptFiles`, add an `instructionsRefs` array alongside `agentRefs`, `skillRefs`, etc. When `additionalInstructions` is present, write it to a categorized temp file using category `"instructions"` and format it as a reference. Pass `instructionsRefs` into `formatCategorizedReferences`.

Update `formatCategorizedReferences` (and its callers in individual CLI providers) to accept and position the new `instructionsRefs` parameter.

For the `hasExtras` check, add:

```typescript
const hasAdditionalInstructions = !!resolvedProperties?.additionalInstructions;

const hasExtras =
  !!sections.agentContent ||
  !!sections.skillContent ||
  sections.directFileRefs.length > 0 ||
  !!sections.excerptContent ||
  hasPriorContext ||
  hasAdditionalInstructions;
```

For the simple inline path (no temp files), prepend the XML block directly to the prompt text when not using categorized files.

---

## Settings / ConfigurationUtils

### `package.json`

Add to `contributes.configuration.properties`:

```json
"flightpath.additionalInstructions": {
  "type": "string",
  "default": "",
  "markdownDescription": "Default instruction text injected into every prompt across all workflows, wrapped in `<additionalInstructions>` XML tags. Override or suppress per-workflow or per-prompt using the `additionalInstructions` YAML field. Leave blank to disable."
}
```

A single global setting (not harness-specific) is appropriate here because additional instructions are content, not CLI behavior — they apply equally to all harnesses including `copilot-chat`.

### `ConfigurationUtils.ts`

Add alongside `getPriorContext()` and `getAdditionalArgs()`:

```typescript
/**
 * Get the global additional instructions text (fallback for three-tier resolution).
 * Prompt-level and workflow-level additionalInstructions take precedence via PropertyResolver.
 */
getAdditionalInstructions(): string {
  return getConfig().get<string>("additionalInstructions", "");
},
```

---

## UI: Context Tab in SettingsDrawer

File: `src/ui/webview-react/components/layout/SettingsDrawer.tsx`

The `DRAWER_PAGES.CONTEXT` section already exists and currently holds Resume Session, Session
ID, and Prior Context. Do NOT create a new tab — `additionalInstructions` is added to the
existing Context tab. The book icon already on the tab is appropriate; additional instructions
are a form of workflow context.

Add the `additionalInstructions` editor at the **bottom of the existing Context tab content**,
after the Prior Context field, separated by a visual `<hr>` divider. This keeps the existing
fields intact and adds the new editor in the empty space below them (the tab currently feels
sparse — this fills it).

### Layout

Add after the existing Prior Context `FormField`:

```tsx
{/* Visual separator before additional instructions */}
<hr className="border-panel-border my-2" />

<FormField
  label="Additional Instructions"
  htmlFor="settings-additional-instructions"
  description="Instructions injected into every prompt in this workflow. Set to empty to inherit the global default."
  setAsDefaultButton={
    <SetAsDefaultButton
      property="additionalInstructions"
      show={isDifferentFromGlobal("additionalInstructions")}
      onSetDefault={() =>
        handleSetAsDefault(
          "additionalInstructions",
          workflowProperties.additionalInstructions
        )
      }
    />
  }
>
  <textarea
    id="settings-additional-instructions"
    value={workflowProperties.additionalInstructions ?? ""}
    onChange={(e) =>
      handlePropertyChange("additionalInstructions", e.target.value || undefined)
    }
    rows={6}
    placeholder={
      globalSettings.additionalInstructions
        ? `Default: ${globalSettings.additionalInstructions}`
        : "Instructions injected into every prompt in this workflow..."
    }
    className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-none"
  />
  <p className="text-[10px] text-description-fg opacity-70 mt-1">
    Wrapped in <code>&lt;additionalInstructions&gt;</code> tags. Individual prompts can
    suppress with <code>additionalInstructions: null</code> in the YAML.
  </p>
</FormField>
```

**Style guide:** Match the `retryPrompt` textarea in the Validation tab (lines ~1166–1180 in `SettingsDrawer.tsx`): `rows={3}` for retryPrompt vs. `rows={6}` here to give more room for multi-sentence instructions.

**`isDifferentFromGlobal`:** The existing helper compares against `globalSettings[property]`. No new logic needed — just pass `"additionalInstructions"` as the property key (same pattern as all other fields).

**Clearing:** When the textarea is cleared (empty string), the `onChange` handler should set the value to `undefined` (not `""`), so that the field falls through to the global default. See the `null` vs `undefined` distinction: empty textarea = `undefined` (inherit), not `null` (suppress). The `null` suppress case is YAML-only — it cannot be set from the UI.

### Webview Store

The workflow properties store will need `additionalInstructions` added to:
- The properties type/interface used by the settings store
- The `updateWorkflowProperty` message handler if `additionalInstructions` isn't already covered by the generic property update path

Check `src/ui/webview-react/stores/` for the settings store — it likely uses a generic `WorkflowProperties` shape from the shared types. If it does, the field inherits automatically once added to `ExecutionProperties`.

---

## CopilotChatIntegration

File: `src/flightpath/harness/chat/CopilotChatIntegration.ts`

The chat harness builds typed temp files and attaches them to the VS Code chat panel. Follow the existing pattern for the `.context.prompt.md` category file:

Add a new category `"instructions"` written to a `.instructions.prompt.md` temp file, analogous to `.context.prompt.md` for prior context. The file content is:

```
<additionalInstructions>
{resolvedProperties.additionalInstructions}
</additionalInstructions>
```

Add an `instructionsFileNames` array in `buildAndAttachCategorizedFiles`, write the file alongside the agent/skill/context files (after agent, before context), attach it via the VS Code command, and include it in the formatted instruction string returned to the caller.

This keeps the chat harness consistent with the CLI harness — the same XML wrapping, the same visual category in temp file names.

---

## Open Questions / Notes

**Empty string vs null suppression**
Decided: empty string = `undefined` (fall through). `null` is explicit suppress (YAML-only). The UI cannot set `null` — it can only clear (which becomes `undefined`/inherit). This is consistent with `additionalArgs`.

**Prompt editor preview**
The prompt editor (CodeMirror in `PromptEditor.tsx`) shows the prompt text only. `additionalInstructions` is metadata, not part of the prompt text — it should not appear in the editor preview. However, the properties drawer (Context tab) is the right place to surface it, which is already the plan.

**Character limit**
No enforced limit. The injected XML goes through the same temp file splitting path as agent content (`PromptFileSplitter`), so extremely long instructions are handled automatically. No special casing needed.

**Context tab coexistence**
The inline `$` prior context plan is additive — it does not remove Resume Session or Prior
Context from the Context tab. All three sections (Resume Session, Prior Context,
Additional Instructions) will coexist on the tab. The `<hr>` divider before Additional
Instructions provides a clear visual break between the existing context selectors and the
new free-form instructions editor.

**Variable substitution**
`additionalInstructions` content should support `{{varName}}` substitution consistent with `additionalArgs` and prompt text. The substitution pass in `VariableSubstitutor` (or wherever vars are applied) should include this field. Check `WorkflowExecutor` or `PropertyResolver` for where `vars` substitution happens on `additionalArgs` — apply the same treatment to `additionalInstructions`.

**Headless CLI support**
No `--additional-instructions` CLI flag is needed. The value flows from the YAML/JSON workflow file through the same three-tier resolution path as all other properties. The global setting fallback is VS Code only — headless CLI users set it at workflow level.

**PropertiesDrawer (per-prompt editor)**
`src/ui/webview-react/components/editor/PropertiesDrawer.tsx` is the per-prompt property editor. It should also expose `additionalInstructions` in its Context tab (if it has one). Check whether PropertiesDrawer shares the same tab structure as SettingsDrawer — if so, apply the same textarea there.
