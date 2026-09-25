The `ctrlyoke` command-line tool is already on `PATH` in VS Code's integrated terminals, so
`ctrlyoke run`, `ctrlyoke validate` and `ctrlyoke append` work there with no setup.

To use it outside VS Code (another terminal, CI, a server), install the matching version from
npm. [Install CLI](command:ctrlyoke.installCli) opens a terminal with the install command typed
in for you to review and run. It needs Node.js 22.12 or later.

Keep that copy on the same version as the extension. The CLI warns you when it falls behind.
