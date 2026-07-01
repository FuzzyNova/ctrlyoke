# Skill Invocation Syntax Plan

## Problem

ctrlyoke currently has two gaps around skill invocation:

1. Pure slash-command prompts bypass prompt assembly, so attached ctrlyoke skills are not introduced when the prompt is only `/commit`, `/review`, or similar.
2. Slash-prefixed ctrlyoke skill syntax collides with harness-native command parsing. A leading token like `/fp:commit` can fail before the model ever sees the attached skill context.

That creates incorrect behavior and unclear UX:

- `/commit` should remain native harness territory.
- ctrlyoke needs an explicit syntax for attached skills that does not get interpreted as a harness slash command.
- The editor should help users discover ctrlyoke skill invocations with dropdown completions.
- Prompt files and the webview editor should make the explicit ctrlyoke skill syntax clickable so users can open the referenced skill file directly.

---

## Recommendation

Adopt a two-namespace model:

- Plain `/...` remains harness-native and is never reinterpreted by ctrlyoke.
- `/skill:<skill-name>` becomes the explicit ctrlyoke skill invocation syntax.

That keeps behavior deterministic:

- `/commit` means "let the harness handle `/commit`."
- `/skill:commit` means "resolve the ctrlyoke-discoverable skill `commit`, attach it, and rewrite the prompt text before send."

The completion dropdown should be a ctrlyoke skill insertion helper only:

- typing `/` shows discovered ctrlyoke skills
- selecting an item inserts `/skill:<skill-name>`
- the dropdown does not attempt to enumerate native harness slash commands

This plan does not recommend auto-converting `/commit` into a ctrlyoke attachment when the active harness lacks that skill. That would make identical prompt text behave differently by harness in a way that is hard to explain and harder to debug.

---

## Goals

- Add dropdown completions for `/skill:<skill-name>` in the webview prompt editor.
- Add parsing support so `/skill:<skill-name>` can participate in prompt preparation without requiring manual `skills: [...]` selection.
- Rewrite `/skill:<skill-name>` into natural language before sending the prompt to the harness.
- Add clickable links for `/skill:<skill-name>` in:
  - the webview `CodeMirrorEditor`
  - VS Code prompt files via `PromptLinkProvider`
- Use `SkillDiscovery` and harness-specific skill directories to tell whether a skill is native to the current harness or ctrlyoke-only.

---

## User Experience

### Syntax rules

- `/commit`
  - Native harness command or native harness skill invocation.
  - ctrlyoke passes it through unchanged.
- `/skill:commit`
  - Explicit ctrlyoke skill reference.
  - ctrlyoke resolves skill `commit`, attaches it through the normal skill prompt path, and rewrites the token before send.

### Rewrite behavior

Prompt preparation should rewrite each `/skill:` token into natural language after skill extraction:

- `/skill:commit`
  - becomes `use the attached skill "commit"`
- `perform a code review using /skill:code-review, then run tests with /skill:test`
  - becomes `perform a code review using the attached skill "code-review", then run tests with the attached skill "test"`

This rewrite should happen only in the outgoing prompt text. The editor content should remain exactly as the user typed it.

### Editor completions

When the user types `/`, the dropdown should show only ctrlyoke-discovered skills.

Selection behavior:

- selecting `commit` inserts `/skill:commit`
- selecting `review` inserts `/skill:review`

When the user types `/skill:` directly, the dropdown should filter the same skill list by the typed prefix.

Suggested labels:

- `commit`
- `review`
- `settings`

Suggested details:

- `ctrlyoke skill`
- skill source and short description when available

### Linking behavior

- Ctrl+Click on `/skill:commit` in a prompt file opens the resolved `SKILL.md`
- Ctrl+Click on `/skill:commit` in the webview editor opens the same skill file
- If multiple discovered copies exist, resolution should follow the same precedence used for runtime invocation

---

## Design

### 1. Distinguish native slash commands from ctrlyoke skill references

Introduce a small parsing utility for ctrlyoke skill tokens:

- native form: `/[a-zA-Z0-9:_-]+`
- ctrlyoke form: `/skill:<skill-name>`

The parser should not try to interpret arbitrary slash text beyond those forms. It only needs to:

- detect whether the current token is a ctrlyoke skill token
- extract the skill name for `/skill:<skill-name>`
- leave plain `/...` tokens entirely alone

This logic should be shared by:

- `CodeMirrorEditor.tsx` dropdown completion routing
- prompt-preparation logic
- link detection in both editor and `PromptLinkProvider`

### 2. Add a harness-aware skill resolution layer

`SkillDiscovery.ts` already discovers skills across ctrlyoke and harness directories. The next step is to expose enough metadata to answer:

- is skill `X` installed in the active harness's native search paths?
- is skill `X` only available through ctrlyoke discovery?
- what concrete `SKILL.md` path should `/skill:X` open and attach?

Recommended extension to discovery output:

- preserve current `SkillInfo`
- add helper functions rather than inflating every call site with path checks

Suggested helpers:

```ts
findSkillByName(skills, name)
findSkillForHarness(skills, name, harnessId)
isSkillNativeToHarness(skill, harnessId, workspaceRoot?)
resolveCtrlYokeSkillInvocation(skills, name, harnessId)
```

Those helpers should use `HarnessDirectoryUtils` as the single source of truth for harness skill directories.

### 3. `/skill:` participates in skill attachment

Prompt preparation should treat `/skill:<skill-name>` similarly to inline prior-context references:

- detect `/skill:<skill-name>` in prompt text
- merge that skill into the effective skill set for the prompt
- attach it even if `skills: [...]` was not configured explicitly

Important behavior rule:

- `/skill:<skill-name>` should force attachment of that skill even if the prompt is otherwise simple

After extraction and attachment, the send path should rewrite the token into natural language, for example:

- `/skill:commit` -> `use the attached skill "commit"`

This avoids harness parser conflicts while preserving readable inline semantics.

### 4. Prompt editor completions

`CodeMirrorEditor.tsx` currently routes `@`, `#`, `~`, and `$` to extension-backed completions. Skill-token completions should follow the same general pattern:

- detect the most recent `/` token when the cursor is in prompt mode
- if token starts with `/skill:`, request ctrlyoke skill completions
- otherwise, when the token starts with `/`, request the same ctrlyoke skill completions and insert `/skill:<skill-name>` on selection

The dropdown should be interpreted as:

- "insert a ctrlyoke skill invocation here"

It should not be interpreted as:

- "show every command the harness might understand"

Completion entries should stay framework-agnostic on the extension side, then be mapped into CodeMirror completion items in the webview just like existing prompt completions.

### 5. Prompt-file document links

`PromptLinkProvider.ts` should recognize `/skill:<skill-name>` and create document links that open the resolved skill file.

Recommended scope:

- add `/skill:` links only
- do not link plain `/commit` because those are harness-native and not reliably tied to a single local file

Tooltip example:

- `Open ctrlyoke skill commit`

### 6. Webview editor links

`CodeMirrorEditor.tsx` already decorates and opens `@`, `#`, `~`, and `$` references. Extend that system to:

- decorate `/skill:<skill-name>` with `cm-link`
- attach data attributes containing `skillName`
- post a message to open the resolved skill file when clicked

Plain `/commit` should not be decorated as a file-backed link.

---

## Architecture

### Extension-side completion service

Add skill-token completion helpers in `src/completions/CompletionHelpers.ts` or a new adjacent helper module if the logic becomes too large.

Responsibilities:

- return ctrlyoke-discovered skill completions
- support both `/` and `/skill:` trigger contexts
- filter and sort by typed prefix
- expose plain completion items consumable by both VS Code and webview surfaces

Recommended data shape:

```ts
interface SkillTokenCompletionItem extends PlainCompletionItem {
  commandType: "ctrlyokeSkill";
  skillName: string;
}
```

### Message flow

The webview currently requests completions from the extension host. Extend that protocol with skill-token support.

Options:

1. Reuse the existing completion request message with a new `trigger` value `/`
2. Add dedicated skill-token completion request/response messages

Recommendation:

- reuse the existing completion message flow if it can carry the `/skill:` token cleanly
- only add new message types if the existing payload becomes awkward

### Harness metadata

Harness metadata still matters for runtime reasoning and future diagnostics, but it is not needed to populate the completion dropdown.

The dropdown should not depend on curated native slash-command lists. That avoids drift and avoids suggesting a misleadingly authoritative command catalog for any harness.

---

## Implementation Steps

1. Add a new backlog-supported syntax spec for `/skill:<skill-name>`.

2. Add a shared parser utility for `/skill:` references.

3. Extend skill discovery helpers so the system can answer:
   - whether a skill is native to a harness
   - which file `/skill:<skill-name>` resolves to

4. Add skill-token completion helpers on the extension side:
   - discovered ctrlyoke skill completions
   - support insertion as `/skill:<skill>`

5. Update `CodeMirrorEditor.tsx`:
   - detect `/` trigger context
   - request skill-token completions
   - decorate `/skill:<skill>` tokens as links
   - click-through to open the resolved skill file

6. Update prompt preparation logic so `/skill:<skill>` contributes to the prompt's effective skills set and is rewritten to natural language before send.

7. Update `PromptLinkProvider.ts` to recognize `/skill:<skill>` and open the resolved `SKILL.md`.

8. Add tests for:
   - skill-token parsing
   - skill-token completion filtering
   - `/skill:` link detection
   - pure `/commit` pass-through
   - `/skill:commit` forced attachment and rewrite

---

## Files to Modify

| File                                                          | Action                   | Purpose                                                                           |
| ------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `src/utils/SkillDiscovery.ts`                                 | Modify                   | Add harness-aware skill resolution helpers for `/skill:`                          |
| `src/utils/HarnessDirectoryUtils.ts`                          | Maybe modify             | Extend or reuse directory helpers as single source of truth                       |
| `src/completions/CompletionHelpers.ts`                        | Modify or extract helper | Add skill-token completion generation                                             |
| `src/completions/PromptCompletionProvider.ts`                 | Modify                   | Add `/` trigger support for prompt-file completions if desired in VS Code editors |
| `src/completions/PromptLinkProvider.ts`                       | Modify                   | Add `/skill:<skill>` document links                                               |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` | Modify                   | Add `/skill:` completions and link decoration/click handling                      |
| `src/core/harness/shared/CliPromptPreparer.ts`                 | Modify                   | Treat `/skill:` as attachable skill syntax and rewrite it before send             |
| `src/core/HarnessIntegration.ts`                               | Maybe modify             | Shared parser/helper hooks if prompt assembly should own `/skill:` extraction     |
| `src/types/DashboardConstants.ts`                             | Maybe modify             | Add message constants or skill-token metadata constants                           |
| `src/types/WebviewMessageTypes.ts`                            | Maybe modify             | Add or extend completion/open-skill message payload types                         |

---

## Testing Plan

### Extension-side tests

- `SkillDiscovery` helper tests
  - skill native to Claude but not Copilot
  - ctrlyoke-only skill
  - multiple discovered copies with precedence

- completion helper tests
  - `/` shows ctrlyoke-discovered skills only
  - `/skill:c` filters to matching ctrlyoke skills
  - selected item inserts `/skill:<skill>`

- `PromptLinkProvider` tests
  - `/skill:commit` produces a document link
  - plain `/commit` does not

### Webview tests

- `CodeMirrorEditor` completion tests
  - `/` requests skill-token completions
  - selecting `/skill:commit` inserts the expected token

- `CodeMirrorEditor` link tests
  - `/skill:commit` gets link decoration
  - clicking it posts the open-skill message

### Prompt-preparation tests

- pure `/commit` remains inline and unassembled
- `/skill:commit` forces skill attachment
- `/skill:commit` rewrites to natural language before send
- `/skill:commit` merges with explicit `skills: [...]`
- `/skill:commit` does not require workflow-level `skills`

---

## Open Questions

1. Should VS Code prompt-file completions also support `/` in `PromptCompletionProvider`, or should skill-token completions be webview-only first?
2. Should the rewrite phrase always be `use the attached skill "<name>"`, or should it vary by sentence position, for example `the attached skill "<name>"` when the token follows `using`?
3. If both workflow properties and `/skill:` add the same skill, should deduplication happen by name only or by resolved file path?
4. Should `/skill:` be allowed multiple times in one prompt, and if so, should repeated entries preserve order or collapse to a set?
5. Should the completion UI expose when a similarly named native harness skill also exists, for example detail text like `Native Claude skill also available`, or should the UI stay intentionally ctrlyoke-only?

---

## Recommended Rollout

### Phase 1

- Add `/skill:` parsing
- Add webview dropdown completions
- Add prompt-file and webview links
- Add prompt-preparation support with outgoing rewrite

### Phase 2

- Add VS Code editor skill-token completions in `PromptCompletionProvider`
- Add optional UI hints when a plain `/skill` collides with a ctrlyoke skill of the same name

### Phase 3

- Revisit resume semantics so newly introduced skills from `/skill:` are attached even on resumed sessions while unchanged skills remain omitted

---

## Non-Goals

- Auto-rewriting plain `/commit` into a ctrlyoke skill token
- Using slash-prefixed ctrlyoke skill syntax that can be interpreted as a native harness command
- Attaching ctrlyoke skills automatically just because a harness lacks a native skill with that name
- Maintaining curated native slash-command catalogs for each harness
- Linking plain native slash commands to arbitrary files
- Full slash-command introspection from external CLIs at runtime
