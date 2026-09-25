# ctrlyoke

The command-line runner and MCP server for [ctrlyoke](https://ctrlyoke.dev), which runs
structured YAML/JSON/Markdown workflows through AI coding harnesses: Claude Code, Codex,
Copilot CLI, OpenCode, Qwen Code, and Antigravity.

```sh
npm install -g ctrlyoke
ctrlyoke validate my-workflow.ctrlyoke.yaml
ctrlyoke run my-workflow.ctrlyoke.yaml
```

Or without installing: `npx ctrlyoke --help`.

Requires Node.js 22.12 or later, and at least one supported harness installed and signed in.

## Using it with the VS Code extension

The ctrlyoke VS Code extension already includes this CLI and puts it on `PATH` in VS Code's
integrated terminals, so you don't need this package there. Install it for CI, servers,
containers, and terminals outside VS Code. If you use both, keep this package on the same
version as the extension: `npm install -g ctrlyoke@<extension version>`. The CLI warns when it
is older than the installed extension.

## Documentation

- [CLI reference](https://ctrlyoke.dev/docs/cli/)
- [Documentation](https://ctrlyoke.dev/docs/)

## License

Commercial license with free-use terms; see the [ctrlyoke Commercial License](https://ctrlyoke.dev/terms) (also in `LICENSE.md`). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
