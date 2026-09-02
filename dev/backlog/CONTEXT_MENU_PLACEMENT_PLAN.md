# Context Menu Placement & Consistency Plan

> **Status:** Research only — no code changes yet. This doc captures the audit and
> brainstorming requested before any implementation work starts.

## Goal

1. Explain why ctrlyoke's context-menu items land in different positions (bottom / middle
   / near-top) depending on which menu they're in, and decide a consistent, deliberate
   placement strategy.
2. Collapse the workflow/prompt-file commands (`Run`, `Load`, `Queue`, `Queue Next`) into a
   single "Run with ctrlyoke" submenu instead of four flat entries.
3. Resolve whether `Queue`/`Queue Next` should be removed for `.ctrlyoke.{yaml,yml,json}`
   workflow files, kept only for `.prompt.md`, or kept everywhere with clearer wording.

## Audit: every ctrlyoke menu contribution today

All from `package.json` `contributes.menus`:

| Menu location                | Commands                                                                                                                              | Group used                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `explorer/context`           | `runFromContext`, `loadFromContext`, `queueFromContext`, `queueNextFromContext`, `addFileToPromptEditor`/`addDirectoryToPromptEditor` | `ctrlyoke@1`…`ctrlyoke@5` (unprefixed)       |
| `editor/title`               | `runFromContext`, `queueFromContext`, `queueNextFromContext`                                                                          | `navigation`, `navigation@2`, `navigation@3` |
| `editor/title/context`       | `runFromContext`, `loadFromContext`, `queueFromContext`, `queueNextFromContext`, `addFileToPromptEditor`                              | `ctrlyoke@1`…`ctrlyoke@5` (unprefixed)       |
| `editor/context`             | `addSelectionToPromptEditor`, `addSymbolToPromptEditor`                                                                               | `2_ctrlyoke@1`, `2_ctrlyoke@2`               |
| `editor/lineNumber/context`  | `addSelectionToPromptEditor`, `addSymbolToPromptEditor`                                                                               | `2_ctrlyoke@1`, `2_ctrlyoke@2`               |
| `scm/resourceState/context`  | `addScmResourcesToPromptEditor`                                                                                                       | `2_ctrlyoke`                                 |
| `scm/resourceFolder/context` | `addScmResourcesToPromptEditor`                                                                                                       | `2_ctrlyoke`                                 |
| `timeline/item/context`      | `addTimelineCommitToPromptEditor`                                                                                                     | `2_ctrlyoke`                                 |
| `scm/title`                  | `generateCommitMessage`, `cancelCommitMessageGeneration`                                                                              | `navigation@-1`                              |

## Why placement is inconsistent — the actual mechanism

VS Code sorts a context menu by group, not by extension. Per the
[contribution points reference](https://code.visualstudio.com/api/references/contribution-points):

- The `navigation` group is always rendered first, regardless of its name's lexicographic
  position.
- Every other group sorts **lexicographically as a plain string**. Digits (`0`–`9`, ASCII
  0x30–0x39) sort before lowercase letters (`a`–`z`, ASCII 0x61–0x7A), so any group whose
  name starts with a digit prefix (VS Code's own conventional groups: `2_workspace`,
  `3_compare`, `4_search`, `5_cutcopypaste`, `6_copypath`, `7_modification` for
  `explorer/context`; `1_modification`, `9_cutcopypaste`, `z_commands` for `editor/context`)
  sorts before any unprefixed or letter-prefixed group name.
- `@<number>` after the group name only orders items _within_ that same group; it has no
  effect on where the group itself falls relative to other groups.

ctrlyoke currently mixes two different naming styles across menu locations, and that's the
entire root cause of the inconsistency the user is seeing — nothing else about the menus
differs:

- **`ctrlyoke@N`** (no digit prefix) in `explorer/context` and `editor/title/context` — this
  always sorts _after_ every one of VS Code's standard numbered groups, landing at the very
  bottom. This matches the "very bottom, which I actually kind of like" observation.
- **`2_ctrlyoke@N`** / **`2_ctrlyoke`** (digit-prefixed) in `editor/context`,
  `editor/lineNumber/context`, `scm/resourceState/context`, `scm/resourceFolder/context`, and
  `timeline/item/context` — this sorts _between_ the early standard groups (`1_modification`
  / `1_actions`) and the late ones (`5_copy`, `9_cutcopypaste`, `z_commands`), landing in the
  upper-middle. This matches "timeline shows up in the middle" and "selection menu is 3/4 to
  the bottom" (other extensions likely add their own groups between `2_` and `9_`/`z_`,
  pushing us further down than `2_` alone would suggest).
- `editor/title` uses VS Code's own `navigation` group, which is forced first — so the
  toolbar icons there appear at the very front, a placement style that was never
  reconciled with the other two.

Fixing the _inconsistency_ itself is a small, mechanical `package.json` change: pick one
group-naming convention and apply it everywhere. The interesting decision is which
convention to pick (see below).

## Research: how other extensions place chat-adjacent items

Verified directly against the real, currently-published `package.json` of
`microsoft/vscode-copilot-chat` (fetched from
`https://raw.githubusercontent.com/microsoft/vscode-copilot-chat/main/package.json`):

- Copilot's own **"Explain"/"Fix"/"Review"** actions (the chat-adjacent code actions, closest
  analogue to "Add X to ctrlyoke") use an explicit **`1_chat@4`/`1_chat@5`/`1_chat@6`** group
  in `editor/context` — deliberately placed right after VS Code's built-in `1_modification`
  group, near the _top_ of the menu, not the bottom. This is a real, working example of an
  extension intentionally choosing a specific, purpose-named group rather than defaulting to
  the bottom.
- Copilot's own **"Add file/selection to [Copilot CLI] session"** commands
  (`github.copilot.chat.copilotCLI.addFileReference` / `addSelection`) use an **unprefixed
  `copilot`** group in `explorer/context`, `editor/context`, and `editor/title/context` — the
  exact same "sorts after every standard numbered group" pattern ctrlyoke's `ctrlyoke@N`
  groups have today. Notably, though, those entries are gated with
  `"when": "github.copilot.chat.copilotCLI.hasSession"` — they don't appear in the menu at
  all until a CLI session is active, so their bottom-of-menu position matters much less; the
  menu is otherwise uncluttered.
- VS Code's own **native "Add File/Selection to Chat"** items — the ones that always show,
  and that the user observed Claude's and Codex's VS Code extensions apparently join — are
  **not** contributed by `vscode-copilot-chat`'s `package.json` at all (confirmed absent from
  the full `contributes.menus` dump). They ship as part of **VS Code core itself**. That means
  their exact group id is not discoverable from any public extension manifest — it lives in
  VS Code's own compiled TypeScript source. **Do not hardcode a guessed group name to "join"
  that section** without first confirming it empirically (e.g. run VS Code from source and
  grep `chatContextActions.ts`/`chatContext.contribution.ts`, or use a menu-inspection tool
  in a dev build). It's also an internal/undocumented detail VS Code could change between
  versions, which is a real coupling risk even once confirmed.
- VS Code supports **`contributes.submenus`** + a menu entry that has `"submenu": "<id>"`
  instead of `"command"`. Confirmed via Copilot Chat's own use of this pattern for its
  review-comment "additional actions" flyouts (`copilot/reviewComment/additionalActions/*`).
  This is the exact mechanism needed for the "Run with ctrlyoke" submenu collapse.

## Decision needed: placement strategy

**Option A — Normalize everywhere to "trailing, but consistent."**
Change the digit-prefixed groups (`editor/context`, `editor/lineNumber/context`,
`scm/resourceState/context`, `scm/resourceFolder/context`, `timeline/item/context`) to an
unprefixed or late-sorting name (e.g. `ctrlyoke` to match the existing `explorer/context` /
`editor/title/context` style, or `z_ctrlyoke` to be unambiguous about intent) so every menu
location lands after VS Code's own standard groups. Low risk, no dependency on undocumented
VS Code internals, and matches the placement the user already said they like. `editor/title`
would need a separate decision since it's forced into `navigation`.

**Option B — Join the shared "chat-adjacent" section other AI extensions use.**
Higher payoff (matches the convention users are already forming a mental model around from
Copilot/Claude/Codex), but requires first empirically confirming the actual VS Code-core
group id — which is not currently known and isn't part of any public contract, so it could
change without notice.

**Recommendation:** ship Option A first — it's the mechanical fix for the actual complaint
raised (inconsistency), costs one `package.json` pass, and has zero dependency risk. Track
Option B as a separate, explicitly-scoped follow-up investigation (its own backlog item)
that starts with empirically confirming the core group id before committing to it.

## Submenu collapsing for prompt/workflow file commands

Add a `contributes.submenus` entry:

```json
{ "id": "ctrlyoke.runSubmenu", "label": "Run with ctrlyoke", "icon": "$(play)" }
```

Then, in `explorer/context`, `editor/title`, and `editor/title/context`, replace the four
flat entries for `runFromContext` / `loadFromContext` / `queueFromContext` /
`queueNextFromContext` with:

- one top-level entry: `{ "submenu": "ctrlyoke.runSubmenu", "group": "<chosen group>", "when": "<existing file-pattern when>" }`
- the four commands re-declared as children under `"ctrlyoke.runSubmenu"` in
  `contributes.menus`, each keeping its own `when` clause (all four already share the same
  file-pattern `when`, so this is a straight move, not a behavior change)

This directly satisfies the "collapse into a submenu" ask, and as a side effect reduces
ctrlyoke's footprint in the flat `explorer/context` menu from 5 entries to 2
(`ctrlyoke.runSubmenu` + `addFileToPromptEditor`/`addDirectoryToPromptEditor`), which makes
whichever placement option is chosen above easier to live with.

`editor/title` (the icon toolbar, not a dropdown context menu) should probably keep `Run` as
its own icon button rather than folding it into the submenu — a toolbar submenu still costs a
click-and-hover just like today's icon does, and `Run` is the single most common action, so
collapsing it away would add friction to the primary path. `Queue`/`Queue Next` icons in
`editor/title` are candidates to drop from the toolbar and only offer via the submenu,
pending the decision below.

## Queue / Queue Next: problem and options

Confirmed by reading the implementation (`WorkflowInstance.appendFromFile`,
`src/core/WorkflowInstance.ts:2493`, and `WorkflowOrchestrator.appendFromFile` /
`appendFromFileForClient`, `src/core/WorkflowOrchestrator.ts:1848`): both commands call
`promptFileParser.parsePromptFile(filePath)` and only ever read `parsed.steps` off the
result. Every workflow-level property in the source file — harness, model, agent,
end-condition defaults, retry/timeout overrides, everything in `WorkflowPropertiesPanel`'s
scope — is silently discarded. Only the step list is appended to whichever workflow is
currently loaded, and it runs under _that_ workflow's settings. This matches the user's
description exactly and is not a bug — `dev/implemented/QUEUE_APPEND_FEATURE.md` confirms it
was designed this way on purpose (steps-only, so the same primitive
(`PromptQueue.appendPrompts()`) backs both the manual context-menu action and the MCP
`append_queue`/`flightpath_append_queue` tool AI agents use to dynamically extend a running
queue). The MCP-facing capability is intentional and out of scope here; the concern is
specifically whether right-clicking a _whole workflow file_ and offering "Queue"/"Queue Next"
is the right UX, given that a `.ctrlyoke.yaml/.json` file reads as "a workflow" to a user, not
"a list of steps."

Options:

1. **Remove for workflow files, keep for prompt files.** Drop `Queue`/`Queue Next` from the
   `when` clause for `.ctrlyoke.{yaml,yml,json}`, keep them for `.prompt.md`. Rationale: a
   `.prompt.md` file doesn't have a separate "workflow settings" object the way
   `.ctrlyoke.*` files do (harness/model/etc. live at the top of the same file as the steps,
   and the feature was arguably designed around this shape), so silently dropping
   "everything but steps" is a smaller, more defensible gap for that file type.
2. **Keep for both, reword.** Retitle to make the "steps only" semantics explicit at the
   point of use, e.g. `Queue Steps from Workflow` / `Queue Steps Next`, with a
   `markdownDescription`-style tooltip such as: "Appends this file's steps to the currently
   loaded workflow. Only the step list carries over — harness, model, and other
   workflow-level settings from this file are not applied." Keeps the capability available
   everywhere, at the cost of two menu items competing with `Run`/`Load` for space.
3. **Hybrid.** Keep the current wording for `.prompt.md`; apply option 2's reworded
   titles/tooltips only for `.ctrlyoke.*` files, since that's where the "I expected the whole
   workflow's settings to apply" surprise is most likely.

No recommendation locked in yet — this is the open brainstorming item to resolve with
Nathan before implementation.

## Affected files (once a direction is picked)

| File                                                                                            | Role                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                                                  | `contributes.menus` group renames, new `contributes.submenus` entry, submenu children, possibly reworded command titles/tooltips, possibly narrowed `when` clauses for Queue/Queue Next                                                   |
| `src/extension.ts`                                                                              | Likely unchanged — command registrations stay the same; only menu wiring moves. Only touched if Queue/Queue Next options end up gated behind a new context key (e.g. "workflow currently loaded") rather than just a file-pattern `when`. |
| `dev/reference/VSCODE_COMMANDS.md`, `README.md`, `QUICK_START.md`, `docs/reference/commands.md` | Reference the current command titles/menu locations; need updates to match whatever titles/placement land (found via grep for `queueFromContext`/`queueNextFromContext`/their current titles — not yet read in detail).                   |

## Non-Goals

- Changing the underlying `PromptQueue.appendPrompts()` / MCP `append_queue` behavior itself.
  This plan only touches how the _file-context-menu_ entry points present that capability.
- Redesigning `WorkflowPropertiesPanel` or workflow-vs-prompt settings inheritance.
- Matching VS Code core's undocumented "Add to Chat" group id without first empirically
  verifying it (see Option B above) — that's a separate follow-up, not part of this plan's
  first pass.

## Open Questions

- Which placement option (A or B) does Nathan want, per menu location — does "kind of like
  being easy to find at the bottom" win out everywhere, or only for some menus?
- For the submenu: does `Run` stay as its own `editor/title` icon, or does everything
  (including `Run`) move into the submenu for total consistency with the context-menu
  version?
- Queue/Queue Next: option 1, 2, or 3 above — or cut entirely and rely on the MCP tool /
  manual drag-in-dashboard for the "extend a running workflow" use case?
- Should Queue/Queue Next (wherever they remain) be gated on "a workflow is actually loaded/
  running" via a context key, similar to how Copilot gates its CLI file-reference commands on
  `hasSession`, instead of showing unconditionally whenever the file pattern matches?
