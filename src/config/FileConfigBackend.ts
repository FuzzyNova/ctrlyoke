import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parse, stripComments, type ParseError } from "jsonc-parser";
import type { ConfigBackend } from "./CtrlYokeConfigService";
import type { PartialCtrlYokeSettings } from "../types/CtrlYokeSettings";
import {
  CURRENT_SCHEMA_VERSIONS,
  isNewerSchemaVersion,
  PERSISTED_STORES,
  readSchemaVersion,
  refuseNewerSchema,
} from "../utils/PersistedSchemaGuard";
import { Log } from "../utils/Log";
import { migrateToCurrent } from "../utils/FormatMigrations";
import { stripLeadingBom } from "../utils/TextUtils";
import { AsyncWriteQueue } from "./AsyncWriteQueue";
import { uniqueAtomicTempPath } from "./AtomicFileWrite";
import { foldPathForCompare } from "../utils/PathCasing";

const warnedNewerSettingsPaths = new Set<string>();
interface FileConfigBackendState {
  cache?: PartialCtrlYokeSettings;
  writeQueue: AsyncWriteQueue;
}

const backendStatesByPath = new Map<string, FileConfigBackendState>();
const FORBIDDEN_SETTING_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function getBackendState(configPath: string): FileConfigBackendState {
  const key = foldPathForCompare(path.resolve(configPath));
  let state = backendStatesByPath.get(key);
  if (!state) {
    state = { writeQueue: new AsyncWriteQueue() };
    backendStatesByPath.set(key, state);
  }
  return state;
}

export class FileConfigBackend implements ConfigBackend {
  // Serializes set() calls so a read-modify-write can't read a stale file out
  // from under a write that's still in flight. Two settings paths committed
  // back-to-back (e.g. TerminalControlBarEditor's addShortcut writing
  // mobileCustomShortcuts then mobileBarLayout) reach here as two overlapping
  // calls; without this queue, the second call's load() can run before the
  // first call's save() lands, so the second write clobbers the first.
  private readonly state: FileConfigBackendState;
  private readonly resolvedConfigPath: string;
  private newerSchemaVersion?: number;
  private hasInvalidContent = false;

  constructor(
    private readonly configPath: string,
    /** Set for a workspace-scope backend; see `ConfigBackend.workspaceRoot`. */
    readonly workspaceRoot?: string
  ) {
    // Use the same canonical path for reads and atomic writes. A path such as
    // `parent/../settings.json` can resolve to this file while still failing
    // when `parent` does not exist on POSIX.
    this.resolvedConfigPath = path.resolve(configPath);
    this.state = getBackendState(configPath);
  }

  /** Returns the path this backend reads from */
  get filePath(): string {
    return this.configPath;
  }

  get isReadOnly(): boolean {
    return this.newerSchemaVersion !== undefined;
  }

  /** Load and parse the config file. Returns {} if file doesn't exist or is invalid JSON. */
  getAll(): PartialCtrlYokeSettings {
    if (this.state.cache !== undefined) {
      return this.state.cache;
    }
    this.state.cache = this.load();
    return this.state.cache;
  }

  /** Write a setting using dot-notation path (e.g. "execution.injectMode") */
  set(settingPath: string, value: unknown): Promise<PartialCtrlYokeSettings> {
    const pathParts = settingPath.split(".");
    const forbiddenSegment = pathParts.find((part) =>
      FORBIDDEN_SETTING_PATH_SEGMENTS.has(part)
    );
    if (forbiddenSegment !== undefined) {
      throw new Error(
        `Cannot update settings path "${settingPath}": path segment "${forbiddenSegment}" is not allowed.`
      );
    }
    return this.state.writeQueue.enqueue(async () => {
      const current = this.load();
      if (this.newerSchemaVersion !== undefined) {
        refuseNewerSchema(
          PERSISTED_STORES.SETTINGS,
          this.newerSchemaVersion,
          this.configPath
        );
      }
      if (this.hasInvalidContent) {
        throw new Error(
          `Cannot update settings file because it contains invalid JSON: ${this.configPath}`
        );
      }
      const before = JSON.parse(
        JSON.stringify(current)
      ) as PartialCtrlYokeSettings;
      this.setNestedValue(current as Record<string, unknown>, pathParts, value);
      await this.save(current);
      this.state.cache = undefined;
      return before;
    });
  }

  private load(): PartialCtrlYokeSettings {
    this.hasInvalidContent = false;
    let content: string;
    try {
      content = fs.readFileSync(this.resolvedConfigPath, "utf-8");
    } catch {
      // File doesn't exist — return empty settings (expected on first use)
      return {};
    }
    const normalizedContent = stripLeadingBom(content);
    if (stripComments(normalizedContent).trim() === "") {
      return {};
    }
    try {
      const errors: ParseError[] = [];
      const parsed: unknown = parse(normalizedContent, errors, {
        allowTrailingComma: true,
      });
      if (errors.length > 0) {
        throw new Error("Invalid JSONC syntax");
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("Settings root must be an object");
      }
      const parsedSettings = parsed as PartialCtrlYokeSettings;
      const version = readSchemaVersion(parsedSettings);
      if (isNewerSchemaVersion(PERSISTED_STORES.SETTINGS, version)) {
        this.newerSchemaVersion = version;
        if (!warnedNewerSettingsPaths.has(this.configPath)) {
          warnedNewerSettingsPaths.add(this.configPath);
          Log.warn(
            `[FileConfigBackend] Reading newer settings format ${version} best-effort from ${this.configPath}; writes are disabled until ctrlyoke is updated.`
          );
        }
      }
      if (!isNewerSchemaVersion(PERSISTED_STORES.SETTINGS, version)) {
        return migrateToCurrent(PERSISTED_STORES.SETTINGS, parsedSettings)
          .doc as PartialCtrlYokeSettings;
      }
      return parsedSettings;
    } catch {
      // File exists but contains invalid JSONC. Reads remain best-effort, but
      // set() must not overwrite the user's only copy of the settings.
      this.hasInvalidContent = true;
      // Log to stderr so the user/developer can diagnose the issue.
      console.warn(
        `[ctrlyoke] Settings file has invalid JSON and will be treated as empty: ${this.configPath}`
      );
      return {};
    }
  }

  private async save(data: PartialCtrlYokeSettings): Promise<void> {
    // Never stamp `$schema`: in VS Code a document's `$schema` replaces the
    // extension's bundled `jsonValidation` association, so a remote URL would
    // break offline validation and pin dev builds to the published schema.
    data.schemaVersion = CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.SETTINGS];
    const dir = path.dirname(this.resolvedConfigPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Atomic write: write to a temp file first, then rename over the target.
    // This prevents an interrupted write from leaving the settings file
    // empty/corrupt (which would cause the next set() call to silently
    // wipe all settings).
    const tmpPath = uniqueAtomicTempPath(this.resolvedConfigPath);
    await fs.promises.writeFile(
      tmpPath,
      JSON.stringify(data, null, 2),
      "utf-8"
    );
    await fs.promises.rename(tmpPath, this.resolvedConfigPath);
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
    const hasOwnHead = Object.prototype.hasOwnProperty.call(obj, head);
    if (
      !hasOwnHead ||
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
  return new FileConfigBackend(configPath, workspaceRoot);
}
