import * as fs from "node:fs";
import * as path from "node:path";
import type { KeyValueStore } from "../core/HostPorts";
import { writeFileAtomic } from "../utils/AtomicFileUtils";
import { projectStateRoot } from "../utils/ProjectStatePaths";
import { getFrozenRunHistoryLocation } from "../utils/RunHistoryStoragePolicy";

/** Stores host-only dashboard state in the user's project state directory. */
export class FileKeyValueStore implements KeyValueStore {
  private readonly filePath: string;
  private readonly values: Record<string, unknown>;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(cwd: string) {
    this.filePath = path.join(
      projectStateRoot(cwd, getFrozenRunHistoryLocation()),
      "host-state.json"
    );
    this.values = this.readValues();
  }

  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;

    const contents = `${JSON.stringify(this.values, null, 2)}\n`;
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), {
          recursive: true,
        });
        await writeFileAtomic(this.filePath, contents);
      });
    return this.pendingWrite;
  }

  private readValues(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.filePath, "utf8")
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Expected an object in ${this.filePath}`);
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
}
