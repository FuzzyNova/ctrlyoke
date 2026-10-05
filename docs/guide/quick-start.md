# Quick start

This walkthrough gets a basic workflow running with whichever supported harness you have installed.

## 1. Open the ctrlyoke panel

```text
Command Palette → ctrlyoke: Open ctrlyoke Panel
```

## 2. Create a workflow file

Create `hello.ctrlyoke.yaml` in your workspace:

```yaml
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

The file has no `harness` line, so it runs on your default harness: the **Default harness**
setting in ctrlyoke Settings (`defaults.harness`), or, while that is left on **Auto-detect**, the
first installed harness in alphabetical order. To pin a workflow to one harness, add a root-level `harness:` with any
supported ID, such as `claude-cli`, `codex-cli`, or `copilot-cli`.

## 3. Load it into the panel

Use one of these entry points:

- `ctrlyoke: Load in ctrlyoke` from the **Run with ctrlyoke** submenu in the file context menu
- `ctrlyoke: Select Prompt File` from the Command Palette
- `ctrlyoke: Run with ctrlyoke` from the **Run with ctrlyoke** submenu if you want to load and
  start in one step

The **Run with ctrlyoke** submenu groups Run, Load, Queue Steps, and Queue Steps Next in file
context menus and the editor title toolbar. Queue Steps and Queue Steps Next are hidden until
the active queue already contains at least one step.

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

## Where your work is saved

**Workflows you build in the dashboard stay on your machine.** By default, run history lives
under `~/.ctrlyoke/projects/<slug>-<hash12>/.runs/`, outside the workspace, because only
ctrlyoke reads it. To keep it beside the repo at `.ctrlyoke/.runs/` instead, set
`storage.runHistoryLocation` to `workspace` in your user settings (`~/.ctrlyoke/settings.json`);
this setting is ignored in a workspace settings file. Either way, `.runs/` stays git-ignored.

**When a workflow turns out to be worth keeping, save it.** The **Save** button in the dashboard
header writes a portable copy — the workflow file plus a sibling `<workflow>.assets/` directory
for any inline attachments — anywhere you choose in the repo. That copy is yours to commit and
share. Files you author directly, such as `hello.ctrlyoke.yaml` above, are tracked like any other
source file. See [Durable workflows and generated files](/guide/concepts#durable-workflows-and-generated-files)
for the details.

## Next steps

- Learn the building blocks in [Core concepts](/guide/concepts)
- See a fuller example in [Your first workflow](/guide/your-first-workflow)
- Change harness, validation, and permissions from the dashboard with the
  [Workflow properties panel](/workflows/properties-panel)
- Look up schema fields in [Workflow schema reference](/reference/workflow-schema)
