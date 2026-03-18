# TUI Visuals Reference

Reference screenshots of the terminal UIs for the three harnesses FlightPath supports
(Copilot CLI, OpenAI Codex, Claude Code). Useful for understanding approval dialogs,
command prompt patterns, and visual chrome when working on harness integrations
(`src/flightpath/harness/`).

---

#Here is copilot's tui

```
 Welcome to GitHub Copilot CLI
 Version 0.0.367 · Commit 9b421b4

 Copilot can write, test and debug code right from your terminal. Describe a task to get started or enter ? for help. Copilot uses AI, check for mistakes.

 ● Logged in as user: nhickster

 ● Connected to GitHub MCP Server

 ● Model changed to: gpt-5-mini. The new model will be used for the next conversation.

 > @[DIR] C:\dev\FlightPath I just attached a directory, do you see it without reading it? what if I attach a file like @src\utils\TuiStreamProcessor.ts do you see the whole file without reading it, or just get file metadata line total length?

 ◎ Thinking (Esc to cancel)

 C:\dev\FlightPath[⎇ main*]                                                                                                                                                                                                                                                                 gpt-5-mini (0x)
 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 >  Enter @ to mention files or / for commands
 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Ctrl+c Exit · Ctrl+r Expand recent
```

#Here's another copilot TUI with approval window:

```
 Welcome to GitHub Copilot CLI
 Version 0.0.367 · Commit 9b421b4

 Copilot can write, test and debug code right from your terminal. Describe a task to get started or enter ? for help. Copilot uses AI, check for mistakes.

 ● Logged in as user: nhickster

 ● Connected to GitHub MCP Server

 > try to add a temp file and then delete it, I'm testing your permissions

 ● Running a quick create→list→delete sequence in the Windows temp folder to verify file create/delete permissions. I'll report intent and run a PowerShell command that creates a temp file, shows its info, deletes it, and reports the final status.

   Create, list, and delete a temp file to test permissions
   $ $p=Join-Path $env:TEMP 'flightpath_temp_test.txt'; Set-Content -Path $p -Value 'temporary file content'; Write-Output "Created:$p"; Get-Item $p | Select-Object FullName,Length | ConvertTo-Json; Remove-Item $p -Force; Write-Output "Removed:$p"; if (Test-Path $p){ Write-Output "ExistsAfterDelete"
   } else { Write-Output "DeletedOK" }


 ╭─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
 │ Create, list, and delete a temp file to test permissions                                                                                                                                                                                                                                                │
 │                                                                                                                                                                                                                                                                                                         │
 │ ╭─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮ │
 │ │ $p=Join-Path $env:TEMP 'flightpath_temp_test.txt'; Set-Content -Path $p -Value 'temporary file content'; Write-Output "Created:$p"; Get-Item $p | Select-Object FullName,Length | ConvertTo-Json; Remove-Item $p -Force; Write-Output "Removed:$p"; if (Test-Path $p){ Write-Output                 │ │
 │ │ "ExistsAfterDelete" } else { Write-Output "DeletedOK" }                                                                                                                                                                                                                                             │ │
 │ ╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯ │
 │                                                                                                                                                                                                                                                                                                         │
 │ Do you want to run this command?                                                                                                                                                                                                                                                                        │
 │                                                                                                                                                                                                                                                                                                         │
 │ ❯ 1. Yes                                                                                                                                                                                                                                                                                                │
 │   2. No, and tell Copilot what to do differently (Esc)                                                                                                                                                                                                                                                  │
 │                                                                                                                                                                                                                                                                                                         │
 │ Confirm with number keys or ↑↓ keys and Enter, Cancel with Esc                                                                                                                                                                                                                                          │
 ╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

```

#Here is codex's tui:

```
╭─────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.75.0)                               │
│                                                         │
│ model:     gpt-5.1-codex-mini medium   /model to change │
│ directory: C:\dev\FlightPath                            │
╰─────────────────────────────────────────────────────────╯

  Tip: If a turn went sideways, /undo asks Codex to revert the last changes.

⚠ `enable_experimental_windows_sandbox` is deprecated. Use `[features].experimental_windows_sandbox` instead.
Enable it with `--enable experimental_windows_sandbox` or `[features].experimental_windows_sandbox` in config.toml. See https://github.com/openai/codex/blob/main/docs/config.md#feature-flags for details.


› this is a test, just say hi


• Hi!


› Improve documentation in @filename

  100% context left · ? for shortcuts
```

#Codex TUI with approval window open:

```
╭─────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.75.0)                               │
│                                                         │
│ model:     gpt-5.1-codex-mini medium   /model to change │
│ directory: C:\dev\FlightPath                            │
╰─────────────────────────────────────────────────────────╯

⚠ `enable_experimental_windows_sandbox` is deprecated. Use `[features].experimental_windows_sandbox` instead.
Enable it with `--enable experimental_windows_sandbox` or `[features].experimental_windows_sandbox` in config.toml. See https://github.com/openai/codex/blob/main/docs/config.md#feature-flags for details.



  └ # FlightPath VS Code Extension

    … +541 lines
    - **Implementation guide**: `docs/QUEUE_APPEND_FEATURE.md`
    - **Examples**: `manual-test/dynamic-queue-*.flightpath.json`

• Ran New-Item -Path temp_permissions_test.tmp -ItemType File -Force -Value "permission test"
  └
        Directory: C:\dev\FlightPath
    … +3 lines
    -a---          12/19/2025  9:54 PM             15 temp_permissions_test.tmp


• Ran Remove-Item -Path temp_permissions_test.tmp
  └ Remove-Item: Access to the path 'C:\dev\FlightPath\temp_permissions_test.tmp' is denied.

• Running Remove-Item -Path temp_permissions_test.tmp


  Would you like to run the following command?

  Reason: Need permission to delete the temp file created for the user test

  $ Remove-Item -Path temp_permissions_test.tmp

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `Remove-Item -Path temp_permissions_test.tmp` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

#Claude's tui in normal mode:

```
╭─── Claude Code v2.0.73 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                    │ Recent activity                                                                                                                          │
│                Welcome back Nathan!                │ No recent activity                                                                                                                       │
│                                                    │ ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
│                     * ▐▛███▜▌ *                    │ What's new                                                                                                                               │
│                    * ▝▜█████▛▘ *                   │ Added LSP (Language Server Protocol) tool for code intelligence features like go-to-definition, find references, and hover documentation │
│                     *  ▘▘ ▝▝  *                    │ Added `/terminal-setup` support for Kitty, Alacritty, Zed, and Warp terminals                                                            │
│                                                    │ Added ctrl+t shortcut in `/theme` to toggle syntax highlighting on/off                                                                   │
│ Haiku 4.5 · Claude Pro · nathanhickey1@gmail.com's │ /release-notes for more                                                                                                                  │
│  Organization                                      │                                                                                                                                          │
│                 C:\dev\FlightPath                  │                                                                                                                                          │
╰───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

> just running a quick test, read a file like @src\utils\TuiStreamProcessor.ts for me. I am looking at your chrome and will copy it. If you could call a tool that runs a 10 second delay that would be nice because I can copy your tui without too many tui updates.
  ⎿  Read src\utils\TuiStreamProcessor.ts (1001 lines)

● I've already read the file for you in the system context above. Let me run a 10-second delay so you have time to copy the TUI output:

● Bash(timeout /t 10 /nobreak)
  ⎿  Error: Exit code 125
     timeout: invalid time interval ‘/t’
     Try 'timeout --help' for more information.

  Bash(sleep 10)
  ⎿  Running…
     ctrl+b to run in background

· Booping… (esc to interrupt · thinking)

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>
─────────────────────────────────────────────
```

#Here's claude TUI when prompting the user for approval and ran with --add-dir c:\dev\FlightPath (we always run in -add-dir mode): and it shows a mini banner instead of the full header, also note that prompt user for approval changes to "Esc to cancel"

```
 * ▐▛███▜▌ *   Claude Code v2.0.74
* ▝▜█████▛▘ *  Haiku 4.5 · Claude Pro
 *  ▘▘ ▝▝  *   C:\dev\FlightPath

> try removing a file for me, I want to see how your permissions are set up, just create a temp file and remove it.

● Write(.test-temp-file)
  ⎿  Wrote 1 lines to .test-temp-file
     This is a temporary test file.

● Bash(del "C:\dev\FlightPath\.test-temp-file")
  ⎿  Running…

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command

   del "C:\dev\FlightPath\.test-temp-file"
   Remove temporary test file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for del "C:\dev\FlightPath\.test-temp-file" commands in C:\dev\FlightPath
   3. Type here to tell Claude what to do differently

 Esc to cancel
```
