# Commands

These are the main user-facing commands registered by the extension.

## Core workflow commands

| Command | What it does |
| --- | --- |
| `FlightPath: Open FlightPath Panel` | Open the panel UI |
| `FlightPath: Run` | Start the loaded workflow |
| `FlightPath: Pause Execution` | Pause the current run |
| `FlightPath: Resume Execution` | Resume a paused run |
| `FlightPath: Stop Execution` | Stop the current run |
| `FlightPath: Show Output Panel` | Open the output panel |

## Workflow authoring commands

| Command | What it does |
| --- | --- |
| `FlightPath: Create Prompt File` | Create a new prompt file |
| `FlightPath: New Draft Prompt` | Create a draft prompt |
| `FlightPath: New Workflow from Template` | Start from a template |
| `FlightPath: New Blank Workflow` | Clear the current workflow and start fresh |
| `FlightPath: Create New Custom Template` | Create a user template |
| `FlightPath: Import Workflow Templates` | Import bundled templates |

## Queue and session commands

| Command | What it does |
| --- | --- |
| `FlightPath: Queue with FlightPath` | Append a prompt file to the queue |
| `FlightPath: Queue Next with FlightPath` | Insert a prompt file after the current step |
| `FlightPath: Queue Prompt File` | Queue a prompt file from the dashboard |
| `FlightPath: Resume Session` | Resume a prior session |

## Workspace and helper commands

| Command | What it does |
| --- | --- |
| `FlightPath: Initialize Workspace` | Create the standard `.flightpath` workspace folders |
| `FlightPath: Create End Condition Script` | Create a validation script template |
| `FlightPath: Import FlightPath Agents` | Import bundled agents |

## Prompt editor context commands

These commands insert references into the prompt editor from the Explorer, editor selection, SCM view, and timeline:

- Add File to FlightPath
- Add Directory to FlightPath
- Add Selection to FlightPath
- Add Symbol to FlightPath
- Add Commit to FlightPath
