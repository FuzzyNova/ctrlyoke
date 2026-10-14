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

1. `~/.ctrlyoke/agents/`
2. the VS Code user `prompts` directory
3. workspace harness directories: `.github/agents/`, `.claude/agents/`,
   `.agents/`, `.opencode/agents/`, and `.qwen/agents/`
4. `.ctrlyoke/agents/` in the workspace, which no harness scans natively
5. the agents bundled with ctrlyoke, such as `ctrlyoke-workflow-composer`,
   `ctrlyoke-tech-support`, `workflow-orchestrator`, and `test-repair`

Put an agent with the same name in any of the earlier locations to override a
bundled one.

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
is the skill name. ctrlyoke searches:

- user directories: `~/.claude/skills/`, `~/.copilot/skills/`, and `~/.agents/skills/`
- workspace directories: `.ctrlyoke/skills/` (which no harness scans natively),
  plus each harness's own skills directory: `.claude/skills/`,
  `.github/skills/`, `.codex/skills/`, `.agents/skills/`, `.opencode/skills/`,
  and `.qwen/skills/`
- `.agents/skills/` in the workspace's parent directory and at the Git repository root
- the skills bundled with ctrlyoke, which any skill of the same name overrides

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
