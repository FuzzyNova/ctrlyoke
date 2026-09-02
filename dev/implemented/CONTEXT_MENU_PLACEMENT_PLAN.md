# Context Menu Placement & Consistency Plan

> **Status:** The `package.json` group rename, Run with ctrlyoke submenu collapse, Queue title
> rewording, and Queue/Queue Next context-key gating have landed, along with documentation
> updates. The SCM Graph item remains blocked upstream.

## Goal

1. Explain why ctrlyoke's context-menu items land in different positions (bottom / middle
   / near-top) depending on which menu they're in, and decide a consistent, deliberate
   placement strategy.
2. Collapse the workflow/prompt-file commands (`Run`, `Load`, `Queue`, `Queue Next`) into a
   single "Run with ctrlyoke" submenu instead of four flat entries.
3. ~~Resolve whether `Queue`/`Queue Next` should be removed for `.ctrlyoke.{yaml,yml,json}`
   workflow files, kept only for `.prompt.md`, or kept everywhere with clearer wording.~~
   **Decided** — kept everywhere, retitled to "Queue Steps with ctrlyoke" / "Queue Steps Next
   with ctrlyoke". See "Queue / Queue Next: problem and options" below.
4. ~~Add an "Add commit to ctrlyoke" entry to the SCM Graph's per-commit right-click menu
   (the one that already has "Add to Chat"/"Explain Changes").~~ **Blocked upstream — see
   below.** Not currently possible; kept here as a tracked want, not an active goal.

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

| Menu location                                             | Group used by core    | Action(s) / order                                                                                                             |
| --------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `editor/context`                                          | **`1_chat`**          | `AttachSelectionToChatAction` @1 (when there's a selection), `AttachFileToChatAction` @2 (when there isn't)                   |
| `explorer/context`                                        | **`5_chat`**          | `AttachFileToChatAction` @1, `AttachFolderToChatAction` @1                                                                    |
| `editor/title/context`                                    | **`2_chat`**          | `AttachFileToChatAction` @1                                                                                                   |
| `search` result context                                   | `z_chat` / `z_chat`@3 | `AttachFileToChatAction` @1, `AttachSearchResultAction` @3 (not a ctrlyoke menu location)                                     |
| inline-chat affordances                                   | `0_chat`              | (not context menus ctrlyoke uses)                                                                                             |
| `editor/title` (toolbar)                                  | **not used at all**   | None of the attach actions register a `MenuId.EditorTitle` entry — core doesn't put "Add to Chat" in the tab-row icon toolbar |
| `editor/lineNumber/context`                               | **not used at all**   | Confirmed via repo-wide grep for `MenuId.EditorLineNumberContext` inside `src/vs/workbench/contrib/chat/` — zero matches      |
| `scm/resourceState/context`, `scm/resourceFolder/context` | **not used at all**   | Confirmed via repo-wide grep for `MenuId.SCM*` inside `src/vs/workbench/contrib/chat/` — zero matches                         |
| `timeline/item/context`                                   | **not used at all**   | Confirmed via repo-wide grep for `MenuId.Timeline*` inside `src/vs/workbench/contrib/chat/` — zero matches                    |

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
  specific _third-party_ extension use a proposed API in a normal end-user install — has **no
  entry** for this proposal at all.

Proposed APIs only work when VS Code is launched with `--enable-proposed-api <extensionId>`
(a dev/Insiders flag, not something a normal Marketplace install does) or when the extension
id is explicitly added to that `product.json` allowlist by Microsoft — which isn't realistic
to obtain for a third-party extension. So `contributes.menus` cannot target
`scm/historyItem/context` in a ctrlyoke build that ships to real users; VS Code will simply
ignore (or refuse to load) the contribution.

As a side note: the _per-file-change_ context menu inside an expanded commit row
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

- one top-level entry: `{ "submenu": "ctrlyoke.runSubmenu", "group": "z_ctrlyoke@1", "when": "<existing file-pattern when>" }`
- the four commands re-declared as children under `"ctrlyoke.runSubmenu"` in
  `contributes.menus`, each keeping its own `when` clause (all four already share the same
  file-pattern `when`, so this is a straight move, not a behavior change)

This directly satisfies the "collapse into a submenu" ask, and as a side effect reduces
ctrlyoke's footprint in the flat `explorer/context` menu from 5 entries to 2
(`ctrlyoke.runSubmenu` + `addFileToPromptEditor`/`addDirectoryToPromptEditor`), which makes
whichever placement option is chosen above easier to live with.

**Decided (2026-09-02): both remaining entries sit at the bottom, submenu directly above
"Add."** Today, right-clicking a `.ctrlyoke.json` file shows 5 flat ctrlyoke items (Run, Load,
Queue, Queue Next, Add). After the collapse it's 2 — the `ctrlyoke.runSubmenu` (containing
Run/Load/Queue Steps/Queue Steps Next) and `addFileToPromptEditor`/`addDirectoryToPromptEditor`
— both in the `z_ctrlyoke` group per the placement decision above, with the submenu ordered
directly above "Add": `z_ctrlyoke@1` for the submenu entry, `z_ctrlyoke@2` for
`addFileToPromptEditor`/`addDirectoryToPromptEditor` (bumped from today's `ctrlyoke@5`). Same
ordering applies to `editor/title/context`, which has the identical 5-item pattern minus the
directory variant.

### Decided (2026-09-02): `editor/title` also collapses to one dropdown button, all 4 options

**Superseded the earlier "keep `Run` as its own icon" lean below** — `editor/title` gets the
same `ctrlyoke.runSubmenu` as a single toolbar button, containing all four: Run, **Load**,
Queue Steps, Queue Steps Next.

Confirmed possible by reading VS Code source directly (`C:\dev\vscode`, commit `42b84d2c`):
`editor/title` supports submenu entries from extensions — checked `menusExtensionPoint.ts:50-54`,
the `editor/title` `apiMenus` entry has no `supportsSubmenus: false` override (unlike
`commandPalette`/`touchBar`, which explicitly disable it), so it defaults to allowing them
(`supportsSubmenus` "defaults to true", `menusExtensionPoint.ts:34`). VS Code's own **"Run or
Debug..."** button is the exact working precedent:

```ts
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
  submenu: MenuId.EditorTitleRun,
  title: "Run or Debug...",
  icon: icons.debugRun,
  group: "navigation",
  order: -1,
  isSplitButton: { togglePrimaryAction: true },
});
```

(`debug.contribution.ts:257`) — one toolbar icon; clicking it opens a dropdown of the
submenu's children. Implementation is one more placement of the already-planned
`ctrlyoke.runSubmenu`:

```json
{
  "submenu": "ctrlyoke.runSubmenu",
  "group": "navigation",
  "when": "<existing file-pattern when>"
}
```

replacing today's three separate `editor/title` icons (`navigation`/`navigation@2`/
`navigation@3` for Run/Queue/Queue Next — note Load was never in the toolbar at all before this
change, only in the dropdown menus; this is a net addition, not a like-for-like swap).

**One confirmed limitation:** VS Code's `isSplitButton` (the property that lets a _single
click_ run the last-used option while a separate small chevron opens the dropdown for the
rest) is internal-only — defined in `src/vs/platform/actions/common/actions.ts:48`, and
absent from every property list in `menusExtensionPoint.ts`'s extension-facing schema. A
third-party extension cannot request it. ctrlyoke's toolbar button will be a plain
click-to-open-dropdown (every click opens the list of 4; no single-click "run last used"
shortcut) — still exactly the outcome asked for ("one icon, four options"), just without that
one polish detail VS Code reserves for itself.

`editor/title` is unaffected by the `z_ctrlyoke` placement decision above — it keeps
`navigation` (VS Code forces that group first regardless of name, and a toolbar has no "bottom
of a sorted list" concept).

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

### Decided: keep everywhere, reword (2026-09-02)

**Chosen: Option 2 — keep `Queue`/`Queue Next` for both `.ctrlyoke.*` and `.prompt.md`, reword
the titles to make the "steps only" semantics explicit at the point of use.** No `when`-clause
narrowing by file type; this is a wording fix, not a scope cut.

**Tooltips are not available — checked against VS Code's actual manifest schema, not assumed.**
Read `menusExtensionPoint.ts` directly (`C:\dev\vscode`, commit `42b84d2c`): a `contributes.commands`
item's schema (`commandType`, line 851) allows exactly `command`, `title`, `shortTitle`,
`category`, `enablement`, `icon` — no `description`/`markdownDescription`/`tooltip` field. A
`contributes.menus` item's schema (`menuItem`, line 685) allows exactly `command`, `alt`,
`when`, `group` — same story. **There is no manifest-level tooltip mechanism for either a
command or a menu entry.** The `title` string is the only lever for a dropdown row. The one
exception: `editor/title`'s icon-only toolbar buttons render their command's `title` as a
native hover tooltip (there's no visible text label there to read instead) — and Queue/Queue
Next already appear in `editor/title` per the audit table, so the reworded title improves that
surface for free, it isn't a separate change.

**New titles** (each command has one `title` in `contributes.commands`, shared across every
menu location that references it — `explorer/context`, `editor/title`, `editor/title/context`
all update from a single edit):

| Command                         | Old title                  | New title                            |
| ------------------------------- | -------------------------- | ------------------------------------ |
| `ctrlyoke.queueFromContext`     | "Queue with ctrlyoke"      | **"Queue Steps with ctrlyoke"**      |
| `ctrlyoke.queueNextFromContext` | "Queue Next with ctrlyoke" | **"Queue Steps Next with ctrlyoke"** |

Matches the existing naming pattern (`Run with ctrlyoke`, `Load in ctrlyoke`) rather than
introducing a new phrasing style. "Steps" is the one word doing the disambiguating work — it's
the only signal available given there's nowhere to put the fuller "harness/model/end-conditions
are not applied" explanation from the options considered below. If that fuller explanation
turns out to matter in practice, the only manifest-level place it could go is the extension's
own `README.md`/`CHANGELOG.md` (surfaced on the extension's Marketplace/details page, not at
the point of use) — not a per-item tooltip, since none exists.

Options considered and not chosen:

1. **Remove for workflow files, keep for prompt files.** Drop `Queue`/`Queue Next` from the
   `when` clause for `.ctrlyoke.{yaml,yml,json}`, keep them for `.prompt.md`. Rejected —
   Nathan is fine leaving Queue/Queue Next available for workflow files too; a wording fix
   covers the actual confusion without cutting a capability some users may rely on.
2. **Hybrid.** Reword only for `.ctrlyoke.*`, keep the old wording for `.prompt.md`. Rejected
   for the same reason Option 2 was chosen outright — keeping two different titles for the same
   command depending on invoking file type adds complexity (title becomes conditional on `when`
   context, which `contributes.commands` doesn't support per-menu-location anyway — see the
   schema finding above) for a distinction that doesn't need to survive.

### Decided (2026-09-02): gate Queue/Queue Next on an active, non-empty queue

**Chosen: yes, gate both behind a new context key — only show them when there's actually
something to append to.** This isn't just a UX nicety; it fixes a confirmed behavioral bug in
what "Queue" currently does, not just how it's worded.

Read `WorkflowInstance.appendFromFile` directly (`src/core/WorkflowInstance.ts:2493-2525`):

```ts
const queueState = this.promptQueue.getState();
const currentSize = queueState.steps.length;

if (currentSize === 0) {
  // ...
  await this.initializeNewWorkflow(parsed.steps, ..., true, ...);   // ← identical to Load
  return;
}
// ... only past this point does it actually append to the existing queue
```

When nothing is currently queued — the common case, since the toolbar/menu is available any
time a `.ctrlyoke.*`/`.prompt.md` file is open, regardless of dashboard state — "Queue" doesn't
append anything; it calls the exact same `initializeNewWorkflow` path "Load" uses. It only
behaves as a true _append_ once the queue already holds at least one step. So today, "Queue"
is functionally identical to "Load" most of the time it's actually clicked — confirmed in
code, not just an impression from the naming.

**Gating on "queue already has steps" fixes this directly**: hide Queue/Queue Next entirely
until `currentSize > 0`, so the only time either command is visible is the only time it does
something distinct from Load. This is the same shape as the precedent already cited in this
doc's own research — Copilot's CLI file-reference commands gate on `hasSession` so they don't
appear until they'd do something meaningful.

**What this needs, concretely:** a new VS Code context key (working name:
`ctrlyoke.hasQueuedSteps`), since ctrlyoke doesn't have an equivalent one today — the only
existing `setContext` calls in the codebase are `ctrlyoke.devMode` (`src/dev/DevCommands.ts:571`)
and the commit-message-generation key used by `scm/title` (`src/scm/ScmCommitCommand.ts`), grepped
directly, nothing queue-related exists yet. `PromptQueue` already exposes
`onDidChangeState` (`src/core/PromptQueue.ts:127`) as an event emitter — the natural place to
wire this is a listener on that event (scoped to the currently _active_ instance, since the
toolbar/menu reflects whichever workflow is loaded in the dashboard, not the right-clicked
file) that calls `vscode.commands.executeCommand('setContext', 'ctrlyoke.hasQueuedSteps',
steps.length > 0)` on every change, plus an initial call on activation/instance-switch so the
key isn't stale before the first queue-state event fires.

Every `when` clause for `queueFromContext`/`queueNextFromContext` — `explorer/context`,
`editor/title/context`, and the new `editor/title` submenu child — gets `&&
ctrlyoke.hasQueuedSteps` appended to its existing file-pattern condition. This is a real
implementation task (new context key, new listener wiring), not just a manifest edit — flagged
in Affected Files below.

## Affected files (implementation status)

| File                                                                                                                         | Role                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                                                                               | **Done:** `contributes.menus` group renames to `z_ctrlyoke`, the `ctrlyoke.runSubmenu` definition and its `explorer/context`/`editor/title/context`/`editor/title` placements, shared submenu children, reworded Queue/Queue Next titles, and `ctrlyoke.hasQueuedSteps` gating for Queue/Queue Next. |
| `src/types/DashboardConstants.ts`, `src/core/WorkflowOrchestrator.ts`, `src/extension.ts`                                    | **Done:** expose the active queue-state event, update it on active-instance and queue-state changes, initialize `ctrlyoke.hasQueuedSteps`, and register its disposable during extension activation.                                                                                                  |
| `dev/reference/VSCODE_COMMANDS.md`, `README.md`, `QUICK_START.md`, `docs/guide/quick-start.md`, `docs/reference/commands.md` | **Done:** reference the current command titles and Run with ctrlyoke submenu locations, including that Queue Steps/Queue Steps Next are hidden until the active queue already has steps.                                                                                                             |

## Non-Goals

- Changing the underlying `PromptQueue.appendPrompts()` / MCP `append_queue` behavior itself.
  This plan only touches how the _file-context-menu_ entry points present that capability.
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
  Option A, `z_ctrlyoke`, everywhere. See the Decision section above. Implemented in
  `package.json`.
- ~~For the submenu, where do the two remaining entries land in `explorer/context`/
  `editor/title/context`?~~ **Decided** — both at the bottom (`z_ctrlyoke`), submenu directly
  above "Add" (`z_ctrlyoke@1`/`z_ctrlyoke@2`). See "Submenu collapsing" above.
- ~~Does `Run` stay as its own `editor/title` icon, or does everything move into the submenu
  there too?~~ **Decided** — everything, including `Run` and (newly) `Load`. `editor/title`
  collapses to one `ctrlyoke.runSubmenu` dropdown button containing all 4 options, confirmed
  possible via VS Code's own "Run or Debug..." precedent. See "Decided: `editor/title` also
  collapses to one dropdown button" above.
- ~~Queue/Queue Next: option 1, 2, or 3 above?~~ **Decided** — kept everywhere, retitled
  ("Queue Steps with ctrlyoke" / "Queue Steps Next with ctrlyoke").
- ~~Should Queue/Queue Next be gated on "a workflow is actually loaded" via a context key?~~
  **Decided** — yes. New context key `ctrlyoke.hasQueuedSteps`, gates on the active queue
  already having at least one step (the exact condition under which Queue actually appends
  instead of behaving like Load — see "Decided: gate Queue/Queue Next on an active, non-empty
  queue" above).

All open questions in this doc are now resolved. The package group rename, submenu collapse,
title rewording, and `ctrlyoke.hasQueuedSteps` implementation are landed.
