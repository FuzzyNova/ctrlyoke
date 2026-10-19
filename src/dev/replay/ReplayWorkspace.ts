import * as Diff from "diff";
import * as fs from "fs";
import * as path from "path";
import {
  CLI_EVENT_TYPES,
  CTRLYOKE_DIR,
  FILE_OPERATION_KINDS,
  LINE_ENDINGS,
} from "../../types/DashboardConstants";
import type { CliEvent } from "../../types/WebviewMessageTypes";
import type { WorkspaceSnapshot } from "../../types/OutputHistoryTypes";
import { Log } from "../../utils/Log";
import { isPathWithinDirectory } from "../../utils/PathSecurity";

/**
 * Puts a replayed run's file changes on disk, so the engine's own snapshot
 * capture finds real diffs and Undo works on real files. The snapshot a
 * recorded attempt left behind is the source of truth: each changed file's
 * after-state is its `beforeContent` with its `structuredPatch` applied.
 * A whole-file `fileWrite` event lands when it streams, which also covers
 * files snapshots exclude (everything under `.ctrlyoke/`).
 */

/** ctrlyoke's own state; a replay never writes these. */
const RESERVED_CTRLYOKE_PATHS = ["settings.json", "temp", "logs", "dev"].map(
  (entry) => path.join(CTRLYOKE_DIR, entry)
);

function resolveInside(
  workspaceRoot: string,
  filePath: string
): string | undefined {
  const absolute = path.resolve(workspaceRoot, filePath);
  if (!isPathWithinDirectory(absolute, path.resolve(workspaceRoot)))
    return undefined;
  const relative = path.relative(workspaceRoot, absolute);
  if (
    RESERVED_CTRLYOKE_PATHS.some((reserved) =>
      isPathWithinDirectory(relative, reserved)
    )
  ) {
    return undefined;
  }
  return absolute;
}

async function writeFile(absolute: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  await fs.promises.writeFile(absolute, content, "utf8");
}

/** Writes every whole-file write among `events` that lands inside the workspace. */
export async function applyRecordedFileWrites(
  workspaceRoot: string,
  events: readonly CliEvent[]
): Promise<void> {
  for (const event of events) {
    if (event.type !== CLI_EVENT_TYPES.FILE_WRITE) continue;
    const data = event.data as { path?: unknown; content?: unknown };
    if (typeof data.path !== "string" || typeof data.content !== "string")
      continue;
    const absolute = resolveInside(workspaceRoot, data.path);
    if (absolute) await writeFile(absolute, data.content);
  }
}

/** Brings every file `snapshot` lists to the state the recorded attempt left it in. */
export async function applySnapshotAfterState(
  workspaceRoot: string,
  snapshot: WorkspaceSnapshot
): Promise<void> {
  for (const change of snapshot.changedFiles) {
    const absolute = resolveInside(workspaceRoot, change.path);
    if (!absolute) continue;
    if (change.changeType === FILE_OPERATION_KINDS.DELETED) {
      await fs.promises.rm(absolute, { force: true });
      continue;
    }
    if (!change.structuredPatch) {
      // A created file recorded without content has nothing to rebuild from.
      if (!fs.existsSync(absolute)) {
        Log.debug(
          `[RunReplay] no recorded content for ${change.path}; left as is`
        );
      }
      continue;
    }
    const onDisk = await fs.promises
      .readFile(absolute, "utf8")
      .catch(() => undefined);
    const before = change.beforeContent ?? onDisk ?? "";
    // Patches are LF; keep the file's own endings when the snapshot omits them.
    const crlf =
      change.lineEnding === LINE_ENDINGS.CRLF ||
      onDisk?.includes("\r\n") === true;
    const after = Diff.applyPatch(before.replace(/\r\n/g, "\n"), {
      oldFileName: undefined,
      newFileName: undefined,
      oldHeader: undefined,
      newHeader: undefined,
      hunks: change.structuredPatch,
    });
    if (after === false) {
      Log.warn(
        `[RunReplay] recorded patch for ${change.path} does not apply; left as is`
      );
      continue;
    }
    await writeFile(absolute, crlf ? after.replace(/\n/g, "\r\n") : after);
  }
}
