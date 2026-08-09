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

- `ctrlyoke: Load in ctrlyoke` from the file context menu
- `ctrlyoke: Select Prompt File` from the panel
- `ctrlyoke: Run with ctrlyoke` if you want to load and start in one step

## Make a workflow durable

**Workflows you build in the dashboard stay on your machine.** Everything you queue, run, and
edit lives under `.ctrlyoke/.runs/`, which ctrlyoke gitignores — including screenshots you paste
and prompt files you create along the way. Most of that work is a conversation, not an artifact,
so nothing lands in your commits by default.

**When a workflow turns out to be worth keeping, use Save As.** It writes a portable copy — the
workflow file plus any assets it depends on — anywhere you choose in the repo. Save As copies
inline attachments into a sibling `<workflow>.assets/` directory and inlines lone prompt-file
bodies. That copy is yours to commit and share. Files you author directly, such as a
`.ctrlyoke.yaml`, are tracked like any other source file.

The generated `.ctrlyoke/.gitignore` ignores `.runs/`, `attachments/`, `prompts/`, logs, temporary
files, and other machine-local runtime data. It does not ignore exported `<workflow>.assets/`
directories. The `.gitignore` is editable: remove the entries for anything you want tracked, but
delete the `.gitignore` self-ignore line at the bottom first or the change stays on this machine.

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
      returns: "0"
      compareSource: exitCode
      maxRetries: 2
      retryPrompt: |
        Tests are still failing.
        stdout:
        {stdout}

        stderr:
        {stderr}

        Fix the remaining issues.
```

## Next steps

- Learn the building blocks in [Core concepts](/guide/concepts)
- See a fuller example in [Your first workflow](/guide/your-first-workflow)
- Look up schema fields in [Workflow schema reference](/reference/workflow-schema)
