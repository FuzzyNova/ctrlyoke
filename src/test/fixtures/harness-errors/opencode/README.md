# OpenCode capture attempts

The installed OpenCode CLI is 1.19.5. A v1 plugin was loaded in a fresh scratch workspace and given a local invalid API endpoint; it emitted start and repeated busy/user-prompt hook artifacts, but continued retrying until the 85-second cap without a `session.error` payload. No v1 error fixture is available.

The npm registry has no `opencode-ai@2` release (`npm view opencode-ai@2` returned 404). The installed `latest` is 1.19.5; installing the `beta` tag produced `0.0.0-beta-202608110357`, not a 2.x CLI. Therefore the v2 plugin path and immediate-idle ordering could not be exercised. These questions remain open for later phases.
