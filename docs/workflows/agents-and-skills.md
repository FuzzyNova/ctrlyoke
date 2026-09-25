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
   `ctrlyoke-tech-support`, `spec-orchestrator`, and `test-repair`

Put an agent with the same name in any of the earlier locations to override a
bundled one.

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
triple-backtick fenced block is ignored.

## Agents & Skills settings

The Agents & Skills settings page manages a separate, optional path: copying
agent and skill files into harness-native discovery directories. Native
discovery can enable ambient skills or native subagent spawning, and its
behavior varies by harness. It does not determine whether workflow `agent` or
`skills` attachments are supported.

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
