# Quick start

This walkthrough gets a basic workflow running with the current schema and the default `copilot-cli` harness.

## 1. Open the ctrlyoke panel

```text
Command Palette → ctrlyoke: Open ctrlyoke Panel
```

## 2. Create a workflow file

Create `hello.ctrlyoke.yaml` in your workspace:

```yaml
harness: copilot-cli
model: claude-sonnet-4.5

steps:
  - name: inspect
    prompt: |
      Review @README.md and summarize what this project does,
      who it is for, and what looks incomplete.

  - name: propose
    resumeSession: true
    prompt: |
      Based on the summary, propose the three most valuable
      next improvements for the project.
```

## 3. Load it into the panel

Use one of these entry points:

- `ctrlyoke: Load in ctrlyoke` from the **Run with ctrlyoke** submenu in the file context menu
- `ctrlyoke: Select Prompt File` from the panel
- `ctrlyoke: Run with ctrlyoke` from the **Run with ctrlyoke** submenu if you want to load and
  start in one step

The **Run with ctrlyoke** submenu groups Run, Load, Queue Steps, and Queue Steps Next in file
context menus and the editor title toolbar. Queue Steps and Queue Steps Next are hidden until
the active queue already contains at least one step.

## Make a workflow durable

**Workflows you build in the dashboard stay on your machine.** By default, run history is
user-scoped under `<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/`, keyed from the resolved
`stateRoot`. It is outside the workspace and harness sandbox because only ctrlyoke reads it.
Attachments and prompts remain ephemeral workspace-scoped files under `.ctrlyoke/` because the
harness reads them through `@` references. User-level, project-keyed session history is a familiar
pattern from Claude and Codex.

**When a workflow turns out to be worth keeping, use Save As.** It writes a portable copy — the
workflow file plus any assets it depends on — anywhere you choose in the repo. Save As copies
inline attachments into a sibling `<workflow>.assets/` directory and inlines lone prompt-file
bodies. The workflow file and its sibling assets directory can travel together to another
directory or repository. That copy is yours to commit and share, but it carries generated
dependencies only: references to repository files or committed prompt files still require their
original subject matter. Files you author directly, such as a
`.ctrlyoke.yaml`, are tracked like any other source file.

The generated `.ctrlyoke/.gitignore` ignores `.runs/`, `attachments/`, `prompts/`, logs, temporary
files, and other machine-local runtime data. It does not ignore exported `<workflow>.assets/`
directories. Set `storage.runHistoryLocation` to `workspace` to keep history beside the repo at
`<stateRoot>/.ctrlyoke/.runs/`; workspace mode still ignores `.runs/`. The setting controls
locality and durability, not sharing. Since `ensureGitignore` is append-only, removing entries is
restored on activation. Use the explicit run export described in
`dev/backlog/RUN_EXPORT_PLAN.md` to share a run.

Durable workflows are files you export with Save As, hand-author anywhere in the repo, or promote
to a template. Templates are the reusable form of a workflow you run often; Save As creates a
copy. Managed-worktree landing accepts deliberately tracked prompts, attachments, and other
non-sensitive runtime files, but rejects non-ignored untracked runtime output. It always rejects
`certs/`, `notifications/`, `temp/`, and `logs/`, even if tracked.

Managed worktree runs use the initiating checkout's history. Opening a worktree directory directly
as its own VS Code workspace gives it its own history. OneDrive/Dropbox home directories sync
user-scoped history, but simultaneous runs of the same project on two synced machines are
unsupported because PIDs and file locks are machine-local.

`settings.json` is tracked by default as project configuration. Its `server.certPath` and
`server.keyPath` fields are machine-local and should point to files available on each machine.

## 4. Run the workflow

Click **Run** in the panel. ctrlyoke sends the first step to the active harness, waits for completion, stores the runtime metadata, and then advances to the next step.

## 5. Add validation when you are ready

Once the basic workflow works, add an end condition so the harness has to satisfy a real project check:

```yaml
steps:
  - name: fix-tests
    prompt: Fix the failing tests in @src/
    endCondition:
      script: npm test
      compareSource: exitCode
      expected: 0
      maxRetries: 2
      retryPrompt: |
        Tests are still failing.
        stdout:
        $endCondition:stdout

        stderr:
        $endCondition:stderr

        Fix the remaining issues.
```

## Next steps

- Learn the building blocks in [Core concepts](/guide/concepts)
- See a fuller example in [Your first workflow](/guide/your-first-workflow)
- Look up schema fields in [Workflow schema reference](/reference/workflow-schema)
