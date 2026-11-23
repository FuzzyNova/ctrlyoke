# Known issues

Problems that come from a harness CLI rather than from ctrlyoke, and that ctrlyoke cannot fix
itself. Each entry names the versions affected and what to do meanwhile. A harness's
[compatibility page](/harnesses/compatibility) lists the version ctrlyoke was last tested with; an
entry here means that release was tested with the issue present.

## Antigravity: `auto` permission mode cannot write the workspace on Windows {#antigravity-auto-sandbox}

**Affects:** Antigravity CLI (`agy`) on Windows, confirmed on 1.5.12 and 1.5.14. It worked on 1.5.8; the releases in between were not checked.

In `auto` permission mode, agy runs shell commands inside its own terminal sandbox. On Windows that
sandbox can refuse an approved command's write to the workspace with `EPERM`, so a command such as
`node script.js out.txt` runs but its output file is never created. ctrlyoke passes no `--sandbox`
flag, and neither a `write` allow rule nor `enableTerminalSandbox: false` lifts it. agy has no
setting that turns the sandbox off while keeping `auto`.

**What to do:** for steps whose shell commands must create or edit workspace files, set the
permission mode to `custom` or `allowAll`, or use another harness. See
[Antigravity CLI](/harnesses/antigravity-cli) for how each mode maps to agy's settings.

**Status:** an Antigravity CLI behavior. ctrlyoke re-checks it on each agy release and will gate
`auto` for the affected versions if it persists.
