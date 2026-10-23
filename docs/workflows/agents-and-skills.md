# Agents and skills

Agents and skills let you add reusable instruction layers without copying the same guidance into every workflow.

Workflow `agent` and `skills` fields are portable ctrlyoke prompt attachments.
ctrlyoke reads the agent or skill file itself and delivers the content with the
prompt, so it works the same way on every harness. Agent content is wrapped in
`<agentInstructions>` tags. These fields do not depend on any harness-native
discovery feature.

For the full conditional-capability boundary, see the [generated harness
compatibility matrix](/harnesses/compatibility). It excludes these portable
attachments and explains how they differ from optional native discovery.

## Agent

`agent` selects one custom agent by name.

```yaml
agent: ctrlyoke-workflow-composer
```

The schema expects the bare name, not a file path or extension: letters,
digits, `-`, and `_` only. `ctrlyoke-workflow-composer` refers to
`ctrlyoke-workflow-composer.agent.md`.

ctrlyoke discovers agents from `*.agent.md` files, and from plain `*.md` files
whose frontmatter has a `name` or `description`. It searches these locations
in order, and the first agent with a matching name wins:

1. `.ctrlyoke/agents/` in the workspace, which no harness scans natively
2. `~/.ctrlyoke/agents/`
3. the VS Code user `prompts` directory
4. each harness's own user agents directory (`~/.claude/agents/`,
   `~/.copilot/agents/`, `~/.codex/agents/`, `~/.gemini/agents/`,
   `~/.config/opencode/agents/`, and `~/.qwen/agents/`), then `~/.agents/`
5. workspace harness directories: `.github/agents/`, `.claude/agents/`,
   `.agents/`, `.opencode/agents/`, and `.qwen/agents/`
6. the agents bundled with ctrlyoke, such as `ctrlyoke-workflow-composer`,
   `ctrlyoke-tech-support`, `workflow-orchestrator`, and `test-repair`

Put an agent with the same name in any of the earlier locations to override a
bundled one. See [Same name in more than one place](#duplicates) for how to
choose between two of your own copies.

### Skills an agent needs

An agent can declare the skills it depends on in its frontmatter, as a YAML
list or a comma-separated string:

```markdown
---
name: release-notes-writer
description: Drafts release notes from merged changes.
skills: [ctrlyoke-syntax, changelog-style]
---
```

ctrlyoke attaches these skills whenever the agent runs, alongside the step's
own `skills`. They belong to the agent, like its instructions, so they still
attach when the step sets `skills: null`. Every bundled agent declares
`ctrlyoke-syntax`, the bundled skill that teaches ctrlyoke's
[reference syntax](./context-files.md), so it writes prompts with the right
references and cites files and commits in a form the output pane links.

## Skills

`skills` attaches a list of skill names:

```yaml
skills:
  - code-review
  - refactor-helper
```

Prompt-level skills replace workflow-level skills rather than merging with them.

Each skill is a directory containing a `SKILL.md` file, and the directory name
is the skill name. ctrlyoke searches these locations in order, and the first
skill with a matching name wins:

1. `.ctrlyoke/skills/` in the workspace, which no harness scans natively
2. `~/.ctrlyoke/skills/`
3. each harness's own user skills directory (`~/.claude/skills/`,
   `~/.copilot/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`,
   `~/.qwen/skills/`, `~/.gemini/skills/`, and
   `~/.gemini/antigravity-cli/skills/`), then `~/.agents/skills/`
4. each harness's own workspace skills directory: `.claude/skills/`,
   `.github/skills/`, `.codex/skills/`, `.agents/skills/`, `.opencode/skills/`,
   and `.qwen/skills/`
5. `.agents/skills/` in the workspace's parent directory and at the Git
   repository root
6. the skills bundled with ctrlyoke, which any skill of the same name overrides

### Same name in more than one place {#duplicates}

A workflow names an agent or skill, not a file, so when the same name is saved
in several places only the first one in the order above is used. The pickers
show that name once. Hover it to see where the copy in use is saved, and every
other copy, each marked as identical or different.

To use a different copy, save or move it into a ctrlyoke folder:
`.ctrlyoke/agents/` or `.ctrlyoke/skills/` in the workspace, or
`~/.ctrlyoke/agents/` or `~/.ctrlyoke/skills/` in your home folder. ctrlyoke
folders always come first, and the workspace one wins over your home folder,
just as workspace settings override user settings. The [Agents & Skills
settings](#manager-save) **Save** menu does this for you.

### Inline skill references

You can also attach a skill from the prompt text with `/skill:<name>`:

```yaml
steps:
  - prompt: Review the staged changes using /skill:code-review.
```

Inline skills are added to the step's `skills` instead of replacing them. Before
the prompt is sent, the token is rewritten to a plain `skill: <name>` label so
the harness never receives it as a slash command. A `/skill:` token inside a
fenced code block or inline code span is ignored.

## Agents & Skills settings

The Agents & Skills settings page manages a separate, optional path: copying
agent and skill files into harness-native discovery directories. Native
discovery can enable ambient skills or native subagent spawning, and its
behavior varies by harness. It does not determine whether workflow `agent` or
`skills` attachments are supported.

Open it from the dashboard's settings: **Integrations**, then **Agent & Skills
Manager**. The **Agents** / **Skills** switch at the top chooses which list
you see.

### What the list shows {#manager-list}

Each row is one agent or skill, found in any of these places:

- ctrlyoke's own folders: `.ctrlyoke/agents/` and `.ctrlyoke/skills/` in the
  workspace, and `~/.ctrlyoke/agents/` and `~/.ctrlyoke/skills/`
- the shared `.agents/` folder (agents) and `.agents/skills/` folder, in the
  workspace and in your home folder
- your VS Code user `prompts` folder (agents only)
- each harness's own agent and skill folders, in the workspace and in your home
  folder
- the agents and skills bundled with ctrlyoke

Badges under the name show every place a copy exists, such as **Claude** or
**ctrlyoke ·user**; **·user** marks a copy in your home folder. Bundled items
are marked **Built-in**.

### Copying to a harness folder {#manager-save}

**Save** (the disk icon) copies the agent or skill into another folder. The
menu is split into **Workspace** and **User**, and each entry shows the folder
it writes to. Harnesses that are not installed are left out, and places that
already have a copy are disabled. The copies are:

| Save to     | Workspace folder                         | User folder                                                |
| ----------- | ---------------------------------------- | ---------------------------------------------------------- |
| Claude      | `.claude/agents/`, `.claude/skills/`     | `~/.claude/agents/`, `~/.claude/skills/`                   |
| Copilot     | `.github/agents/`, `.github/skills/`     | `~/.copilot/agents/`, `~/.copilot/skills/`                 |
| Codex       | `.agents/`, `.codex/skills/`             | `~/.codex/agents/`, `~/.codex/skills/`                     |
| OpenCode    | `.opencode/agents/`, `.opencode/skills/` | `~/.config/opencode/agents/`, `~/.config/opencode/skills/` |
| Qwen        | `.qwen/agents/`, `.qwen/skills/`         | `~/.qwen/agents/`, `~/.qwen/skills/`                       |
| Antigravity | `.agents/`, `.agents/skills/`            | `~/.gemini/agents/`, `~/.gemini/skills/`                   |
| Agents      | `.agents/`, `.agents/skills/`            | `~/.agents/`, `~/.agents/skills/`                          |
| VS Code     | none                                     | your VS Code user `prompts` folder (agents only)           |
| ctrlyoke    | `.ctrlyoke/agents/`, `.ctrlyoke/skills/` | `~/.ctrlyoke/agents/`, `~/.ctrlyoke/skills/`               |

An agent is saved as `<name>.md` for Claude and Antigravity, and as
`<name>.agent.md` everywhere else. A skill's whole folder is copied.

Saving to **ctrlyoke** is how you import an agent or skill that a harness
already has, so you can edit your own copy and pick it in workflow properties.
The agent and skill pickers in workflow properties update as soon as a save or
delete finishes.
Saving to a harness folder is how you export one so that harness can find it
on its own.

A save is a one-time copy. Editing one copy doesn't change the others, so save
again after you change the original.

### Editing, deleting and defaults {#manager-actions}

- **Edit** (the pencil) opens the file in VS Code: the `ctrlyoke` copy if
  there is one, otherwise the first copy found. For a skill it opens
  `SKILL.md`. It isn't shown in the browser dashboard.
- **Delete** (the bin) lists every copy, and removes only the one you pick,
  after you confirm. Other copies stay. A bundled agent or skill can't be
  deleted.
- The globe button makes the agent the default agent, or adds the skill to the
  default skills, at the settings drawer's current **User** or **Workspace**
  scope. It sets the [`defaults.agent`](/reference/settings#defaults-agent) and
  [`defaults.skills`](/reference/settings#defaults-skills) settings.
- **Open Folder** opens one of the target folders in your file manager. The
  folder must already exist. It isn't shown in the browser dashboard.

### Working with several at once {#manager-bulk}

Every row has a checkbox, and all rows start selected. The bar above the list
applies one action to the selected rows:

- **Save** copies them all to one folder. Unlike a single save, it replaces
  copies that are already there, so use it to bring a harness folder up to
  date with your edits.
- **Delete** removes the selected items from one folder.
- **Set Default** (skills only) makes the selected skills the default skills.

### Installing skills from skills.sh {#manager-skills-sh}

In the **Skills** list, the **skills.sh** tab under **Discover & import**
searches [skills.sh](https://skills.sh), the public skills directory run by
Vercel. Nothing is sent until you open the tab and type at least two
characters; your search text is sent to skills.sh.

Results are sorted by their install count on skills.sh, ten to a page. Each
one shows a security audit badge with the worst verdict from skills.sh's audit
providers. Click the badge to open that audit on skills.sh. **Not audited**
means skills.sh has not audited the skill yet.

**Import** opens a review dialog before anything is written. The dialog shows:

- each provider's audit verdict, linked to its page on skills.sh
- a link to the skill's `SKILL.md` on GitHub, at the exact commit that will be
  installed

When any audit warns or fails, or there is no audit yet, you must also tick a
box saying you have reviewed the skill.

Skills are published by third parties. Their files come from the
publisher's GitHub repository, not from skills.sh. **Install** copies the skill
folder at that commit into `.ctrlyoke/skills/<name>/`, or into
`~/.ctrlyoke/skills/<name>/` when the settings drawer is at **User** scope.
Its button then reads **Installed**, and the skill's row in the list gets a
**skills.sh** badge. A file named `.ctrlyoke-origin.json` beside `SKILL.md`
records where the skill came from and a hash of each file it installed. It is
not copied when you [save](#manager-save) the skill to a harness folder.

A result reads **Name in use** when a different skill with the same folder
name is already in that scope, for example one you wrote yourself. ctrlyoke
never replaces it; delete or rename it first.

#### Updating skills from skills.sh {#manager-skills-sh-updates}

**Check for updates**, beside the **skills.sh** tab, compares every skill you
installed from skills.sh, in both scopes, with its GitHub repository. It
appears once you have installed one, and runs only when you click it. Only the
skill's own folder counts, so commits to other parts of the repository are not
an update.

A skill with a newer version shows **Update available** on its row, and its
search result offers **Update**. Either opens the review dialog again, with
the new commit's audits, its `SKILL.md`, and a link comparing the two commits
on GitHub. **Update** replaces the installed copy in one step; if it fails, the
old copy stays. When you have edited, added or deleted files in the installed
skill since installing it, the dialog lists them and you must tick a box to
replace them. Copies you saved to harness folders keep the old version until
you save the skill again.

A row reads **Removed upstream** when the repository no longer contains the
skill, and **Update check failed** (with the reason in its tooltip) when GitHub
could not be reached.

Search and install use routes that skills.sh does not document. If skills.sh
or GitHub is unavailable or rate-limits you, the error names the service.
ctrlyoke does not report installs to skills.sh, so they do not count toward a
skill's install count there.

## Disabling inherited values

Use `null` when you want to stop inheritance from the workflow level:

```yaml
steps:
  - prompt: Run without the default agent.
    agent: null
```

## When to use them

- use an **agent** for a stable persona or role
- use **skills** for smaller reusable instruction packs
- keep workflow prompts focused on the task rather than repeating general process guidance
