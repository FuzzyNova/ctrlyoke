# Commands

These are the main user-facing commands registered by the extension.

## Core workflow commands

| Command                         | What it does              |
| ------------------------------- | ------------------------- |
| `ctrlyoke: Open ctrlyoke Panel` | Open the panel UI         |
| `ctrlyoke: Run`                 | Start the loaded workflow |
| `ctrlyoke: Pause Execution`     | Pause the current run     |
| `ctrlyoke: Resume Execution`    | Resume a paused run       |
| `ctrlyoke: Stop Execution`      | Stop the current run      |
| `ctrlyoke: Show Output Panel`   | Open the output panel     |

## Workflow authoring commands

| Command                                | What it does                                |
| -------------------------------------- | ------------------------------------------- |
| Editor convert button                  | Write a step prompt to `.ctrlyoke/prompts/` |
| `ctrlyoke: New Workflow from Template` | Start from a template                       |
| `ctrlyoke: New Blank Workflow`         | Clear the current workflow and start fresh  |
| `ctrlyoke: Create New Custom Template` | Create a user template                      |
| `ctrlyoke: Import Workflow Templates`  | Import bundled templates                    |

### Save As

Save As writes a durable workflow definition at the destination you choose. It copies inline
`@`, `#selection:`, and `#sym` references that point into generated attachments or prompt stores
into a sibling `<workflow>.assets/` directory, rewriting those references to the exported paths.
It inlines lone step prompt values that resolve to generated prompt files, including empty files.
Ordinary repository references remain unchanged. The exported pair — the workflow file and its
sibling `<workflow>.assets/` directory — can be moved or copied to another directory or repository
and still resolve, provided they travel together. The pair carries generated dependencies, not the
repository it operates on: `@src/foo.ts`, committed prompt files, and `.ctrlyoke/scripts/**`
references remain dependencies of the surrounding repository by design.

## Queue and session commands

| Command                              | What it does                                |
| ------------------------------------ | ------------------------------------------- |
| `ctrlyoke: Queue with ctrlyoke`      | Append a prompt file to the queue           |
| `ctrlyoke: Queue Next with ctrlyoke` | Insert a prompt file after the current step |
| `ctrlyoke: Queue Prompt File`        | Queue a prompt file from the dashboard      |
| `ctrlyoke: Resume Session`           | Resume a prior session                      |

## Workspace and helper commands

| Command                                 | What it does                                       |
| --------------------------------------- | -------------------------------------------------- |
| `ctrlyoke: Initialize Workspace`        | Create `.ctrlyoke/` and its generated `.gitignore` |
| `ctrlyoke: Create End Condition Script` | Create a validation script template                |
| `ctrlyoke: Import ctrlyoke Agents`      | Import bundled agents                              |

## Prompt editor context commands

These commands insert references into the prompt editor from the Explorer, editor selection, SCM view, and timeline:

- Add File to ctrlyoke
- Add Directory to ctrlyoke
- Add Selection to ctrlyoke
- Add Symbol to ctrlyoke
- Add Commit to ctrlyoke
