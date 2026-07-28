# Prompt Authoring Suggestions Plan

**Status:** Proposed  
**Priority:** P2 — prompt-authoring differentiation  
**Supersedes:** `INLINE_SUGGESTIONS_PLAN.md`

## Product fit

ctrlyoke's CodeMirror prompt editor is a first-class product surface, not a
generic code editor. It already provides structural reference completions,
reference validation, prior-context tokens, spellcheck, and workflow-aware
authoring behavior. Model-assisted prompt continuation belongs in that boundary
when it helps users express a workflow step more clearly or quickly.

This plan does not add source-code completions. It adds optional suggestions for
the prompt being authored in ctrlyoke.

## Product decision

Ship prompt suggestions in two stages:

1. **Manual suggestion first.** The user explicitly requests a continuation at
   the cursor. It appears as ghost text and can be accepted or dismissed.
2. **Automatic suggestions later.** After quality, latency, and request behavior
   are understood, users may opt into debounced suggestions while typing.

The feature must be provider-neutral. VS Code's Language Model API is the first
provider adapter, not the service contract. The hosted dashboard can use that
adapter while connected to the extension. Standalone mode reports the feature
as unavailable until it has its own configured provider adapter.

Automatic suggestions default to off.

## Goals

- Help users continue or sharpen AI-coding prompts without leaving the workflow
  editor.
- Preserve normal typing, Tab behavior, structural completions, undo, and
  accessibility.
- Cancel stale work immediately and never insert a suggestion after the prompt
  has changed.
- Make model access, draft transmission, and unavailability visible rather than
  silently pretending the feature is local.
- Keep model selection and transport outside `CodeMirrorEditor.tsx`.

## Non-goals

- Source-code completion or inline code generation.
- Replacing `@`, `#`, `~`, `$`, or future `/skill:` structural completions.
- Automatically rewriting the user's full prompt in the first release.
- Making suggestions a dependency for editing or running workflows.
- Guaranteeing identical model availability in extension, hosted, and
  standalone modes.
- Persisting suggestion requests or rejected suggestion text in run history.

## User experience

### Phase 1 — Request a continuation

Provide a `Suggest continuation` action:

- accessible from the prompt editor toolbar/footer;
- available through a keyboard command that does not conflict with CodeMirror
  autocomplete;
- disabled with a short explanation when no suggestion provider is available.

When invoked:

1. ctrlyoke captures the prompt revision and cursor position.
2. The editor shows a lightweight pending indicator without becoming read-only.
3. A short continuation appears as ghost text at the cursor.
4. `Tab` accepts it only when no structural completion menu owns Tab.
5. `Escape`, continued typing, moving the cursor, changing steps, or closing the
   editor dismisses it.
6. Acceptance is one undoable editor transaction.

Do not insert model output automatically.

### Phase 2 — Opt-in automatic suggestions

Add an experimental setting that requests a continuation after the user pauses:

- default: off;
- configurable debounce within a conservative range;
- no request for empty/very short prompts, read-only editors, or while a
  structural completion menu is active;
- visible status when rate-limited, unavailable, or disabled;
- an editor-local pause control so the user need not change global settings.

Automatic mode uses the same service, provider, cancellation, rendering, and
acceptance code as manual mode.

### Possible later action — Improve prompt

A whole-prompt `Improve prompt` command may reuse the provider service later,
but it needs a review/diff UX rather than ghost-text insertion. Keep it separate
from continuation so the first feature has one predictable editing model.

## Architecture

```text
CodeMirror prompt-suggestion extension
             │ request/dismiss/accept
             ▼
webview prompt-suggestion controller
             │ typed request + revision + sequence
             ▼
PromptSuggestionService
             │ provider-neutral request
             ├─► VsCodeLmPromptSuggestionProvider
             └─► future standalone/configured provider
```

### `PromptSuggestionService`

Create an application service responsible for:

- provider capability/availability;
- request construction;
- cancellation and latest-request-wins sequencing;
- response normalization and length limits;
- structured unavailable, cancelled, rate-limited, and failed results;
- ensuring draft content is never written to logs or telemetry.

Suggested contracts:

```typescript
interface PromptSuggestionRequest {
  textBeforeCursor: string;
  textAfterCursor: string;
  mode: "manual" | "automatic";
  language?: string;
}

interface PromptSuggestionResult {
  status: "available" | "unavailable" | "cancelled" | "rateLimited" | "error";
  text?: string;
  message?: string;
}

interface PromptSuggestionProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  suggest(
    request: PromptSuggestionRequest,
    signal: AbortSignal
  ): Promise<PromptSuggestionResult>;
}
```

Use the project's actual cancellation primitive if the extension boundary
requires a VS Code `CancellationToken`; keep that adaptation inside the provider.

### VS Code LM adapter

The first adapter uses `vscode.lm` but must not:

- hardcode one model family as permanently preferred;
- assume Copilot is installed or entitled;
- leak raw provider errors into the editor;
- log prompt text;
- run when the user has not invoked or enabled the feature.

Select from currently available models using capability and responsiveness.
Expose the chosen model/provider in settings or status without making workflow
files depend on it.

The request should instruct the model to return only text that follows the
cursor, with a short output limit. Send the minimum useful context. A bounded
prefix and suffix is preferred over an unbounded full document once quality has
been measured.

### Webview protocol

Add typed shared messages for:

- provider capability/status;
- suggestion request;
- cancellation;
- suggestion response.

Each request carries:

- a monotonically increasing sequence;
- editor/step identity;
- document revision;
- cursor position or split prefix/suffix.

The webview accepts a response only when every identity/revision field still
matches. A sequence number alone is not sufficient when the user switches
between workflow steps.

### CodeMirror integration

Do not put request orchestration directly into the existing
`CodeMirrorEditor.tsx`.

Create a small, repository-owned CodeMirror extension/controller for:

- ghost-text state and decoration;
- accept/dismiss commands;
- keymap precedence;
- revision-aware result application;
- one-transaction insertion;
- cleanup on editor destruction.

Evaluate the existing community inline-suggestion package during implementation,
but do not adopt it solely because it is small. The editor already has precise
autocomplete, lint, mobile-keyboard, and Tab behavior. A small internal
extension may be safer and easier to test than adapting an external keymap.

The React component should only wire the extension to the controller and pass
current settings/capability state.

## Settings

Add settings through the existing ctrlyoke settings contract and schema:

- `promptSuggestions.automaticEnabled` — boolean, default `false`;
- `promptSuggestions.delayMs` — bounded debounce;
- optional provider/model preference, where supported.

Manual invocation does not require automatic mode to be enabled, but the first
use must clearly disclose that prompt draft text is sent to the selected model
provider.

Do not add a second settings source in `package.json` if the dashboard settings
schema is the current source of truth.

## Privacy and usage

- Prompt drafts are user content. Never include them in telemetry, diagnostic
  logs, error reports, or persisted run artifacts.
- Make external model transmission explicit on first use and in the setting
  description.
- Cancellation is best effort at the provider boundary; discarded late
  responses must still be ignored locally.
- Automatic mode can consume provider quota. State that clearly.
- Do not silently fall back to another provider with materially different data
  handling.

## Files and responsibilities

Exact names should follow the current area conventions, but responsibilities
should remain separated:

| Area                                                         | Responsibility                                        |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| `src/ui/prompt-suggestions/`                                 | Service and VS Code LM provider adapter               |
| `src/types/`                                                 | Shared request/result/message contracts and constants |
| `src/ui/WebviewMessageRouter.ts` or focused handler          | Route capability/request/cancel messages              |
| `src/ui/webview-react/hooks/`                                | Webview request state and settings controller         |
| `src/ui/webview-react/components/editor/prompt-suggestions/` | CodeMirror state, decoration, and commands            |
| `CodeMirrorEditor.tsx`                                       | Thin integration only                                 |
| Settings schema/defaults/UI                                  | Opt-in automatic mode and provider status             |

## Testing strategy

This feature is not manual-test-only.

### Unit tests

- latest request cancels the previous request;
- provider unavailable/rate-limited/error results are normalized;
- prompt text never appears in logs or error results;
- response length and whitespace normalization;
- stale sequence, editor identity, or revision is rejected;
- accept inserts exactly once as one undo step;
- typing, cursor movement, Escape, step switching, and unmount dismiss;
- Tab falls through when no ghost text exists or a structural completion owns it;
- automatic mode respects debounce, minimum prompt length, and disabled state.

### Integration tests

- message routing returns typed results and cancellation;
- hosted browser clients use the extension-owned provider when available;
- standalone/unavailable hosts expose a disabled state rather than timing out;
- settings changes take effect without recreating unrelated editor state.

### Manual smoke tests

- multiple available VS Code LM models;
- no eligible model/Copilot entitlement;
- slow and rate-limited providers;
- multiline and mobile editors;
- structural autocomplete, spellcheck, undo/redo, and accessibility interaction.

## Implementation order

1. Define shared contracts and `PromptSuggestionService`.
2. Implement and unit-test the VS Code LM provider adapter.
3. Add typed capability/request/cancel message routing.
4. Build the repository-owned CodeMirror ghost-text extension and tests.
5. Ship manual `Suggest continuation`.
6. Measure quality, latency, cancellation, and provider failures.
7. Add opt-in automatic suggestions using the same path.
8. Consider a separate whole-prompt improvement/diff experience.

## Acceptance criteria

- Prompt suggestions are restored as an intentional ctrlyoke prompt-authoring
  feature, not described as source-code completion.
- Manual continuation works without enabling automatic requests.
- Automatic mode is opt-in and discloses quota/privacy implications.
- The service contract is provider-neutral; VS Code LM is only the first adapter.
- `CodeMirrorEditor.tsx` remains a thin integration point.
- Stale responses cannot appear in another step or document revision.
- Existing structural completions, Tab behavior, undo, mobile input, and
  accessibility remain covered by automated tests.
