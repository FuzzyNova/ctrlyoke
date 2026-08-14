# Skill and MCP Invocation Syntax Plan

## Problem

ctrlyoke currently has gaps around skill and MCP invocation:

1. Pure slash-command prompts bypass prompt assembly, so attached ctrlyoke skills are not introduced when the prompt is only `/commit`, `/review`, or similar.
2. Slash-prefixed ctrlyoke skill syntax collides with harness-native command parsing. A leading token like `/fp:commit` can fail before the model ever sees the attached skill context.
3. There is no equivalent inline syntax for MCP servers. `mcpServers: [...]` already exists as a declarative workflow/step property (`src/types/CtrlYokeTypes.ts:225`, parallel to `skills?: string[] | null` at line 212), but it can only be set from the workflow/step properties UI or by hand-editing the prompt file — never by typing something in the prompt body itself.
4. **A bare non-`"ctrlyoke"` string in `mcpServers: [...]` is silently dropped today.** `CliProviderUtils.planMcpConfigBlock()` (`src/core/harness/shared/CliProviderUtils.ts:372-377`) filters `resolvedProperties.mcpServers` down to entries that are `typeof server === "object"` with `id !== "ctrlyoke"`; a hand-written `mcpServers: ["playwright"]` produces zero MCP servers at runtime, no warning. This has never surfaced because the only UI that writes to `mcpServers` (`McpServersEditor.tsx`'s `handleToggleServer`) always resolves a registry entry to its full `McpServerConfig` object before writing it in (`managedServer.config`, `McpServersEditor.tsx:667`) — it never writes a bare ID string for anything but `"ctrlyoke"`. Any `/mcp:<name>` syntax needs a real string→config resolution step that doesn't exist yet; this is a prerequisite fix, not a byproduct of the new syntax.

That creates incorrect behavior and unclear UX:

- `/commit` should remain native harness territory.
- `/mcp` is itself a **native command in some harnesses today** (e.g. Claude Code CLI's built-in `/mcp` opens its MCP connection UI) — so, exactly like skills, ctrlyoke cannot claim bare `/mcp` for itself.
- ctrlyoke needs explicit syntax for both attached skills and attached MCP servers that does not get interpreted as a harness slash command.
- The editor should help users discover ctrlyoke skill and MCP invocations with dropdown completions.
- Prompt files and the webview editor should make both explicit syntaxes clickable so users can jump to the referenced skill file or MCP server's management entry.

---

## Recommendation

Adopt a three-namespace model:

- Plain `/...` remains harness-native and is never reinterpreted by ctrlyoke.
- `/skill:<skill-name>` becomes the explicit ctrlyoke skill invocation syntax.
- `/mcp:<mcp-name>` becomes the explicit ctrlyoke MCP server attachment syntax.

That keeps behavior deterministic:

- `/commit` means "let the harness handle `/commit`."
- `/mcp` means "let the harness handle its own native `/mcp` command" (where one exists).
- `/skill:commit` means "resolve the ctrlyoke-discoverable skill `commit`, attach it, and rewrite the prompt text before send."
- `/mcp:playwright` means "resolve the ctrlyoke-managed MCP server `playwright` from the ctrlyoke MCP registry, and make sure it is attached to the harness process for this step."

The completion dropdown should be a ctrlyoke insertion helper only:

- typing `/` shows discovered ctrlyoke skills **and** ctrlyoke-managed MCP servers, in one merged list
- selecting a skill item inserts `/skill:<skill-name>`
- selecting an MCP item inserts `/mcp:<mcp-name>`
- the dropdown does not attempt to enumerate native harness slash commands

This plan does not recommend auto-converting `/commit` into a ctrlyoke attachment when the active harness lacks that skill or MCP server. That would make identical prompt text behave differently by harness in a way that is hard to explain and harder to debug.

---

## A structural asymmetry between `/skill:` and `/mcp:`

Skills and MCP servers attach through genuinely different mechanisms in ctrlyoke today, and the plan for `/mcp:` has to respect that rather than copy the skill mechanism verbatim.

**Skills are prompt content.** `CliPromptPreparer` (`src/core/harness/shared/CliPromptPreparer.ts`) decides, per prompt, whether to wrap the user's text with categorized temp files. Skill content becomes `sections.skillContent`, gets written to a temp file, and is referenced inline. This happens **after** property resolution, as part of assembling the exact text/files sent to the harness for that single prompt.

**MCP servers are process-spawn configuration.** `resolvedProperties.mcpServers` is resolved once per step by `PropertyResolver.resolve()` (inheriting workflow → prompt, same as `skills`), then consumed by `CliProviderUtils.buildMcpConfigBlock()` / `planMcpConfigBlock()` to generate a `--mcp-config` file (Claude, Copilot, Qwen, Antigravity, OpenCode) or inline TOML block (Codex) **before the harness process starts**. There is no `CliPromptPreparer` involvement at all — see `.github/instructions/harness-shared.instructions.md`: "`CliProviderUtils.buildMcpConfigBlock()` centralizes 'should MCP be attached at all?' logic."

Consequences for `/mcp:<name>`:

1. **A rewrite is still needed, but for a different reason than skills.** Tool *discovery* needs no textual cue — an MCP server's tools become visible to the model automatically through the harness's own MCP protocol the moment the server is connected. But prompt *intent* often does: `"only use /mcp:ctrlyoke if you need to add more steps, and only use /mcp:playwright if you need to test a UI"` is disambiguating between two attached servers with per-server guidance, and that mapping has to survive whatever happens to the token. So `/mcp:<name>` is **rewritten in place**, not deleted — same in-place-substitution shape as `/skill:`, substituting a minimal, grammar-neutral reference such as `mcp: ctrlyoke` for the literal token (just the leading `/` and the colon-prefixed syntax swapped for a plain label — no injected verb phrase, since a full sentence like `use the attached MCP server "ctrlyoke"` presupposes a sentence shape that may not match where the token sits and can read as a run-on when it doesn't). (An earlier draft of this plan proposed deleting the token outright; that was wrong — it silently drops exactly the per-server guidance this syntax exists to carry, and is corrected here.) The literal `/mcp:...` token must still never reach the harness verbatim, both because it has no meaning there and to avoid confusing a harness with a native `/mcp` parser.
2. **The extraction point is different.** `/skill:` extraction happens inside `CliPromptPreparer`, per prompt, right before send. `/mcp:` extraction has to happen **at or before `PropertyResolver.resolve()`**, because `resolvedProperties.mcpServers` is what feeds `ExecutionPlanBuilder` (`session.resolvedProperties?.mcpServers`, `ExecutionPlanBuilder.ts:212`) and `CliProviderUtils.buildMcpConfigBlock()`, both of which run before the harness process spawns — well before `CliPromptPreparer` ever sees the prompt. Concretely: scan `prompt.prompt` for `/mcp:<name>` tokens as part of building `resolvedProperties`, resolve each name against the ctrlyoke MCP registry, and merge the resolved `McpServerConfig` objects into `resolved.mcpServers` (deduped by id) — same override semantics as an explicit `skills:`/`mcpServers:` list, i.e. force-attach even if the workflow/step property omitted it, but do not fight an explicit `mcpServers: null` without a documented rule (see Open Questions).
3. **PTY reuse can be affected.** `.github/instructions/harness-cli-providers.instructions.md`'s sibling doc, `harness-integrations.instructions.md`, states: "If a spawn-time property changes, retire the PTY instead of forcing reuse." `mcpServers` is a spawn-time property. If a later queued prompt in an interactive run introduces a new `/mcp:<name>` that isn't in the currently-running process's MCP config, the PTY-reuse decision must treat that as a spawn-time property change and retire/respawn rather than silently keep running without the new server. Verify this comparison already covers `mcpServers`, or extend it — this is a required implementation step, not just documentation.
4. **No harness-native-vs-ctrlyoke-only ambiguity.** The skill plan needs `isSkillNativeToHarness()` because a skill named `commit` might be native to one harness and ctrlyoke-only for another. MCP servers referenced by `/mcp:<name>` have no such duality: `/mcp:<name>` always means "the entry named `<name>` in the ctrlyoke MCP registry" (`.ctrlyoke/mcp/servers.json` workspace-scope, `~/.ctrlyoke/mcp/servers.json` user-scope, via `McpRegistryFileManager.readAll()`), never a server that merely happens to already exist in some harness's own native config file. That simplifies MCP resolution relative to skills — there is exactly one source of truth to check, not "is this native, and if not where do I find it."

---

## Goals

- Add dropdown completions for `/skill:<skill-name>` **and** `/mcp:<mcp-name>` in the webview prompt editor.
- Add parsing support so `/skill:<skill-name>` can participate in prompt preparation without requiring manual `skills: [...]` selection, and `/mcp:<mcp-name>` can participate in property resolution without requiring manual `mcpServers: [...]` selection.
- Rewrite `/skill:<skill-name>` to a minimal `skill: <name>` reference before sending the prompt to the harness (not a full sentence — see rationale below); rewrite `/mcp:<mcp-name>` to `mcp: <name>` the same way, so per-server guidance in a prompt (e.g. "only use X if..., only use Y if...") keeps its referent without dictating the surrounding sentence's grammar.
- Fix the existing gap where a bare non-`"ctrlyoke"` string in `mcpServers: [...]` is silently dropped, since `/mcp:<name>` resolution depends on the same string→config lookup.
- Add clickable links for `/skill:<skill-name>` and `/mcp:<mcp-name>` in:
  - the webview `CodeMirrorEditor`
  - VS Code prompt files via `PromptLinkProvider`
- Use `SkillDiscovery` and harness-specific skill directories to tell whether a skill is native to the current harness or ctrlyoke-only.
- Use the ctrlyoke MCP registry (`McpRegistryFileManager`) as the single resolution source for `/mcp:<name>`.
- (Follow-on, not Phase 1) Add tool-level completions via `/mcp:<server>:<tool>`, expanding to the server's literal declared tool name — free for ctrlyoke's own server (`getToolDefinitions()` is already static and in-process), but requiring new, lazily-triggered, cached, timeout-bounded MCP client capability for third-party servers (design point 9).

---

## User Experience

### Syntax rules

- `/commit`
  - Native harness command or native harness skill invocation.
  - ctrlyoke passes it through unchanged.
- `/mcp`
  - Native harness command where one exists (e.g. Claude Code's built-in MCP connection UI).
  - ctrlyoke passes it through unchanged.
- `/skill:commit`
  - Explicit ctrlyoke skill reference.
  - ctrlyoke resolves skill `commit`, attaches it through the normal skill prompt path, and rewrites the token to `skill: commit` before send.
- `/mcp:playwright`
  - Explicit ctrlyoke MCP server reference.
  - ctrlyoke resolves MCP server `playwright` from the ctrlyoke MCP registry, merges it into this step's effective `mcpServers`, and rewrites the token in place to `mcp: playwright` in the outgoing prompt text.
- `/mcp:playwright:browser_hover` *(follow-on extension, design point 9 — not Phase 1)*
  - Explicit ctrlyoke MCP tool reference. Attaches the whole `playwright` server exactly like `/mcp:playwright` would, and additionally rewrites the token to that server's literal declared tool name (`mcp: <literal tool name>`) instead of just the server name, saving the user from typing the tool name out by hand.

### Rewrite behavior

Prompt preparation should rewrite each `/skill:` and `/mcp:` token in place to a minimal, grammar-neutral label — the leading `/` and colon-prefixed syntax dropped in favor of a plain `skill: <name>` / `mcp: <name>` reference — rather than a full sentence. A prose rewrite like `use the attached skill "commit"` presupposes a sentence shape the token doesn't always sit in: `using /skill:commit, commit just the changes to file.txt` would become `using use the attached skill "commit", commit just the changes to file.txt` — a double verb and a run-on that fights the sentence around it. The minimal label avoids that:

- `/skill:commit`
  - becomes `skill: commit`
- `using /skill:commit, commit just the changes to file.txt`
  - becomes `using skill: commit, commit just the changes to file.txt`
- `perform a code review using /skill:code-review, then run tests with /skill:test`
  - becomes `perform a code review using skill: code-review, then run tests with skill: test`
- `using /mcp:ctrlyoke, append steps to the queue`
  - becomes `using mcp: ctrlyoke, append steps to the queue`
- `only use /mcp:ctrlyoke if you need to add more steps, and only use /mcp:playwright if you need to test a UI`
  - becomes `only use mcp: ctrlyoke if you need to add more steps, and only use mcp: playwright if you need to test a UI`
- `use /mcp:ctrlyoke:append_queue to add a planning and implementation step to the queue` *(follow-on extension, design point 9)*
  - becomes `use mcp: ctrlyoke_append_queue to add a planning and implementation step to the queue` — the inserted name is the tool's literal declared name (here it happens to already be `ctrlyoke_append_queue`), never a synthesized `<server>_<tool>` concatenation

Deleting the token outright (an earlier draft's approach) was also considered and rejected: it collapses `look up the page title with /mcp:playwright` to `look up the page title with`, losing the only thing the sentence was about. Minimal in-place substitution is the correct default for both `/skill:` and `/mcp:` — enough to keep the referent, not enough to impose sentence structure.

This rewrite should happen only in the outgoing prompt text. The editor content should remain exactly as the user typed it.

### Editor completions

When the user types `/`, the dropdown should show ctrlyoke-discovered skills and ctrlyoke-managed MCP servers together.

Selection behavior:

- selecting skill `commit` inserts `/skill:commit`
- selecting skill `review` inserts `/skill:review`
- selecting MCP server `playwright` inserts `/mcp:playwright`
- selecting MCP server `ctrlyoke` inserts `/mcp:ctrlyoke`

When the user types `/skill:` or `/mcp:` directly, the dropdown should filter the matching list by the typed prefix.

Suggested labels:

- `commit` (skill)
- `review` (skill)
- `playwright` (MCP server)
- `ctrlyoke` (MCP server)

Suggested details:

- `ctrlyoke skill` / skill source and short description when available
- `ctrlyoke MCP server` / server summary (command or URL) when available

### Linking behavior

- Ctrl+Click on `/skill:commit` in a prompt file opens the resolved `SKILL.md`
- Ctrl+Click on `/skill:commit` in the webview editor opens the same skill file
- If multiple discovered skill copies exist, resolution should follow the same precedence used for runtime invocation
- Ctrl+Click on `/mcp:playwright` opens the MCP Manager settings page with that server focused (there is no per-server file to open — MCP registry entries are JSON records, not documents; see Open Questions for whether this needs a new webview message)

---

## Design

### 1. Distinguish native slash commands from ctrlyoke references

Introduce a small parsing utility for ctrlyoke slash tokens:

- native form: `/[a-zA-Z0-9:_-]+`
- ctrlyoke skill form: `/skill:<skill-name>`
- ctrlyoke MCP form: `/mcp:<mcp-name>`

The parser should not try to interpret arbitrary slash text beyond those forms. It only needs to:

- detect whether the current token is a ctrlyoke skill or MCP token
- extract the name for `/skill:<skill-name>` and `/mcp:<mcp-name>`
- leave plain `/...` tokens (including bare `/mcp`) entirely alone

This logic should be shared by:

- `CodeMirrorEditor.tsx` dropdown completion routing
- prompt-preparation logic (`CliPromptPreparer` for skills)
- property-resolution logic (wherever `/mcp:` extraction lands — see the asymmetry section)
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

### 3. Add an MCP resolution layer, and fix string-ID resolution

`McpRegistryFileManager.readAll()` already merges workspace + user scope MCP registry entries into `ManagedMcpServer[]` (id, displayName, config, locations). That's the right source for `/mcp:<name>`, but nothing today turns a bare registry ID into an `McpServerConfig` at the point `resolvedProperties.mcpServers` is consumed.

Suggested helpers, parallel to the skill helpers:

```ts
findManagedMcpServerByName(servers: ManagedMcpServer[], name: string): ManagedMcpServer | undefined
resolveCtrlYokeMcpInvocation(servers: ManagedMcpServer[], name: string): McpServerConfig | undefined
```

And the prerequisite fix: wherever `resolvedProperties.mcpServers` is turned into `userServers` (currently `CliProviderUtils.planMcpConfigBlock`, `CliProviderUtils.ts:372-377`), bare strings other than `"ctrlyoke"` must be resolved against the registry instead of silently dropped. The cleanest fix is to do this resolution once, upstream, when `resolvedProperties.mcpServers` is finalized (see design point 6), so every downstream consumer (`CliProviderUtils`, `ExecutionPlanBuilder`'s `mergeServerDeniedTools`) already sees fully-resolved `McpServerConfig` objects and the existing `typeof server === "object"` filter continues to work unchanged.

### 4. `/skill:` participates in skill attachment

Prompt preparation should treat `/skill:<skill-name>` similarly to inline prior-context references:

- detect `/skill:<skill-name>` in prompt text
- merge that skill into the effective skill set for the prompt
- attach it even if `skills: [...]` was not configured explicitly

Important behavior rule:

- `/skill:<skill-name>` should force attachment of that skill even if the prompt is otherwise simple

After extraction and attachment, the send path should rewrite the token to a minimal label, for example:

- `/skill:commit` -> `skill: commit`

This avoids harness parser conflicts while preserving readable inline semantics without dictating the surrounding sentence's grammar.

### 5. `/mcp:` participates in property resolution, not prompt assembly

Unlike skills, `/mcp:<mcp-name>` cannot be handled inside `CliPromptPreparer` — by the time `CliPromptPreparer.planPrompt()` runs, `resolvedProperties.mcpServers` has already been read by `ExecutionPlanBuilder`/`CliProviderUtils.buildMcpConfigBlock()` to build the process's spawn args. `/mcp:` extraction has to run at (or immediately after) `PropertyResolver.resolve()`, before that consumption:

- scan `prompt.prompt` for `/mcp:<mcp-name>` tokens
- resolve each name against the ctrlyoke MCP registry (design point 3)
- merge resolved `McpServerConfig` objects into `resolved.mcpServers`, deduped by `id`, same force-attach rule as skills (present even if `mcpServers: [...]` wasn't configured for this step)
- leave the in-place rewrite step (`/mcp:playwright` → `mcp: playwright`) for wherever the final prompt string is assembled (likely still inside `CliPromptPreparer`, since that remains the last place prompt text is finalized before send) — extraction (property resolution) and text rewriting (prompt assembly) are two different steps at two different points in the pipeline, unlike skills where they're one step

### 6. Prompt editor completions

`CodeMirrorEditor.tsx` currently routes `@`, `#`, `~`, and `$` to extension-backed completions. Skill- and MCP-token completions should follow the same general pattern:

- detect the most recent `/` token when the cursor is in prompt mode
- if token starts with `/skill:`, request ctrlyoke skill completions
- if token starts with `/mcp:`, request ctrlyoke MCP-server completions
- otherwise, when the token starts with `/`, request both skill and MCP completions merged, inserting `/skill:<skill>` or `/mcp:<server>` depending on which item is selected

The dropdown should be interpreted as:

- "insert a ctrlyoke skill or MCP server invocation here"

It should not be interpreted as:

- "show every command the harness might understand"

Completion entries should stay framework-agnostic on the extension side, then be mapped into CodeMirror completion items in the webview just like existing prompt completions.

### 7. Prompt-file document links

`PromptLinkProvider.ts` should recognize `/skill:<skill-name>` and `/mcp:<mcp-name>` and create document links.

Recommended scope:

- `/skill:` links open the resolved `SKILL.md`
- `/mcp:` links open... see Open Questions — there is no file to open, so this may need a webview/command link rather than a `vscode.DocumentLink` target, or may need to be VS-Code-editor-only if a plain document link can't drive "open a settings page"
- do not link plain `/commit` or `/mcp` because those are harness-native and not reliably tied to a single local file

Tooltip examples:

- `Open ctrlyoke skill commit`
- `Open ctrlyoke MCP server playwright in MCP Manager`

### 8. Webview editor links

`CodeMirrorEditor.tsx` already decorates and opens `@`, `#`, `~`, and `$` references. Extend that system to:

- decorate `/skill:<skill-name>` and `/mcp:<mcp-name>` with `cm-link`
- attach data attributes containing `skillName` or `mcpServerName`
- post a message to open the resolved skill file, or open the MCP Manager settings page focused on that server, when clicked

Plain `/commit` and bare `/mcp` should not be decorated as ctrlyoke-backed links.

### 9. Optional extension: tool-level completions (`/mcp:<server>:<tool>`)

Server-level `/mcp:<name>` only saves typing the server ID. A recurring real case is typing out an individual tool name in prose, e.g. `use ctrlyoke_append_queue to add a planning and implementation step to the queue`. A three-segment form, `/mcp:<server>:<tool>`, could expand to that tool's literal name instead of just the server reference — `/mcp:ctrlyoke:append_queue` → `mcp: ctrlyoke_append_queue`, `/mcp:playwright:browser_hover` → `mcp: <literal tool name the server declares>`.

This is a materially different cost and risk profile from everything else in this plan, and should be scoped and rolled out separately rather than assumed to ride along with Phase 1:

- **ctrlyoke's own server is free.** `mcp-server.ts`'s `getToolDefinitions()` already returns the full tool list statically, in-process. `/mcp:ctrlyoke:<tool>` completions can be served from that list directly with no spawn, no network call, no cache invalidation story.
- **Third-party servers require building a real MCP client — new capability, not reuse of existing code.** `@modelcontextprotocol/sdk` is already a dependency, but grep confirms it is only ever used to build ctrlyoke's own server (`mcp-server.ts`); the only other `tools/list` handler in the repo (`src/test/harness/helpers/harnessRunner.ts:362`) is a fake server used to fixture tests, not a client. Introspecting `playwright` (or any registry entry that isn't `"ctrlyoke"`) means connecting as a client for the first time anywhere in this codebase: spawn + `initialize` + `tools/list` for a stdio server (`command`/`args`/`env` from its `McpServerConfig`), or an HTTP/SSE handshake for a `url`-based one.
- **This must be lazy, cached, and timeout-bounded, or it is genuinely expensive.** Populating the base `/` dropdown must never trigger introspection of every registered server — that would spawn N processes on a single keystroke. Introspection should trigger only once the user has typed `/mcp:<server>:` for a *specific* server, cache the resulting tool list in-memory for the extension-host session (keyed by server id, invalidated when that server's registry entry changes), and enforce a short timeout (a few seconds) with graceful fallback to "no tool-level completions available yet" rather than blocking the dropdown — some MCP servers (`npx`-based ones especially) can take several seconds to cold-start, and a misconfigured or auth-gated server can hang indefinitely.
- **The expanded name must come from the server, not be synthesized.** `ctrlyoke_append_queue` happens to be self-prefixed because that's the literal name the ctrlyoke server registers — that is a fact about this one server, not a naming convention `/mcp:` can assume generally. The resolver must insert whatever `tools/list` actually returned for that tool, not `<server>_<tool>` concatenated client-side; guessing a name the server didn't declare would hand the model a tool reference that doesn't exist.
- **Attachment scope is unchanged.** `/mcp:<server>:<tool>` still merges the *whole* `McpServerConfig` for `<server>` into `resolvedProperties.mcpServers` — identical resolution to `/mcp:<server>` alone (design point 3). The `:<tool>` segment is a completion/rewrite convenience only; it does not add per-tool attachment scoping (`McpServerConfig.deniedTools` already exists for narrowing what's enabled, but that's an orthogonal, pre-existing mechanism this extension doesn't need to touch).

Given the new-capability risk (first MCP client code in the codebase) and the UX unknowns (loading state while a server cold-starts, what a timed-out completion looks like, per-server caching lifetime), this extension should land as its own follow-on phase after server-level `/mcp:<name>` has shipped and proven out, not as part of Phase 1.

---

## Architecture

### Extension-side completion service

Add skill- and MCP-token completion helpers in `src/completions/CompletionHelpers.ts` or a new adjacent helper module if the logic becomes too large.

Responsibilities:

- return ctrlyoke-discovered skill completions
- return ctrlyoke-managed MCP server completions (from `McpRegistryFileManager.readAll()`, not from `McpDiscoveryUtils`'s local-harness-config scan — completions should only ever offer servers a user can actually attach through ctrlyoke, i.e. registry entries, mirroring how skill completions only offer ctrlyoke-discovered skills)
- support both `/`, `/skill:`, and `/mcp:` trigger contexts
- filter and sort by typed prefix
- expose plain completion items consumable by both VS Code and webview surfaces

Recommended data shape:

```ts
interface SkillTokenCompletionItem extends PlainCompletionItem {
  commandType: "ctrlyokeSkill";
  skillName: string;
}

interface McpTokenCompletionItem extends PlainCompletionItem {
  commandType: "ctrlyokeMcpServer";
  mcpServerName: string;
}
```

### Message flow

The webview currently requests completions from the extension host. Extend that protocol with skill- and MCP-token support.

Options:

1. Reuse the existing completion request message with a new `trigger` value `/`
2. Add dedicated skill-token and MCP-token completion request/response messages

Recommendation:

- reuse the existing completion message flow if it can carry both `/skill:` and `/mcp:` tokens cleanly
- only add new message types if the existing payload becomes awkward

### Harness metadata

Harness metadata still matters for runtime reasoning and future diagnostics (skills), but it is not needed to populate the completion dropdown — for either skills or MCP servers.

The dropdown should not depend on curated native slash-command lists, and should not depend on which harness is currently selected. That avoids drift and avoids suggesting a misleadingly authoritative command catalog for any harness.

---

## Implementation Steps

1. Add a new backlog-supported syntax spec for `/skill:<skill-name>` and `/mcp:<mcp-name>`.

2. Add a shared parser utility for `/skill:` and `/mcp:` references.

3. Extend skill discovery helpers so the system can answer:
   - whether a skill is native to a harness
   - which file `/skill:<skill-name>` resolves to

4. Fix the bare-string MCP resolution gap: add `resolveCtrlYokeMcpInvocation()` (or equivalent) so any string ID in `mcpServers: [...]` — not just `"ctrlyoke"` — resolves against the ctrlyoke MCP registry before `CliProviderUtils.planMcpConfigBlock()` filters it. This should land and be tested independently of `/mcp:`, since it's a correctness fix for the existing declarative property too.

5. Add skill-token and MCP-token completion helpers on the extension side:
   - discovered ctrlyoke skill completions
   - ctrlyoke-managed MCP server completions
   - support insertion as `/skill:<skill>` and `/mcp:<server>`

6. Update `CodeMirrorEditor.tsx`:
   - detect `/` trigger context
   - request skill- and MCP-token completions
   - decorate `/skill:<skill>` and `/mcp:<server>` tokens as links
   - click-through to open the resolved skill file / MCP Manager entry

7. Update prompt preparation logic so `/skill:<skill>` contributes to the prompt's effective skills set and is rewritten to natural language before send.

8. Update property-resolution logic so `/mcp:<server>` contributes to the step's effective `mcpServers` set (merged into `resolvedProperties.mcpServers`, deduped by id) before `ExecutionPlanBuilder`/`CliProviderUtils.buildMcpConfigBlock()` consume it; rewrite the token in place to a minimal label (e.g. `mcp: playwright`) during prompt assembly, preserving its position in the sentence.

9. Verify (and if needed extend) the interactive PTY-reuse comparison so a newly-introduced `/mcp:<server>` in a later queued prompt is treated as a spawn-time property change, forcing PTY retirement/respawn instead of silently running without the new server.

10. Update `PromptLinkProvider.ts` to recognize `/skill:<skill>` and `/mcp:<server>`, opening the resolved `SKILL.md` or MCP Manager entry respectively.

11. Add tests for:
    - skill-token parsing
    - MCP-token parsing
    - skill-token completion filtering
    - MCP-token completion filtering
    - `/skill:` and `/mcp:` link detection
    - pure `/commit` and bare `/mcp` pass-through
    - `/skill:commit` forced attachment and rewrite
    - `/mcp:playwright` forced attachment and in-place prompt-text rewrite
    - bare non-`"ctrlyoke"` string in `mcpServers: [...]` now resolves instead of being dropped
    - PTY retirement when a queued prompt's `/mcp:` reference changes the resolved `mcpServers` set mid-run

12. *(Follow-on extension, design point 9 — separate phase, not bundled with the steps above)* Add `/mcp:<server>:<tool>` support:
    - a new introspection module that, given a resolved `McpServerConfig`, connects as an MCP client (stdio spawn or HTTP/SSE) and calls `tools/list`
    - an in-memory cache keyed by server id, with a short timeout and graceful "no tool completions yet" fallback on failure/timeout
    - completion wiring that only triggers introspection once the user types `/mcp:<server>:`, never eagerly for the base `/` dropdown
    - ctrlyoke's own server (`"ctrlyoke"`) served directly from `mcp-server.ts`'s static `getToolDefinitions()`, bypassing introspection entirely
    - rewrite using the tool's literal declared name from `tools/list`, never a synthesized `<server>_<tool>` string

---

## Files to Modify

| File                                                          | Action                   | Purpose                                                                           |
| --------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `src/utils/SkillDiscovery.ts`                                 | Modify                   | Add harness-aware skill resolution helpers for `/skill:`                          |
| `src/utils/HarnessDirectoryUtils.ts`                          | Maybe modify             | Extend or reuse directory helpers as single source of truth                       |
| `src/utils/McpRegistryFileManager.ts`                         | Modify                   | Add name-based resolution helper for `/mcp:` and for fixing bare-string handling  |
| `src/core/harness/shared/CliProviderUtils.ts`                 | Modify                   | Ensure resolved (not raw) `McpServerConfig[]` reaches the existing `userServers` filter |
| `src/utils/PropertyResolver.ts`                                | Modify                   | Merge `/mcp:` references into `resolved.mcpServers` during resolution             |
| `src/completions/CompletionHelpers.ts`                        | Modify or extract helper | Add skill-token and MCP-token completion generation                              |
| `src/completions/PromptCompletionProvider.ts`                 | Modify                   | Add `/` trigger support for prompt-file completions if desired in VS Code editors |
| `src/completions/PromptLinkProvider.ts`                       | Modify                   | Add `/skill:<skill>` and `/mcp:<server>` document links                          |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` | Modify                   | Add `/skill:` and `/mcp:` completions and link decoration/click handling          |
| `src/core/harness/shared/CliPromptPreparer.ts`                | Modify                   | Treat `/skill:` as attachable skill syntax and rewrite it before send; rewrite `/mcp:` tokens in place to minimal `mcp: <name>` labels in outgoing text |
| `src/core/HarnessIntegration.ts`                              | Maybe modify             | Shared parser/helper hooks if prompt assembly should own `/skill:`/`/mcp:` extraction |
| `src/ui/McpManagerService.ts`                                 | Maybe modify             | Expose registry lookups to completion/link providers if not already accessible    |
| `src/types/DashboardConstants.ts`                             | Maybe modify             | Add message constants or skill/MCP-token metadata constants                       |
| `src/types/WebviewMessageTypes.ts`                             | Maybe modify             | Add or extend completion/open-skill/open-mcp-server message payload types         |
| `.github/instructions/harness-integrations.instructions.md`   | Maybe modify             | Document the PTY-retirement trigger once `/mcp:`-driven `mcpServers` changes are wired in |
| `src/utils/McpToolIntrospector.ts` *(new, follow-on extension)* | Add                     | MCP client: spawn/connect + `initialize` + `tools/list`, in-memory cache, timeout — powers `/mcp:<server>:<tool>` completions (design point 9) |

---

## Testing Plan

### Extension-side tests

- `SkillDiscovery` helper tests
  - skill native to Claude but not Copilot
  - ctrlyoke-only skill
  - multiple discovered copies with precedence

- `McpRegistryFileManager` resolution tests
  - bare string ID resolves to full `McpServerConfig` from workspace scope
  - workspace scope overrides user scope on ID collision (existing `readAll()` precedence)
  - unknown ID resolves to `undefined`, not a thrown error

- completion helper tests
  - `/` shows ctrlyoke-discovered skills and MCP servers only
  - `/skill:c` filters to matching ctrlyoke skills
  - `/mcp:p` filters to matching ctrlyoke MCP servers
  - selected skill item inserts `/skill:<skill>`
  - selected MCP item inserts `/mcp:<server>`

- `PropertyResolver` tests
  - `/mcp:playwright` in prompt text merges a resolved `McpServerConfig` into `resolved.mcpServers` even when the step's `mcpServers` property is unset
  - `/mcp:playwright` merges alongside an explicit `mcpServers: ["ctrlyoke"]` without duplicating `ctrlyoke`
  - unknown `/mcp:unknown-server` does not throw; documents chosen behavior (silently ignored vs. diagnostic — see Open Questions)

- `PromptLinkProvider` tests
  - `/skill:commit` produces a document link
  - `/mcp:playwright` produces a document link (or command link, per design point 7 resolution)
  - plain `/commit` and bare `/mcp` do not

### Webview tests

- `CodeMirrorEditor` completion tests
  - `/` requests merged skill+MCP completions
  - selecting `/skill:commit` inserts the expected token
  - selecting `/mcp:playwright` inserts the expected token

- `CodeMirrorEditor` link tests
  - `/skill:commit` and `/mcp:playwright` get link decoration
  - clicking each posts the expected open message

### Prompt-preparation tests

- pure `/commit` and bare `/mcp` remain inline and unassembled
- `/skill:commit` forces skill attachment
- `/skill:commit` rewrites to `skill: commit` before send
- `/skill:commit` merges with explicit `skills: [...]`
- `/skill:commit` does not require workflow-level `skills`
- `/mcp:playwright` is rewritten in place to `mcp: playwright` in the outgoing prompt text (not deleted), and multi-reference prompts like `only use X if..., only use Y if...` keep each reference distinguishable after rewrite
- `/mcp:playwright` does not require workflow-level `mcpServers`

### Regression test for the existing gap

- `mcpServers: ["playwright"]` (hand-authored, no `/mcp:` involved) resolves `playwright` from the registry and reaches the harness's generated MCP config — this must pass independent of anything in this plan shipping, since it's a pre-existing correctness gap.

### Tool-level completion tests (follow-on extension, design point 9)

- `/mcp:ctrlyoke:` completions resolve from `getToolDefinitions()` with no process spawn and no cache miss possible
- `/mcp:playwright:` completions trigger introspection only once per server per session (cache hit on second request)
- introspection timeout falls back to no tool-level completions without blocking the base `/mcp:playwright` server-level completion
- rewritten tool name matches the literal name returned by `tools/list`, not a synthesized `<server>_<tool>` string
- `/mcp:playwright:browser_hover` still merges the whole `playwright` `McpServerConfig` into `resolved.mcpServers`, identical to what `/mcp:playwright` alone would produce

---

## Open Questions

1. Should VS Code prompt-file completions also support `/` in `PromptCompletionProvider`, or should skill/MCP-token completions be webview-only first?
2. Should the minimal label be quoted for names containing spaces or punctuation (`skill: "code review"`), or is `skill: <name>` bare-word-only, given skill/MCP names are already constrained to `[a-zA-Z0-9-_]+` by the parsing rule in Design §1?
3. If both workflow properties and `/skill:`/`/mcp:` add the same skill/server, should deduplication happen by name only or by resolved file path / server id?
4. Should `/skill:` and `/mcp:` be allowed multiple times in one prompt, and if so, should repeated entries preserve order or collapse to a set?
5. Should the completion UI expose when a similarly named native harness skill also exists, for example detail text like `Native Claude skill also available`, or should the UI stay intentionally ctrlyoke-only?
6. What should `/mcp:unknown-name` do when the name isn't in the ctrlyoke MCP registry — leave the literal token untouched (so it's visibly unresolved rather than silently misleading), rewrite to a neutral label like `mcp: unknown-name (not found)`, leave a compatibility diagnostic (there's already a `CompatibilityDiagnostic` pipeline used elsewhere in `CliPromptPreparer`), or block the step? Silently deleting the token is off the table for the same reason full deletion was rejected for resolved names — it would erase the user's stated intent without telling them why.
7. Does `mcpServers: null` (explicit "disable inherited MCP servers") on a step suppress a `/mcp:<name>` reference typed in that same step's prompt, or does the explicit inline token always win? The skill plan doesn't resolve the equivalent `skills: null` case either — worth deciding for both at once, since they should behave consistently.
8. What does Ctrl+Click on `/mcp:playwright` actually open? There's no per-server file the way `SKILL.md` exists for skills. Options: open the MCP Manager settings page filtered/scrolled to that server (needs a new webview message and possibly a "focus server X" affordance that doesn't exist in `McpManagerSection.tsx` today), or skip document-link support for `/mcp:` in `PromptLinkProvider.ts` (VS Code) while still supporting an in-webview click target that opens the settings drawer directly.
9. Should `/mcp:ctrlyoke` be accepted as an alias for what `mcpServers: ["ctrlyoke"]` already does (enable ctrlyoke's own dynamic-queue-extension tools), given `"ctrlyoke"` is a reserved ID rather than a registry entry returned by `McpRegistryFileManager.readAll()`? If yes, the resolver needs a special case identical to the one `CliProviderUtils.planMcpConfigBlock()` already has for the literal string `"ctrlyoke"`.
10. *(Follow-on extension, design point 9)* How long should a third-party server's introspected tool list stay cached — session lifetime, or invalidated on some signal (registry entry edited, explicit "refresh" action in the completion UI)? There's no config-change event today that `McpToolIntrospector` could subscribe to; one may need to be added.
11. *(Follow-on extension, design point 9)* Should introspection be blocked for servers whose `McpServerConfig.env` references secrets that aren't currently resolvable (e.g. an unset environment variable the server needs to start), so a cold `/mcp:<server>:` completion attempt doesn't hang or crash-loop a server that isn't fully configured yet?

---

## Recommended Rollout

### Phase 1

- Add `/skill:` and `/mcp:` parsing
- Fix the bare-string MCP resolution gap (independent value even without `/mcp:` shipping)
- Add webview dropdown completions for both
- Add prompt-file and webview links for `/skill:` (defer `/mcp:` linking if Open Question 8 isn't resolved yet)
- Add prompt-preparation support for `/skill:` with outgoing rewrite
- Add property-resolution support for `/mcp:` with outgoing in-place rewrite

### Phase 2

- Add VS Code editor skill/MCP-token completions in `PromptCompletionProvider`
- Add optional UI hints when a plain `/skill` or `/mcp` collides with a ctrlyoke skill/server of the same name
- Resolve `/mcp:` linking (Open Question 8) and ship it

### Phase 3

- Revisit resume semantics so newly introduced skills/MCP servers from `/skill:`/`/mcp:` are attached even on resumed sessions while unchanged skills/servers remain omitted
- Verify PTY-retirement behavior under real interactive multi-prompt runs where a later prompt's `/mcp:` reference changes the resolved server set

### Phase 4 (separate follow-on, design point 9)

- Build the MCP client introspection module (`McpToolIntrospector`), scoped and reviewed on its own given it's the first MCP-client code in the codebase
- Wire `/mcp:ctrlyoke:<tool>` first (free — static, in-process, no new risk)
- Add cached, timeout-bounded `/mcp:<server>:<tool>` for third-party servers once the introspection module has proven reliable against real registry entries

---

## Non-Goals

- Auto-rewriting plain `/commit` or bare `/mcp` into a ctrlyoke token
- Using slash-prefixed ctrlyoke syntax that can be interpreted as a native harness command
- Attaching ctrlyoke skills or MCP servers automatically just because a harness lacks a native skill/server with that name
- Maintaining curated native slash-command catalogs for each harness
- Linking plain native slash commands to arbitrary files
- Full slash-command introspection from external CLIs at runtime
- Building a full MCP server install/approval flow through `/mcp:` — it only attaches servers that are already registered in the ctrlyoke MCP registry via the existing MCP Manager settings page
- Deleting `/skill:`/`/mcp:` tokens from the outgoing prompt with no replacement text — both are rewritten in place so any surrounding sentence (especially per-item guidance across multiple references) keeps its referent
- Eagerly introspecting every registered MCP server's tool list to populate the base `/` dropdown — tool-level completions (design point 9) are opt-in per server, triggered only by typing `/mcp:<server>:`
- Selective per-tool attachment through `/mcp:<server>:<tool>` — the whole server is still attached, same as `/mcp:<server>` alone; the `:<tool>` segment only affects completion/rewrite text
