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
4. ~~Add an "Add commit to ctrlyoke" entry to the SCM Graph's per-commit right-click menu
   (the one that already has "Add to Chat"/"Explain Changes").~~ **Blocked upstream — see
   below.** Not currently possible; kept here as a tracked want, not an active goal.

## Audit: every ctrlyoke menu contribution today

All from `package.json` `contributes.menus`:

| Menu location                  | Commands                                                                                | Group used                          |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| `explorer/context`              | `runFromContext`, `loadFromContext`, `queueFromContext`, `queueNextFromContext`, `addFileToPromptEditor`/`addDirectoryToPromptEditor` | `ctrlyoke@1`…`ctrlyoke@5` (unprefixed) |
| `editor/title`                  | `runFromContext`, `queueFromContext`, `queueNextFromContext`                              | `navigation`, `navigation@2`, `navigation@3` |
| `editor/title/context`          | `runFromContext`, `loadFromContext`, `queueFromContext`, `queueNextFromContext`, `addFileToPromptEditor` | `ctrlyoke@1`…`ctrlyoke@5` (unprefixed) |
| `editor/context`                | `addSelectionToPromptEditor`, `addSymbolToPromptEditor`                                   | `2_ctrlyoke@1`, `2_ctrlyoke@2`       |
| `editor/lineNumber/context`     | `addSelectionToPromptEditor`, `addSymbolToPromptEditor`                                   | `2_ctrlyoke@1`, `2_ctrlyoke@2`       |
| `scm/resourceState/context`     | `addScmResourcesToPromptEditor`                                                           | `2_ctrlyoke`                        |
| `scm/resourceFolder/context`    | `addScmResourcesToPromptEditor`                                                           | `2_ctrlyoke`                        |
| `timeline/item/context`         | `addTimelineCommitToPromptEditor`                                                          | `2_ctrlyoke`                        |
| `scm/title`                     | `generateCommitMessage`, `cancelCommitMessageGeneration`                                   | `navigation@-1`                     |

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
- `@<number>` after the group name only orders items *within* that same group; it has no
  effect on where the group itself falls relative to other groups.

ctrlyoke currently mixes two different naming styles across menu locations, and that's the
entire root cause of the inconsistency the user is seeing — nothing else about the menus
differs:

- **`ctrlyoke@N`** (no digit prefix) in `explorer/context` and `editor/title/context` — this
  always sorts *after* every one of VS Code's standard numbered groups, landing at the very
  bottom. This matches the "very bottom, which I actually kind of like" observation.
- **`2_ctrlyoke@N`** / **`2_ctrlyoke`** (digit-prefixed) in `editor/context`,
  `editor/lineNumber/context`, `scm/resourceState/context`, `scm/resourceFolder/context`, and
  `timeline/item/context` — this sorts *between* the early standard groups (`1_modification`
  / `1_actions`) and the late ones (`5_copy`, `9_cutcopypaste`, `z_commands`), landing in the
  upper-middle. This matches "timeline shows up in the middle" and "selection menu is 3/4 to
  the bottom" (other extensions likely add their own groups between `2_` and `9_`/`z_`,
  pushing us further down than `2_` alone would suggest).
- `editor/title` uses VS Code's own `navigation` group, which is forced first — so the
  toolbar icons there appear at the very front, a placement style that was never
  reconciled with the other two.

Fixing the *inconsistency* itself is a small, mechanical `package.json` change: pick one
group-naming convention and apply it everywhere. The interesting decision is which
convention to pick (see below).

## Research: how other extensions place chat-adjacent items

Verified directly against the real, currently-published `package.json` of
`microsoft/vscode-copilot-chat` (fetched from
`https://raw.githubusercontent.com/microsoft/vscode-copilot-chat/main/package.json`):

- Copilot's own **"Explain"/"Fix"/"Review"** actions (the chat-adjacent code actions, closest
  analogue to "Add X to ctrlyoke") use an explicit **`1_chat@4`/`1_chat@5`/`1_chat@6`** group
  in `editor/context` — deliberately placed right after VS Code's built-in `1_modification`
  group, near the *top* of the menu, not the bottom. This is a real, working example of an
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

### VS Code core's own "Add to Chat" group ids — empirically confirmed

Resolved by reading the actual VS Code source at `C:\dev\vscode` (checkout at commit
`42b84d2c`, dated 2026-09-02 — pin this if VS Code source drifts later). The "Add File/Folder/
Selection to Chat" commands are **not** a Copilot-extension feature at all — they're
registered by VS Code core itself, in
`src/vs/workbench/contrib/chat/browser/actions/chatContextActions.ts`
(`AttachFileToChatAction`, `AttachFolderToChatAction`, `AttachSelectionToChatAction`), wired up
via `registerChatContextActions()` called from `chat.shared.contribution.ts:3247`. So this is
now a directly-cited, current source location — not a guess — though it's still an internal
implementation detail with no public-API stability guarantee, so still don't treat the exact
group strings as a contract that can't change between VS Code versions.

The naming convention core uses is literally **`<sort-prefix>_chat`**, and it picks a
different prefix per menu depending on how prominent that menu's chat entry should be:

| Menu location            | Group used by core   | Action(s) / order                                                                 |
| ------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `editor/context`          | **`1_chat`**           | `AttachSelectionToChatAction` @1 (when there's a selection), `AttachFileToChatAction` @2 (when there isn't) |
| `explorer/context`        | **`5_chat`**           | `AttachFileToChatAction` @1, `AttachFolderToChatAction` @1                          |
| `editor/title/context`    | **`2_chat`**           | `AttachFileToChatAction` @1                                                         |
| `search` result context   | `z_chat` / `z_chat`@3  | `AttachFileToChatAction` @1, `AttachSearchResultAction` @3 (not a ctrlyoke menu location) |
| inline-chat affordances   | `0_chat`               | (not context menus ctrlyoke uses)                                                   |
| `editor/title` (toolbar)  | **not used at all**    | None of the attach actions register a `MenuId.EditorTitle` entry — core doesn't put "Add to Chat" in the tab-row icon toolbar |
| `editor/lineNumber/context` | **not used at all** | Confirmed via repo-wide grep for `MenuId.EditorLineNumberContext` inside `src/vs/workbench/contrib/chat/` — zero matches |
| `scm/resourceState/context`, `scm/resourceFolder/context` | **not used at all** | Confirmed via repo-wide grep for `MenuId.SCM*` inside `src/vs/workbench/contrib/chat/` — zero matches |
| `timeline/item/context`   | **not used at all**    | Confirmed via repo-wide grep for `MenuId.Timeline*` inside `src/vs/workbench/contrib/chat/` — zero matches |

Where that actually lands relative to VS Code's own standard groups (verified against
`fileActions.contribution.ts`, `editor.contribution.ts`, `clipboard.ts`,
`codeActionCommands.ts`):

- **`editor/context`**: standard groups are `1_modification` (rename/format/code actions) and
  `9_cutcopypaste` (confirmed via `CLIPBOARD_CONTEXT_MENU_GROUP = '9_cutcopypaste'` in
  `clipboard.ts`). `1_chat` sorts **before** `1_modification` (`'1_c' < '1_m'` lexicographically)
  — so "Add Selection/File to Chat" lands right after any `navigation`-grouped items (e.g. the
  Peek submenu), ahead of even VS Code's own rename/format actions. This is the most prominent
  placement of the three.
- **`explorer/context`**: standard groups include `2_workspace`, `3_compare`, `5_cutcopypaste`,
  `6_copypath`, `7_modification`, `11_share`. `5_chat` sorts **between** `3_compare` and
  `5_cutcopypaste` (`'5_chat' < '5_cutcopypaste'` since `'h' < 'u'`) — solidly mid-menu, not top
  or bottom.
- **`editor/title/context`**: standard groups include `1_close`, `1_open`, `1_cutcopypaste`,
  `1_compare`, `3_preview`, `5_split`, `7_new_window`, `11_share`. `2_chat` sorts after all the
  `1_*` groups and before `3_preview` onward — upper-middle.

**The strongest evidence that "join the shared section" is a real, current, working
convention** (not a hypothetical): the `1_chat` group in `editor/context` isn't exclusive to
VS Code core. The `microsoft/vscode-copilot-chat` extension's own "Explain"/"Fix"/"Review"
actions (see the `editor/context` research above) register into the **exact same group id**
— `1_chat@4` / `1_chat@5` / `1_chat@6` — as core's `AttachSelectionToChatAction`@1 and
`AttachFileToChatAction`@2. VS Code doesn't merge groups by extension identity; it merges by
literal group-string match. So in a stock VS Code + Copilot Chat install, those five items
render as **one continuous, interleaved section** ordered 1, 2, 4, 5, 6 — core's items and the
extension's items sharing one menu section, sorted by `order`. That's the pattern ctrlyoke
would be joining, not inventing.

**What this resolves and what it doesn't:**

- For `editor/context`, `explorer/context`, and `editor/title/context`, the exact group id to
  join (`1_chat`, `5_chat`, `2_chat` respectively) is now known and cited to a specific file/
  line, de-risking Option B for those three menu locations specifically.
- For `editor/lineNumber/context`, `scm/resourceState/context`, `scm/resourceFolder/context`,
  and `timeline/item/context`, core doesn't contribute an "Add to Chat" entry at all — there is
  no shared section to join there. Option B is simply not applicable to those four locations;
  they still need Option A (a deliberate, consistent ctrlyoke-owned placement) regardless of
  which option wins elsewhere.
- `editor/title` (the icon toolbar) is unaffected either way — core doesn't put attach actions
  there, matching this plan's existing recommendation to keep `Run` as ctrlyoke's own icon.
- Still unconfirmed and out of scope here: whether Claude Code's and Codex's own VS Code
  extensions (the ones the user specifically observed joining this section) also target
  `1_chat`/`5_chat`/`2_chat`, or contribute their own adjacent groups. That would need reading
  those extensions' own `package.json` files, not VS Code core, and isn't needed to answer the
  question this doc asked (VS Code core's group id) — but would be worth checking before
  actually implementing Option B, since "joining core's group" and "joining the section other
  AI extensions visually cluster into" are only guaranteed to be the same thing if those
  extensions also target these same literal group strings.

### Blocked: "Add commit to ctrlyoke" on the SCM Graph — not possible yet

Wanted: a ctrlyoke entry on the right-click menu for a commit row in the **SCM Graph** view
(the commit-history graph pane, distinct from `timeline/item/context`, which is per-file
history, and from `scm/resourceState/context`, which is the changed-files list). That menu
already shows VS Code's own "Add to Chat" and "Explain Changes" for a commit, so joining it
looked like the same kind of "join an existing section" move as the chat-adjacent research
above.

**Where those two items come from** (verified against the same VS Code checkout, commit
`42b84d2c`): `src/vs/workbench/contrib/scm/browser/scmHistoryChatContext.ts` registers two
`registerAction2` actions against `MenuId.SCMHistoryItemContext`:

- `workbench.scm.action.graph.addHistoryItemToChat` — "Add to Chat", group `z_chat`, order 1
- `workbench.scm.action.graph.summarizeHistoryItem` — "Explain Changes", group `z_chat`, order 2

That menu id is wired to the actual UI in `scmHistoryViewPane.ts`: `SCMHistoryViewPane`
(the SCM Graph view pane) fires `MenuId.SCMHistoryItemContext` from its tree's
`_onContextMenu` handler, passing the right-clicked `ISCMHistoryItem` (the commit) as the
action context — confirming this is exactly the "right-click a commit in the graph" menu the
ask is about.

**Why ctrlyoke can't join it today:** the extension-facing manifest key for this menu is
`scm/historyItem/context` (mapped to `MenuId.SCMHistoryItemContext` in
`menusExtensionPoint.ts`), but it's registered there with `proposed:
'contribSourceControlHistoryItemMenu'` — it is a **proposed (unstable) API**, not part of the
finalized/stable extension surface:

- Its `.d.ts` (`vscode.proposed.contribSourceControlHistoryItemMenu.d.ts`) is an empty
  placeholder pointing at tracking issue `microsoft/vscode#201997`, which is **still open** as
  of this research (checked via the GitHub issue directly) — not stabilized, no committed
  timeline.
- Only VS Code's own bundled `git` and `github` extensions declare
  `contribSourceControlHistoryItemMenu` in their `enabledApiProposals`
  (`extensions/git/package.json`, `extensions/github/package.json`).
- `product.json`'s `extensionEnabledApiProposals` — the allowlist mechanism that would let a
  specific *third-party* extension use a proposed API in a normal end-user install — has **no
  entry** for this proposal at all.

Proposed APIs only work when VS Code is launched with `--enable-proposed-api <extensionId>`
(a dev/Insiders flag, not something a normal Marketplace install does) or when the extension
id is explicitly added to that `product.json` allowlist by Microsoft — which isn't realistic
to obtain for a third-party extension. So `contributes.menus` cannot target
`scm/historyItem/context` in a ctrlyoke build that ships to real users; VS Code will simply
ignore (or refuse to load) the contribution.

As a side note: the *per-file-change* context menu inside an expanded commit row
(`MenuId.SCMHistoryItemChangeContext`) isn't exposed to extensions at all — not even under a
proposed-API name — so there's no path there either.

**What would need to be true to unblock this:** `contribSourceControlHistoryItemMenu`
stabilizes (issue `#201997` closes and the `proposed` marker is dropped from
`menusExtensionPoint.ts`) in some future VS Code release. Until then, this idea has no
implementation path via `contributes.menus`. Re-check `microsoft/vscode#201997` and re-grep
`menusExtensionPoint.ts` for `scm/historyItem/context` next time this comes up — if the
`proposed` key is gone, the menu id and existing `2_ctrlyoke`-style group-naming plan above
apply directly.

## Decision: Option A, everywhere — `z_ctrlyoke` (decided 2026-09-02)

**Chosen: bottom, always, one group name — `z_ctrlyoke`.** Every menu location that currently
uses `ctrlyoke@N` (`explorer/context`, `editor/title/context`) or `2_ctrlyoke@N`/`2_ctrlyoke`
(`editor/context`, `editor/lineNumber/context`, `scm/resourceState/context`,
`scm/resourceFolder/context`, `timeline/item/context`) normalizes to `z_ctrlyoke`, preserving
existing `@N` suffixes for within-group ordering (e.g. `z_ctrlyoke@1`, `z_ctrlyoke@2`).
`z_ctrlyoke` over the bare unprefixed `ctrlyoke` specifically to be self-documenting about
intent ("always sorts last") and to stay robust against some future `z_`-prefixed group (from
VS Code core or another extension) that a bare name has no defense against.

Two menu locations are explicitly **out of scope** for this decision, not oversights:

- `editor/title` (the icon toolbar, not a dropdown) keeps its existing `navigation`/
  `navigation@2`/`navigation@3` groups. VS Code forces `navigation` first regardless of name,
  and a toolbar has no "bottom of a sorted list" concept the way a context menu does — this
  decision doesn't apply there.
- `scm/title` (`generateCommitMessage`/`cancelCommitMessageGeneration`) keeps `navigation@-1`.
  That's a different feature (commit-message generation, not "Add X to ctrlyoke" context
  capture) that was deliberately placed at the top of the SCM title bar; not part of this
  consistency question.

**Rejected: joining the "Add to Chat" groups (`1_chat`/`5_chat`/`2_chat`).** The deciding
factor wasn't speed vs. discoverability — it's that Option B cannot deliver consistency at
all. Four of ctrlyoke's seven menu locations (`editor/lineNumber/context`, both SCM menus,
`timeline/item/context`) have no chat-adjacent group to join in the first place — VS Code
core never contributes one there — so picking B anywhere would leave ctrlyoke split across two
different placements depending on menu, reintroducing the exact inconsistency this plan exists
to fix. On top of that: bottom placement is validated by Nathan's own prior reaction ("very
bottom, which I actually kind of like") and his stated preference for a fixed, scan-free
position over faster day-to-day use; joining the chat groups would put ctrlyoke in a crowded,
top-of-menu slot it doesn't control (interleaved by `order` with Copilot/Claude/Codex/whatever
ships next) and couples placement to an undocumented VS Code internal that could shift between
versions with no changelog entry. The "new users expect it in the chat section" concern is
real but is better solved with a one-time discoverability nudge (README line, first-run tip)
than by chasing another product's menu position permanently.

## Submenu collapsing for prompt/workflow file commands

Add a `contributes.submenus` entry:

```json
{ "id": "ctrlyoke.runSubmenu", "label": "Run with ctrlyoke", "icon": "$(play)" }
```

Then, in `explorer/context`, `editor/title`, and `editor/title/context`, replace the four
flat entries for `runFromContext` / `loadFromContext` / `queueFromContext` /
`queueNextFromContext` with:

- one top-level entry: `{ "submenu": "ctrlyoke.runSubmenu", "group": "z_ctrlyoke", "when": "<existing file-pattern when>" }`
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
currently loaded, and it runs under *that* workflow's settings. This matches the user's
description exactly and is not a bug — `dev/implemented/QUEUE_APPEND_FEATURE.md` confirms it
was designed this way on purpose (steps-only, so the same primitive
(`PromptQueue.appendPrompts()`) backs both the manual context-menu action and the MCP
`append_queue`/`flightpath_append_queue` tool AI agents use to dynamically extend a running
queue). The MCP-facing capability is intentional and out of scope here; the concern is
specifically whether right-clicking a *whole workflow file* and offering "Queue"/"Queue Next"
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

| File | Role |
| --- | --- |
| `package.json` | `contributes.menus` group renames, new `contributes.submenus` entry, submenu children, possibly reworded command titles/tooltips, possibly narrowed `when` clauses for Queue/Queue Next |
| `src/extension.ts` | Likely unchanged — command registrations stay the same; only menu wiring moves. Only touched if Queue/Queue Next options end up gated behind a new context key (e.g. "workflow currently loaded") rather than just a file-pattern `when`. |
| `dev/reference/VSCODE_COMMANDS.md`, `README.md`, `QUICK_START.md`, `docs/reference/commands.md` | Reference the current command titles/menu locations; need updates to match whatever titles/placement land (found via grep for `queueFromContext`/`queueNextFromContext`/their current titles — not yet read in detail). |

## Non-Goals

- Changing the underlying `PromptQueue.appendPrompts()` / MCP `append_queue` behavior itself.
  This plan only touches how the *file-context-menu* entry points present that capability.
- Redesigning `WorkflowPropertiesPanel` or workflow-vs-prompt settings inheritance.
- Joining VS Code core's "Add to Chat" groups (`1_chat`/`5_chat`/`2_chat`) — considered,
  empirically de-risked, and explicitly **rejected** (see the Decision section above), not
  merely deferred. Consistency wins: four of seven menu locations have no chat-adjacent group
  to join at all, so this option could never be applied uniformly.
- Adding an "Add commit to ctrlyoke" entry to the SCM Graph's commit context menu — not a
  scope decision, it's **blocked upstream** by an unstabilized proposed API
  (`contribSourceControlHistoryItemMenu`, tracked in `microsoft/vscode#201997`); see the
  "Blocked: 'Add commit to ctrlyoke' on the SCM Graph" section above. Revisit only once that
  API stabilizes.

## Open Questions

- ~~Confirm VS Code core's actual "Add to Chat" group id before considering Option B.~~
  **Resolved above** — `1_chat` (`editor/context`), `5_chat` (`explorer/context`), `2_chat`
  (`editor/title/context`); no equivalent exists for `editor/lineNumber/context`, either SCM
  menu, or `timeline/item/context`.
- ~~Which placement option (A or B) does Nathan want, per menu location?~~ **Decided** —
  Option A, `z_ctrlyoke`, everywhere. See the Decision section above. Not yet implemented in
  `package.json`.
- For the submenu: does `Run` stay as its own `editor/title` icon, or does everything
  (including `Run`) move into the submenu for total consistency with the context-menu
  version?
- Queue/Queue Next: option 1, 2, or 3 above — or cut entirely and rely on the MCP tool /
  manual drag-in-dashboard for the "extend a running workflow" use case?
- Should Queue/Queue Next (wherever they remain) be gated on "a workflow is actually loaded/
  running" via a context key, similar to how Copilot gates its CLI file-reference commands on
  `hasSession`, instead of showing unconditionally whenever the file pattern matches?
