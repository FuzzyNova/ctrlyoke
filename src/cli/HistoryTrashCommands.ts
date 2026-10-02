import { bootstrapCliWorkspace } from "./CliWorkspaceBootstrap";
import type { HistoryCommandIo } from "./HistoryCommands";
import type {
  HistoryTrashEmptyOptions,
  HistoryTrashListOptions,
  HistoryTrashPurgeOptions,
  HistoryTrashRestoreOptions,
} from "./HistoryCommandDefinitions";
import {
  HISTORY_TRASH_REQUESTERS,
  HistoryTrashRepository,
} from "../core/orchestration/HistoryTrashRepository";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { formatBytes } from "../utils/ByteFormat";
import {
  describeRestoreResult,
  describeTrashEntry,
} from "../utils/HistoryTrashDescriptions";

export interface HistoryTrashCommandDependencies {
  bootstrapCliWorkspace?: (options: {
    cwd?: string;
  }) => Promise<{ workspaceRoot: string }>;
  now?: () => number;
}

async function openTrash(
  options: { cwd?: string },
  dependencies: HistoryTrashCommandDependencies
): Promise<HistoryTrashRepository> {
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )(options);
  return new HistoryTrashRepository(workspace.workspaceRoot);
}

async function confirmDestructive(
  yes: boolean | undefined,
  io: HistoryCommandIo,
  question: string
): Promise<boolean> {
  if (yes) return true;
  if (!io.isInteractive) {
    throw new Error("Refusing to delete permanently without --yes.");
  }
  return io.confirm(question);
}

function formatAge(deletedAt: number, now: number): string {
  const hours = Math.floor((now - deletedAt) / (60 * 60 * 1000));
  if (hours < 1) return "just now";
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `history trash list`: Recently deleted, newest first. Also purges expired entries. */
export async function listTrashCommand(
  options: HistoryTrashListOptions,
  io: Pick<HistoryCommandIo, "writeOut">,
  dependencies: HistoryTrashCommandDependencies = {}
): Promise<void> {
  const trash = await openTrash(options, dependencies);
  const retentionDays = ConfigurationUtils.getTrashRetentionDays();
  const now = dependencies.now?.() ?? Date.now();
  await trash.purgeExpired(retentionDays, now);
  const entries = await trash.list(retentionDays);
  if (options.json) {
    io.writeOut(JSON.stringify({ schemaVersion: 1, retentionDays, entries }));
    return;
  }
  if (entries.length === 0) {
    io.writeOut("Recently deleted is empty.");
    return;
  }
  for (const entry of entries) {
    const daysLeft = Math.max(
      0,
      Math.ceil((entry.expiresAt - now) / (24 * 60 * 60 * 1000))
    );
    io.writeOut(
      `${entry.id}  ${describeTrashEntry(entry)}  ${formatBytes(entry.bytes)}  deleted ${formatAge(entry.deletedAt, now)}, ${daysLeft}d left`
    );
  }
  io.writeOut(
    `\nRestore with: ctrlyoke history trash restore <id>. Items are removed after ${retentionDays} days.`
  );
}

/** `history trash restore <id>`: puts an entry back. */
export async function restoreTrashCommand(
  entryId: string,
  options: HistoryTrashRestoreOptions,
  io: Pick<HistoryCommandIo, "writeOut">,
  dependencies: HistoryTrashCommandDependencies = {}
): Promise<void> {
  const trash = await openTrash(options, dependencies);
  io.writeOut(describeRestoreResult(await trash.restore(entryId)));
}

/** `history trash purge <id>`: permanently deletes one entry. */
export async function purgeTrashCommand(
  entryId: string,
  options: HistoryTrashPurgeOptions,
  io: HistoryCommandIo,
  dependencies: HistoryTrashCommandDependencies = {}
): Promise<void> {
  const trash = await openTrash(options, dependencies);
  if (
    !(await confirmDestructive(
      options.yes,
      io,
      `Permanently delete ${entryId}? This cannot be undone.`
    ))
  ) {
    return;
  }
  await trash.purge(entryId, `requested by ${HISTORY_TRASH_REQUESTERS.CLI}`);
  io.writeOut(`Permanently deleted ${entryId}.`);
}

/** `history trash empty`: permanently deletes everything in Recently deleted. */
export async function emptyTrashCommand(
  options: HistoryTrashEmptyOptions,
  io: HistoryCommandIo,
  dependencies: HistoryTrashCommandDependencies = {}
): Promise<void> {
  const trash = await openTrash(options, dependencies);
  const entries = await trash.list(0);
  if (entries.length === 0) {
    io.writeOut("Recently deleted is already empty.");
    return;
  }
  if (
    !(await confirmDestructive(
      options.yes,
      io,
      `Permanently delete all ${entries.length} items in Recently deleted? This cannot be undone.`
    ))
  ) {
    return;
  }
  const count = await trash.purgeAll(
    `emptied by ${HISTORY_TRASH_REQUESTERS.CLI}`
  );
  io.writeOut(
    `Permanently deleted ${count} ${count === 1 ? "item" : "items"}.`
  );
}
