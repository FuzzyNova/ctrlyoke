import { initializeMcpStorage } from "../../mcp-server";
import { isRunHistoryLocationFrozenError } from "../../utils/RunHistoryStoragePolicy";

/**
 * Call {@link initializeMcpStorage} without caring whether an earlier test file
 * in this extension host already did.
 *
 * `initializeMcpStorage` freezes the run-history location, which is
 * process-wide state living in `out/mcp-server.js`'s own copy of
 * `RunHistoryStoragePolicy` — the real MCP server bootstraps once per process,
 * so a second call is a genuine error there. Under test it is not: several test
 * files need MCP storage, they share one extension host, and only the first of
 * them gets to do the freezing.
 *
 * That has to be tolerated here rather than at each call site, because *which*
 * file is first is not stable. `suite/sharding.ts` re-splits the suite across
 * hosts on every run using the previous run's recorded per-file timings, so two
 * files that shared a host today may not tomorrow. An unguarded second caller
 * therefore fails intermittently and lands in whichever file lost the toss —
 * exactly how `WebviewSettingsSync` came to fail while `McpServer` passed.
 *
 * The freeze itself is not undone: the location is `"user"` for the whole
 * extension-host run (`suite/index.ts`), and every test that needs a different
 * one drives the test module's own copy through
 * `resetRunHistoryLocationForTests`.
 */
export async function ensureMcpStorageInitialized(
  stateRoot?: string
): Promise<void> {
  try {
    await initializeMcpStorage(stateRoot);
  } catch (error) {
    if (!isRunHistoryLocationFrozenError(error)) {
      throw error;
    }
  }
}
