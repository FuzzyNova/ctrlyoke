import * as path from "path";
import * as fs from "fs/promises";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import { isPathWithinDirectory } from "./PathSecurity";
import { pathsEqual } from "./PathCasing";

const PROMPT_FILE_SUFFIX = ".prompt.md";
const MAX_SLUG_LENGTH = 80;
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export interface PromptFileWriterResult {
  filePath: string;
  fileName: string;
}

/** Writes user-created lone prompt files into the canonical workspace store. */
export class PromptFileWriter {
  constructor(private readonly workspaceRoot: string) {}

  async createPromptFile(
    text: string,
    suggestedName?: string
  ): Promise<PromptFileWriterResult> {
    if (typeof text !== "string") {
      throw new Error("Prompt text must be a string");
    }

    const promptsDirectory = await this.ensureCanonicalPromptsDirectory();
    const slug = this.deriveSlug(text, suggestedName);
    const baseName = slug
      ? `${slug}${PROMPT_FILE_SUFFIX}`
      : this.timestampName();

    for (let suffix = 1; suffix <= 10000; suffix++) {
      const fileName = this.withCollisionSuffix(baseName, suffix);
      const filePath = path.join(promptsDirectory, fileName);
      if (!isPathWithinDirectory(filePath, promptsDirectory)) {
        throw new Error("Prompt file path escaped the prompts directory");
      }

      let handle: fs.FileHandle;
      try {
        handle = await fs.open(filePath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }

      try {
        await handle.writeFile(text, "utf8");
        await handle.close();
        return { filePath, fileName };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.unlink(filePath).catch(() => undefined);
        throw error;
      }
    }

    throw new Error("Could not allocate a unique prompt file name");
  }

  private deriveSlug(text: string, suggestedName?: string): string | undefined {
    const name = suggestedName?.trim();
    if (name) {
      this.assertSafeSuggestedName(name);
      const slug = slugify(stripPromptFileSuffix(name));
      return slug ? this.assertSafeDeviceName(slug) : undefined;
    }

    const firstNonEmptyLine = text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);
    if (!firstNonEmptyLine) {
      return undefined;
    }

    const firstWords = firstNonEmptyLine
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join(" ");
    const slug = slugify(firstWords);
    return slug ? this.assertSafeDeviceName(slug) : undefined;
  }

  private assertSafeSuggestedName(name: string): void {
    if (
      name.includes("\0") ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      path.posix.isAbsolute(name) ||
      path.win32.isAbsolute(name)
    ) {
      throw new Error(`Unsafe prompt file name: "${name}"`);
    }

    const basename = stripPromptFileSuffix(name).split(/[.]/, 1)[0];
    if (WINDOWS_RESERVED_NAMES.has(basename.toLowerCase())) {
      throw new Error(`Reserved prompt file name: "${name}"`);
    }
  }

  private assertSafeDeviceName(slug: string): string {
    if (WINDOWS_RESERVED_NAMES.has(slug.toLowerCase())) {
      throw new Error(`Reserved prompt file name: "${slug}"`);
    }
    return slug;
  }

  private timestampName(now = new Date()): string {
    const pad = (value: number): string => value.toString().padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${PROMPT_FILE_SUFFIX}`;
  }

  private withCollisionSuffix(baseName: string, suffix: number): string {
    if (suffix === 1) {
      return baseName;
    }
    return `${baseName.slice(0, -PROMPT_FILE_SUFFIX.length)}-${suffix}${PROMPT_FILE_SUFFIX}`;
  }

  private async ensureCanonicalPromptsDirectory(): Promise<string> {
    const canonicalWorkspaceRoot = await fs.realpath(
      path.resolve(this.workspaceRoot)
    );
    const ctrlyokeDirectory = path.join(
      canonicalWorkspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR
    );
    await rejectSymlinkIfPresent(ctrlyokeDirectory);
    await fs.mkdir(ctrlyokeDirectory, { recursive: true });

    const canonicalCtrlyokeDirectory = await fs.realpath(ctrlyokeDirectory);
    if (
      !pathsEqual(canonicalCtrlyokeDirectory, ctrlyokeDirectory) ||
      !isPathWithinDirectory(canonicalCtrlyokeDirectory, canonicalWorkspaceRoot)
    ) {
      throw new Error("The .ctrlyoke directory resolves outside the workspace");
    }

    const promptsDirectory = path.join(
      canonicalCtrlyokeDirectory,
      PATH_CONSTANTS.PROMPTS_DIR
    );
    await rejectSymlinkIfPresent(promptsDirectory);
    await fs.mkdir(promptsDirectory, { recursive: true });
    const canonicalPromptsDirectory = await fs.realpath(promptsDirectory);
    if (
      !pathsEqual(canonicalPromptsDirectory, promptsDirectory) ||
      !isPathWithinDirectory(
        canonicalPromptsDirectory,
        canonicalCtrlyokeDirectory
      )
    ) {
      throw new Error("The prompts directory resolves outside .ctrlyoke");
    }
    return canonicalPromptsDirectory;
  }
}

function stripPromptFileSuffix(value: string): string {
  return value.replace(/\.prompt\.md$/i, "");
}

function slugify(value: string): string | undefined {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || undefined;
}

async function rejectSymlinkIfPresent(filePath: string): Promise<void> {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing symlinked prompt storage path: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
