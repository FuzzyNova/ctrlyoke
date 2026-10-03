# Commands

These are the user-facing commands the extension contributes to VS Code. Run them from the
Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) unless the table says they live in a menu.

## Standalone CLI

The CLI's run-history inspection commands are documented in the
[`ctrlyoke` CLI reference](../cli/ctrlyoke.md). To list executing workflows and
check whether their runner processes are alive, use `ctrlyoke status`; pass
`--workflow <key>` and `--run <ref>` to narrow the result, or `--json` for
machine-readable output; each row's liveness names why a run is `stale`. For
recorded run output, `history show --json` emits NDJSON; `--summary` keeps
attempt records compact, `--events` emits one line per output event, and
`--limit`/`--cursor`/`--tail` bound everything a read emits to one page of one
attempt. Agents should use these JSON forms because recorded tool
output can contain nested ctrlyoke boxes that make rendered text ambiguous.

## Dashboard and execution

| Command                             | What it does                                        |
| ----------------------------------- | --------------------------------------------------- |
| `ctrlyoke: Open ctrlyoke Panel`     | Open the dashboard                                  |
| `ctrlyoke: Run`                     | Run the workflow loaded in the dashboard            |
| `ctrlyoke: Pause Execution`         | Pause the current run                               |
| `ctrlyoke: Resume Execution`        | Resume a paused run                                 |
| `ctrlyoke: Stop Execution`          | Stop the current run                                |
| `ctrlyoke: Resume Session`          | Pick a previous run's harness session and resume it |
| `ctrlyoke: Search ctrlyoke History` | Open the dashboard's run-history search             |
| `ctrlyoke: Show Output Panel`       | Show the ctrlyoke log in VS Code's Output panel     |

## Workflow authoring

| Command                                | What it does                                                     | Shortcut (dashboard focused)   |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------ |
| `ctrlyoke: New Workflow from Template` | Open the template picker                                         | `Ctrl+Shift+T` / `Cmd+Shift+T` |
| `ctrlyoke: New Blank Workflow`         | Clear the current workflow and start fresh                       | `Ctrl+Shift+N` / `Cmd+Shift+N` |
| `ctrlyoke: Create New Custom Template` | Open the template picker's create-template form                  |                                |
| `ctrlyoke: Select Prompt File`         | Pick a workflow or prompt file in the workspace and load it      | `Ctrl+Shift+L` / `Cmd+Shift+L` |
| `ctrlyoke: Queue Prompt File`          | Pick a workflow or prompt file and append its steps to the queue | `Ctrl+Shift+Q` / `Cmd+Shift+Q` |

The keyboard shortcuts apply only while the ctrlyoke dashboard view has focus.

The prompt editor's convert button writes a step prompt to a file under `.ctrlyoke/prompts/` and
replaces the inline prompt with a reference to it. Script templates for end conditions are created
from the condition editor in the dashboard, not from a command.

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

## Run with ctrlyoke submenu

Right-click a `.ctrlyoke.yaml`, `.ctrlyoke.yml`, `.ctrlyoke.json`, or `.prompt.md` file in the
Explorer or on its editor tab, or use the play-icon **Run with ctrlyoke** menu in the editor title
bar:

| Menu item                      | What it does                                           |
| ------------------------------ | ------------------------------------------------------ |
| Run with ctrlyoke              | Save the file if needed, load it, and run it           |
| Load in ctrlyoke               | Load the file into the dashboard without running it    |
| Queue Steps with ctrlyoke      | Append the file's steps to the end of the active queue |
| Queue Steps Next with ctrlyoke | Insert the file's steps after the current step         |

Queue Steps and Queue Steps Next are hidden until the active queue already contains at least one
step. These items are menu-only and do not appear in the Command Palette.

## Adding context to the prompt editor

These menu items insert a reference into the dashboard's prompt editor. They are menu-only.

| Menu item                        | Where it appears                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------- |
| Add File to ctrlyoke             | Explorer file context menu, editor tab context menu, Source Control changed files |
| Add Directory to ctrlyoke        | Explorer folder context menu                                                      |
| Add Selection to ctrlyoke        | Editor and line-number context menus when text is selected                        |
| Add Symbol to ctrlyoke           | Editor and line-number context menus when nothing is selected                     |
| Add Output Selection to ctrlyoke | Output panel context menu when text is selected                                   |
| Add Output Channel to ctrlyoke   | Output panel context menu when no text is selected                                |
| Add Commit to ctrlyoke           | Timeline view context menu on a Git commit                                        |

## Source Control

| Command                                           | What it does                                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctrlyoke: Generate Commit Message with ctrlyoke` | Generate a commit message into the Source Control input box; text already in the box guides the message. Also a button in the Source Control title bar for Git repositories |
| `ctrlyoke: Cancel Commit Message Generation`      | Cancel a generation in progress (replaces the generate button while it runs)                                                                                                |

## Workspace, worktrees, and usage

| Command                                         | What it does                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ctrlyoke: Initialize Workspace`                | Create or repair `.ctrlyoke/` and its generated `.gitignore`                            |
| `ctrlyoke: Show Getting Started`                | Reopen the Getting Started walkthrough                                                  |
| `ctrlyoke: Install CLI for Use Outside VS Code` | Open a terminal with the matching `npm install -g ctrlyoke@<version>` typed in, not run |
| `ctrlyoke: Manage Worktrees`                    | Open the dashboard to manage ctrlyoke worktrees                                         |
| `ctrlyoke: Refresh Harness Usage`               | Refresh harness usage and quota information                                             |
| `ctrlyoke: Refresh Workspace Statistics`        | Recompute the workspace statistics shown in the dashboard                               |

## License

| Command                                           | What it does                                          |
| ------------------------------------------------- | ----------------------------------------------------- |
| `ctrlyoke: Activate Pro License`                  | Open the dashboard's license settings                 |
| `ctrlyoke: Activate Offline (Air-Gapped) License` | Import an offline license file without network access |
| `ctrlyoke: Deactivate Pro License`                | Open the dashboard's license settings                 |
| `ctrlyoke: Manage License`                        | Open the dashboard's license settings                 |
