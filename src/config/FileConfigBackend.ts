import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ConfigBackend } from "./CtrlYokeConfigService";
import type { PartialCtrlYokeSettings } from "../types/CtrlYokeSettings";

export class FileConfigBackend implements ConfigBackend {
  private cache?: PartialCtrlYokeSettings;
  // Serializes set() calls so a read-modify-write can't read a stale file out
  // from under a write that's still in flight. Two settings paths committed
  // back-to-back (e.g. TerminalControlBarEditor's addShortcut writing
  // mobileCustomShortcuts then mobileBarLayout) reach here as two overlapping
  // calls; without this queue, the second call's load() can run before the
  // first call's save() lands, so the second write clobbers the first.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly configPath: string) {}

  /** Returns the path this backend reads from */
  get filePath(): string {
    return this.configPath;
  }

  /** Load and parse the config file. Returns {} if file doesn't exist or is invalid JSON. */
  getAll(): PartialCtrlYokeSettings {
    if (this.cache !== undefined) {
      return this.cache;
    }
    this.cache = this.load();
    return this.cache;
  }

  /** Write a setting using dot-notation path (e.g. "execution.injectMode") */
  set(settingPath: string, value: unknown): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const current = this.load();
      this.setNestedValue(
        current as Record<string, unknown>,
        settingPath.split("."),
        value
      );
      await this.save(current);
      this.cache = undefined;
    });
    // Keep the queue alive even if this write rejects, but let the
    // rejection still surface to this call's own caller via `write`.
    this.writeQueue = write.catch(() => {});
    return write;
  }

  private load(): PartialCtrlYokeSettings {
    let content: string;
    try {
      content = fs.readFileSync(this.configPath, "utf-8");
    } catch {
      // File doesn't exist — return empty settings (expected on first use)
      return {};
    }
    try {
      return JSON.parse(content) as PartialCtrlYokeSettings;
    } catch {
      // File exists but contains invalid JSON (e.g. interrupted prior write).
      // Log to stderr so the user/developer can diagnose the issue.
      console.warn(
        `[ctrlyoke] Settings file has invalid JSON and will be treated as empty: ${this.configPath}`
      );
      return {};
    }
  }

  private async save(data: PartialCtrlYokeSettings): Promise<void> {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Atomic write: write to a temp file first, then rename over the target.
    // This prevents an interrupted write from leaving the settings file
    // empty/corrupt (which would cause the next set() call to silently
    // wipe all settings).
    const tmpPath = `${this.configPath}.tmp`;
    await fs.promises.writeFile(
      tmpPath,
      JSON.stringify(data, null, 2),
      "utf-8"
    );
    await fs.promises.rename(tmpPath, this.configPath);
  }

  private setNestedValue(
    obj: Record<string, unknown>,
    pathParts: string[],
    value: unknown
  ): void {
    if (pathParts.length === 0) return;

    if (pathParts.length === 1) {
      if (value === undefined) {
        delete obj[pathParts[0]];
      } else {
        obj[pathParts[0]] = value;
      }
      return;
    }

    const [head, ...rest] = pathParts;
    if (
      !(head in obj) ||
      typeof obj[head] !== "object" ||
      obj[head] === null ||
      Array.isArray(obj[head])
    ) {
      obj[head] = {};
    }
    this.setNestedValue(obj[head] as Record<string, unknown>, rest, value);
  }
}

/** Create a FileConfigBackend for the user global config (~/.ctrlyoke/settings.json) */
export function createUserConfigBackend(): FileConfigBackend {
  const configPath = path.join(os.homedir(), ".ctrlyoke", "settings.json");
  return new FileConfigBackend(configPath);
}

/** Create a FileConfigBackend for a workspace config (<workspaceRoot>/.ctrlyoke/settings.json) */
export function createWorkspaceConfigBackend(
  workspaceRoot: string
): FileConfigBackend {
  const configPath = path.join(workspaceRoot, ".ctrlyoke", "settings.json");
  return new FileConfigBackend(configPath);
}
