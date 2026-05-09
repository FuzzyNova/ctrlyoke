import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as chokidar from "chokidar";
import type { ConfigBackend } from "./FlightPathConfigService";
import type { PartialFlightPathSettings } from "../types/FlightPathSettings";

export class FileConfigBackend implements ConfigBackend {
  private cache?: PartialFlightPathSettings;
  private watcher?: chokidar.FSWatcher;

  constructor(
    private readonly configPath: string,
    private readonly onChanged?: () => void
  ) {}

  /** Returns the path this backend reads from */
  get filePath(): string {
    return this.configPath;
  }

  /** Load and parse the config file. Returns {} if file doesn't exist or is invalid JSON. */
  getAll(): PartialFlightPathSettings {
    if (this.cache !== undefined) {
      return this.cache;
    }
    this.cache = this.load();
    return this.cache;
  }

  /** Write a setting using dot-notation path (e.g. "execution.mode") */
  async set(settingPath: string, value: unknown): Promise<void> {
    const current = this.load();
    this.setNestedValue(
      current as Record<string, unknown>,
      settingPath.split("."),
      value
    );
    await this.save(current);
    this.cache = undefined;
  }

  /** Start watching the config file for external changes */
  startWatching(): void {
    if (this.watcher) return;

    const dir = path.dirname(this.configPath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // best-effort: if we can't create the dir, watching may not work
    }

    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      persistent: false,
    });

    const invalidate = (changedPath: string) => {
      if (path.resolve(changedPath) === path.resolve(this.configPath)) {
        this.cache = undefined;
        this.onChanged?.();
      }
    };

    this.watcher.on("add", invalidate);
    this.watcher.on("change", invalidate);
  }

  /** Stop watching */
  stopWatching(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = undefined;
    }
  }

  private load(): PartialFlightPathSettings {
    let content: string;
    try {
      content = fs.readFileSync(this.configPath, "utf-8");
    } catch {
      // File doesn't exist — return empty settings (expected on first use)
      return {};
    }
    try {
      return JSON.parse(content) as PartialFlightPathSettings;
    } catch {
      // File exists but contains invalid JSON (e.g. interrupted prior write).
      // Log to stderr so the user/developer can diagnose the issue.
      console.warn(
        `[FlightPath] Settings file has invalid JSON and will be treated as empty: ${this.configPath}`
      );
      return {};
    }
  }

  private async save(data: PartialFlightPathSettings): Promise<void> {
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

/** Create a FileConfigBackend for the user global config (~/.flightpath/settings.json) */
export function createUserConfigBackend(
  onChanged?: () => void
): FileConfigBackend {
  const configPath = path.join(os.homedir(), ".flightpath", "settings.json");
  return new FileConfigBackend(configPath, onChanged);
}

/** Create a FileConfigBackend for a workspace config (<workspaceRoot>/.flightpath/settings.json) */
export function createWorkspaceConfigBackend(
  workspaceRoot: string,
  onChanged?: () => void
): FileConfigBackend {
  const configPath = path.join(workspaceRoot, ".flightpath", "settings.json");
  return new FileConfigBackend(configPath, onChanged);
}
