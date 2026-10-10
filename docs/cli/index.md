# CLI overview

ctrlyoke ships with two command-line entry points:

| Command        | Purpose                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `ctrlyoke`     | Run, continue, and validate workflows; inspect run history; manage secrets; generate commits |
| `ctrlyoke-mcp` | Run the standalone ctrlyoke MCP server that harnesses use for queue and output tools         |

Both are Node.js programs and require Node.js 22.12 or later. The harness CLIs
you run workflows with (Copilot CLI, Claude Code, and so on) must be installed,
on `PATH`, and signed in, exactly as for the extension.

## Getting the CLI

- **Inside VS Code:** nothing to install. The extension includes both commands
  and puts them on `PATH` in VS Code's integrated terminals. The harness
  processes ctrlyoke starts get the same copy, so an agent that runs
  `ctrlyoke append` during a run reaches the ctrlyoke that started it.
- **Everywhere else** (another terminal, CI, a server or a container): install
  the `ctrlyoke` package from npm.

  ```bash
  npm install -g ctrlyoke
  ctrlyoke --version
  ```

  Or run it without installing: `npx ctrlyoke@<version> validate my-workflow.ctrlyoke.yaml`.

The npm package and the extension are built from the same release and always
share a version number.

## Using the CLI and the extension together

Which copy runs `ctrlyoke`:

| Where                                      | Copy                                       |
| ------------------------------------------ | ------------------------------------------ |
| VS Code integrated terminal                | The extension's (ahead of npm's on `PATH`) |
| Harness processes ctrlyoke starts          | The copy that started the run              |
| Any other shell, CI job, or scheduled task | The npm copy                               |

Both copies read and write the same state: settings, run history, runner locks
and trust decisions. **Keep the npm copy on the
extension's version.** VS Code updates extensions automatically and npm does
not update global packages, so in practice the npm copy is the one that falls
behind:

- When the npm CLI is older than the installed extension, it prints a warning
  once per version pair, on stderr so `--json` output stays clean. The warning
  names the install command: `npm install -g ctrlyoke@<extension version>`. The
  extension shows a matching one-time notice.
- If an older copy meets state written by a newer one, it still reads it, but
  it refuses to change it rather than risk dropping fields it doesn't know
  about. The error says the state "was written by a newer version of ctrlyoke"
  and asks you to update; the CLI exits with code `2`, including when this
  stops a run partway through. Update the older copy and run the command again.
- Each history-search index is keyed by its index schema version, so CLI copies
  using the same schema can reuse the index.
- Harness statuslines run from a shared copy of ctrlyoke's statusline scripts
  in `~/.ctrlyoke/bin/`, which the newest installed version keeps up to date.
  Updating or removing either copy does not break your statusline.

Run `ctrlyoke about` to see which copy a shell is running, where it is
installed, and which other ctrlyoke installations this machine has used.

Each copy starts its own `ctrlyoke-mcp` server from its own install, so a run
never mixes versions of the CLI and its MCP server.

## License and privacy

The CLI and MCP server are covered by the same [ctrlyoke Commercial License](https://ctrlyoke.dev/terms)
as the extension and are part of the Free Tier. The free-use eligibility terms
apply to the CLI exactly as they do to the extension, including
for automated, scripted and CI use. Headless CLI commands other than
`ctrlyoke server` do not check a license. `ctrlyoke server` checks the Pro
license for remote access, including LAN HTTPS, and may refresh a cached online
Pro license with Keygen.

Headless CLI commands other than `ctrlyoke server`, and `ctrlyoke-mcp`, send no
telemetry and make no network requests of their own. Your harness CLIs talk to
their providers as usual. `ctrlyoke server` can also send browser push
notifications when they are enabled. See [Other network requests in the
privacy guide](/guide/privacy#other-network-requests).

## What the CLI shares with the extension

- the same workflow file formats
- the same schema validation
- the same end condition and pre-condition behavior
- the same core orchestration logic
- the same settings files (`~/.ctrlyoke/settings.json` and
  `<workspace>/.ctrlyoke/settings.json`)
- the same run history: runs started by the CLI appear in the dashboard's
  history, and a CLI run that is executing is mirrored live in the VS Code
  dashboard for the same project

## What is different

- no dashboard UI; headless output is formatted for the terminal, and
  interactive mode passes the harness's own terminal UI through
- CLI property flags set workflow values for one run; steps keep their own
  values unless `--force <flag>` is used to apply the flag to every step. For
  `append` and `continue`, shared execution flags affect pending work at
  workflow scope (see
  [Tool permissions](/cli/ctrlyoke#tool-permissions))
- structured exit codes and `--json` output for scripting and CI

Read [ctrlyoke](/cli/ctrlyoke) for every command and option,
[CLI in CI](/cli/ci) for pipelines, and [ctrlyoke-mcp](/cli/ctrlyoke-mcp) for
the MCP server.
