/**
 * CtrlyokeInstallations — lets the VS Code extension and the npm CLI know
 * about each other (dev/backlog/CLI_DISTRIBUTION_PLAN.md §3.4 rule 2).
 *
 * Every host records `{ kind, version, packageRoot, lastSeen }` in
 * `<ctrlyokeStateHome>/installations.json` on startup. The CLI warns when a
 * newer extension is recorded; the extension warns when an older npm CLI is.
 * VS Code auto-updates and npm global installs do not, so in practice this is
 * "the npm CLI is behind the extension".
 *
 * Best effort throughout: a registry failure is never allowed to fail the
 * host. Node-only and `vscode`-free.
 */

import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./AtomicFileUtils";
import { withFileLock } from "./FileLockUtils";
import { foldPathForCompare } from "./PathCasing";
import { ctrlyokeStateHome } from "./ProjectStatePaths";
import {
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
  isNewerSchemaVersion,
  readSchemaVersion,
} from "./PersistedSchemaGuard";
import { migrateToCurrent } from "./FormatMigrations";

export const INSTALLATIONS_FILE_NAME = "installations.json";

/** Which kind of host recorded an installation. */
export const INSTALLATION_KINDS = {
  VSCODE_EXTENSION: "vscode-extension",
  CLI: "cli",
} as const;

export type InstallationKind =
  (typeof INSTALLATION_KINDS)[keyof typeof INSTALLATION_KINDS];

export const INSTALLATIONS_SCHEMA_VERSION =
  CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.INSTALLATIONS];
const warnedNewerInstallationsFiles = new Set<string>();

/** Entries not seen for this long are ignored and pruned. */
const INSTALLATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface InstallationRecord {
  kind: InstallationKind;
  version: string;
  packageRoot: string;
  lastSeen: number;
  /**
   * The history search index version this host reads and writes. Hosts from
   * before per-version index directories leave it unset.
   */
  indexSchemaVersion?: number;
}

interface InstallationsFile {
  schemaVersion: number;
  /**
   * Keyed by kind and case-folded package root: the CLI bundled in the VSIX
   * shares the extension's root and must not overwrite its record.
   */
  installations: Record<string, InstallationRecord>;
  /** Mismatch warnings already shown, keyed by {@link mismatchNoticeKey}. */
  notices?: Record<string, number>;
  /** Process-local read-only marker; never serialized. */
  newerSchema?: boolean;
}

function warnNewerInstallationsFile(filePath: string, version: number): void {
  if (warnedNewerInstallationsFiles.has(filePath)) return;
  warnedNewerInstallationsFiles.add(filePath);
  process.stderr.write(
    `The installation registry at ${filePath} uses format ${version}; this ctrlyoke supports format ${INSTALLATIONS_SCHEMA_VERSION}. It can be read but will not be modified.\n`
  );
}

export function installationsFilePath(): string {
  return path.join(ctrlyokeStateHome(), INSTALLATIONS_FILE_NAME);
}

/**
 * Compare dotted numeric versions (`0.10.0` > `0.9.3`). A pre-release suffix
 * is ignored; this only has to order ctrlyoke's own release versions.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) =>
    version
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function emptyFile(): InstallationsFile {
  return { schemaVersion: INSTALLATIONS_SCHEMA_VERSION, installations: {} };
}

async function readFile(filePath: string): Promise<InstallationsFile> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(filePath, "utf8")
    ) as Partial<InstallationsFile>;
    const version = readSchemaVersion(parsed);
    if (isNewerSchemaVersion(PERSISTED_STORES.INSTALLATIONS, version)) {
      warnNewerInstallationsFile(filePath, version!);
      return {
        schemaVersion: version!,
        installations:
          parsed &&
          typeof parsed.installations === "object" &&
          parsed.installations !== null
            ? parsed.installations
            : {},
        ...(parsed?.notices ? { notices: parsed.notices } : {}),
        newerSchema: true,
      };
    }
    if (!parsed || typeof parsed.installations !== "object") {
      return emptyFile();
    }
    const migrated = migrateToCurrent(PERSISTED_STORES.INSTALLATIONS, parsed)
      .doc as Partial<InstallationsFile>;
    return {
      schemaVersion: INSTALLATIONS_SCHEMA_VERSION,
      installations: migrated.installations ?? {},
      ...(migrated.notices ? { notices: migrated.notices } : {}),
    };
  } catch {
    return emptyFile();
  }
}

function isLive(record: InstallationRecord, now: number): boolean {
  return (
    now - record.lastSeen <= INSTALLATION_MAX_AGE_MS &&
    fs.existsSync(record.packageRoot)
  );
}

/** Every installation seen in the last 30 days whose folder still exists. */
export async function readLiveInstallations(
  now: number = Date.now()
): Promise<InstallationRecord[]> {
  const file = await readFile(installationsFilePath());
  return Object.values(file.installations).filter((record) =>
    isLive(record, now)
  );
}

/**
 * How many distinct installations are live. The CLI bundled in the VSIX shares
 * its extension's folder, so the two count once. A host that recorded itself
 * at startup counts itself.
 */
export async function countLiveInstallationRoots(
  now: number = Date.now()
): Promise<number> {
  return new Set(
    (await readLiveInstallations(now)).map((record) =>
      foldPathForCompare(path.resolve(record.packageRoot))
    )
  ).size;
}

/**
 * Key for "this host already warned about this pair of versions". The
 * audience is part of it so the CLI's warning never silences the extension's.
 */
export function mismatchNoticeKey(
  audience: InstallationKind,
  older: Pick<InstallationRecord, "kind" | "version">,
  newer: Pick<InstallationRecord, "kind" | "version">
): string {
  return `${audience}:${older.kind}@${older.version}<${newer.kind}@${newer.version}`;
}

export interface RecordInstallationResult {
  /** Other live installations, newest first. */
  others: InstallationRecord[];
}

/**
 * Record this host, prune dead entries, and return the other live
 * installations. Never throws.
 */
export async function recordInstallation(
  self: Omit<InstallationRecord, "lastSeen">,
  now: number = Date.now()
): Promise<RecordInstallationResult> {
  const filePath = installationsFilePath();
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return await withFileLock(filePath, async () => {
      const file = await readFile(filePath);
      if (file.newerSchema) {
        return {
          others: Object.values(file.installations)
            .filter((record) => isLive(record, now))
            .sort((a, b) => compareVersions(b.version, a.version)),
        };
      }
      const selfKey = `${self.kind}:${foldPathForCompare(path.resolve(self.packageRoot))}`;
      const installations: Record<string, InstallationRecord> = {};
      for (const [key, record] of Object.entries(file.installations)) {
        if (key !== selfKey && isLive(record, now)) {
          installations[key] = record;
        }
      }
      installations[selfKey] = { ...self, lastSeen: now };
      await writeFileAtomic(
        filePath,
        JSON.stringify({ ...file, installations }, null, 2)
      );
      return {
        others: Object.entries(installations)
          .filter(([key]) => key !== selfKey)
          .map(([, record]) => record)
          .sort((a, b) => compareVersions(b.version, a.version)),
      };
    });
  } catch {
    return { others: [] };
  }
}

/**
 * The CLI's view: the newest extension recorded that is newer than this CLI,
 * unless that pair was already warned about.
 */
export function findNewerExtension(
  self: InstallationRecord,
  others: readonly InstallationRecord[],
  alreadyNoticed: (key: string) => boolean
): InstallationRecord | undefined {
  return others.find(
    (other) =>
      other.kind === INSTALLATION_KINDS.VSCODE_EXTENSION &&
      compareVersions(other.version, self.version) > 0 &&
      !alreadyNoticed(mismatchNoticeKey(self.kind, self, other))
  );
}

/**
 * The extension's view: an npm CLI older than this extension. The CLI bundled
 * inside an extension shares that extension's package root and version, so
 * it never matches.
 */
export function findOlderCli(
  self: InstallationRecord,
  others: readonly InstallationRecord[]
): InstallationRecord | undefined {
  return others.find(
    (other) =>
      other.kind === INSTALLATION_KINDS.CLI &&
      compareVersions(other.version, self.version) < 0
  );
}

/** Whether a mismatch notice was already shown. Never throws. */
export async function hasShownNotice(key: string): Promise<boolean> {
  return (await readFile(installationsFilePath())).notices?.[key] !== undefined;
}

/** Remember that a mismatch notice was shown. Never throws. */
export async function markNoticeShown(
  key: string,
  now: number = Date.now()
): Promise<void> {
  const filePath = installationsFilePath();
  try {
    await withFileLock(filePath, async () => {
      const file = await readFile(filePath);
      if (file.newerSchema) return;
      await writeFileAtomic(
        filePath,
        JSON.stringify(
          { ...file, notices: { ...file.notices, [key]: now } },
          null,
          2
        )
      );
    });
  } catch {
    // Best effort: the worst case is the notice shows again.
  }
}
