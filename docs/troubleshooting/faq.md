# FAQ

## Does ctrlyoke require VS Code?

The extension does, but the standalone `ctrlyoke` CLI does not.

## Which harness do I need?

Any one of the six supported harnesses: GitHub Copilot CLI (`copilot-cli`), Claude Code CLI (`claude-cli`), Codex CLI (`codex-cli`), OpenCode CLI (`opencode-cli`), Qwen Code CLI (`qwen-cli`), or Antigravity CLI (`antigravity-cli`). Use whichever you already have. If you have not picked one, ctrlyoke uses the first installed harness in alphabetical order; choose one explicitly with the `defaults.harness` setting, a workflow's `harness`, or `ctrlyoke run --harness`, and mix harnesses across steps if you like.

## Does ctrlyoke use my Claude, ChatGPT, GitHub, or Google account?

No. ctrlyoke starts the harness CLI you installed, and that CLI uses whatever sign-in you gave it. ctrlyoke never signs in for you, never reads or stores a harness's login, and never calls a model provider itself. You pay each provider directly, and your use of each CLI stays under that provider's terms. See [How ctrlyoke talks to a harness](/harnesses/#how-ctrlyoke-talks-to-a-harness) and [Privacy and telemetry](/guide/privacy).

## Can I run workflows in CI?

Yes. Use `ctrlyoke run <file> --headless --json`, check the [exit code](/cli/ctrlyoke#exit-codes), and provide secrets as environment variables. Tool permissions resolve the same way in headless mode as anywhere else (step, workflow, then settings), so make sure the resolved mode will not stop to ask for approval. You can set it in the workflow, in the CI workspace's settings, or with `--permission-mode` for one run; the flag sets the workflow value and a step's own value still takes precedence. Add `--force permission-mode` to apply it to every step. See [Tool permissions](/cli/ctrlyoke#tool-permissions). The harness CLI must be installed and authenticated on the CI machine.

## Where is my run history?

By default under `~/.ctrlyoke/projects/<slug>-<hash12>/.runs/`, outside the repository. Set `storage.runHistoryLocation` to `workspace` in your user settings (it is user-scope only) to keep it in `.ctrlyoke/.runs/` instead. See [Run storage](/troubleshooting/#run-storage). After moving or renaming a repository, run `ctrlyoke history relink <oldPath> <newPath>` to keep its history.

## Can I run scripts without any AI step?

Yes. Use `type: script` inside `steps`.

## Can I keep using `.prompt.md` files?

Yes. They are still the quickest way to run a single prompt. Move to YAML or JSON when you need structure, validation, or session control.

## Why do I sometimes see `cmd.exe` involved instead of PowerShell on Windows?

ctrlyoke does not run harness CLIs through a shell at all, on any OS. It spawns the harness executable directly with an argument array — no `cmd.exe`, no PowerShell, no `sh` in between. Routing text from a shared workflow (file paths, prompt content) through a shell risks command injection, so ctrlyoke avoids the shell entirely wherever the operating system allows it.

The one exception is Windows-only, and it is an OS constraint rather than a preference: some npm-installed CLIs ship a legacy `.cmd` launcher file, and Windows can only execute those through `cmd.exe` — there is no way to run a `.cmd` file directly. ctrlyoke tries to avoid even this hop: it looks inside the shim and, when possible, calls the underlying `node.exe <script>` (or PowerShell, for a `.ps1` shim) directly instead. Only when a `.cmd` file does not match a recognized, safely-bypassable shape does ctrlyoke fall back to invoking it through `cmd.exe`, with careful escaping — that is the one place a shell is genuinely in the process tree.

This is not a blanket "prefer cmd.exe" policy. Interactive terminal sessions actively prefer PowerShell (`pwsh`, falling back to Windows PowerShell). If the Dry Run **Copy command** preview shows a `cmd.exe`-style escaped command, that is just the display rendering for that dialect — use the Command tab's shell toggle to switch it to PowerShell if that's what you'd paste into your terminal.
