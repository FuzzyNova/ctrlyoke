/**
 * StatuslineLauncher — a version-independent home for the statusline scripts
 * that global harness config points at (dev/backlog/CLI_DISTRIBUTION_PLAN.md
 * §3.4 rule 5).
 *
 * The statusline command lives in machine-global files (`~/.claude`,
 * `~/.copilot`, `~/.qwen` and agy's settings). Pointing it into a versioned
 * install folder meant every extension update moved the path, the extension
 * and the npm CLI kept re-pointing it at their own copies, and removing either
 * one left the harness running a deleted script. Each host instead copies the
 * scripts into `~/.ctrlyoke/bin/`, and only when its version is at least the
 * one recorded there: the newest wins and an older host never downgrades it.
 *
 * The directory is under `os.homedir()`, not `ctrlyokeStateHome()`: it is
 * referenced from harness config that is itself under the real home, so it
 * must not follow a `CTRLYOKE_HOME` override (isolated dev hosts and test
 * shards point that at temp folders that are later deleted).
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CTRLYOKE_DIR,
  STATUS_LINE_HARNESS_IDS,
  STATUSLINE_SCRIPT_FILE_NAMES,
  type StatusLineHarnessId,
} from "../../../types/DashboardConstants";
import { writeFileAtomic } from "../../../utils/AtomicFileUtils";
import { compareVersions } from "../../../utils/CtrlyokeInstallations";
import { withFileLock } from "../../../utils/FileLockUtils";

const LAUNCHER_DIRNAME = "bin";
const LAUNCHER_MANIFEST_FILE = "statusline-launcher.json";
const PACKAGE_SCRIPTS_DIR = path.join("out", "scripts");

/** The provider script a harness runs; it `require`s its shared siblings. */
export function statuslineScriptFileName(
  provider: StatusLineHarnessId
): string {
  return STATUSLINE_SCRIPT_FILE_NAMES[provider];
}

/** Every file the provider scripts need, copied as one set. */
export const STATUSLINE_LAUNCHER_FILES: readonly string[] = [
  "ctrlyoke-statusline-wrapper.js",
  "ctrlyoke-statusline-format.js",
  "ctrlyoke-format-migrations.js",
  ...Object.values(STATUS_LINE_HARNESS_IDS).map(statuslineScriptFileName),
];

interface LauncherManifest {
  /** ctrlyoke version whose scripts are in the directory. */
  version: string;
  /** Package root they were copied from, for diagnostics. */
  packageRoot: string;
  updatedAt: number;
}

/** `~/.ctrlyoke/bin`. */
export function statuslineLauncherDirectory(): string {
  return path.join(os.homedir(), CTRLYOKE_DIR, LAUNCHER_DIRNAME);
}

/** The package's own copy, used when the launcher cannot be deployed. */
export function packageStatuslineDirectory(packageRoot: string): string {
  return path.join(packageRoot, PACKAGE_SCRIPTS_DIR);
}

const deployments = new Map<string, Promise<string | undefined>>();

function launcherComplete(directory: string): boolean {
  return STATUSLINE_LAUNCHER_FILES.every((file) =>
    fs.existsSync(path.join(directory, file))
  );
}

function readPackageVersion(packageRoot: string): string | undefined {
  try {
    const version = (
      JSON.parse(
        fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
      ) as { version?: unknown }
    ).version;
    return typeof version === "string" && version.length > 0
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

async function readManifest(
  manifestPath: string
): Promise<LauncherManifest | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(manifestPath, "utf8")
    ) as Partial<LauncherManifest>;
    return typeof parsed.version === "string"
      ? (parsed as LauncherManifest)
      : undefined;
  } catch {
    return undefined;
  }
}

function digest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function fileDigest(filePath: string): Promise<string | undefined> {
  try {
    return digest(await fs.promises.readFile(filePath));
  } catch {
    return undefined;
  }
}

async function deploy(
  packageRoot: string,
  directory: string
): Promise<string | undefined> {
  try {
    const version = readPackageVersion(packageRoot);
    if (!version) {
      return undefined;
    }
    const sourceDirectory = packageStatuslineDirectory(packageRoot);
    const sources = await Promise.all(
      STATUSLINE_LAUNCHER_FILES.map(async (file) => ({
        file,
        contents: await fs.promises.readFile(path.join(sourceDirectory, file)),
      }))
    );
    await fs.promises.mkdir(directory, { recursive: true });
    const manifestPath = path.join(directory, LAUNCHER_MANIFEST_FILE);
    await withFileLock(manifestPath, async () => {
      const recorded = await readManifest(manifestPath);
      if (
        recorded &&
        compareVersions(recorded.version, version) > 0 &&
        launcherComplete(directory)
      ) {
        return;
      }
      let changed = recorded?.version !== version;
      for (const { file, contents } of sources) {
        const target = path.join(directory, file);
        if ((await fileDigest(target)) !== digest(contents)) {
          await writeFileAtomic(target, contents);
          changed = true;
        }
      }
      if (changed) {
        const manifest: LauncherManifest = {
          version,
          packageRoot,
          updatedAt: Date.now(),
        };
        await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
      }
    });
    return directory;
  } catch {
    return undefined;
  }
}

/**
 * Deploy this host's statusline scripts to the launcher directory when its
 * version is at least the one recorded there, and return that directory.
 * `undefined` means the launcher could not be deployed (no scripts in the
 * package, an unreadable version, a filesystem error); callers then use
 * {@link packageStatuslineDirectory}. Checked once per process unless the
 * launcher files disappear. Never throws.
 */
export function deployStatuslineLauncher(
  packageRoot: string
): Promise<string | undefined> {
  const directory = statuslineLauncherDirectory();
  const key = `${path.resolve(packageRoot)}\0${directory}`;
  let pending = deployments.get(key);
  if (!pending || !launcherComplete(directory)) {
    pending = deploy(packageRoot, directory);
    deployments.set(key, pending);
  }
  return pending;
}

/** The statusline script path to put in harness config for `provider`. */
export async function resolveStatuslineScriptPath(
  packageRoot: string,
  provider: StatusLineHarnessId
): Promise<string> {
  const directory =
    (await deployStatuslineLauncher(packageRoot)) ??
    packageStatuslineDirectory(packageRoot);
  return path.join(directory, statuslineScriptFileName(provider));
}

/** Delete the launcher directory's statusline files. Never throws. */
export async function removeStatuslineLauncher(): Promise<void> {
  const directory = statuslineLauncherDirectory();
  deployments.clear();
  await Promise.all(
    [...STATUSLINE_LAUNCHER_FILES, LAUNCHER_MANIFEST_FILE].map((file) =>
      fs.promises.rm(path.join(directory, file), { force: true })
    )
  ).catch(() => undefined);
  // Only removes the directory when nothing else was put in it.
  await fs.promises.rmdir(directory).catch(() => undefined);
}

/** Test hook: forget which package roots were already deployed. */
export function resetStatuslineLauncherCache(): void {
  deployments.clear();
}
