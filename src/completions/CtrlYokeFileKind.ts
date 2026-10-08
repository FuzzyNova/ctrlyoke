import {
  CTRLYOKE_FILE_KINDS,
  type CtrlYokeFileKind,
} from "../types/DashboardConstants";

/**
 * Single source for "is this a ctrlyoke file". Pure (no `vscode`, no `fs`) so the
 * extension, the Node language-server host and the hosted webview all import it.
 */
const CTRLYOKE_FILE_SUFFIXES: Readonly<
  Record<CtrlYokeFileKind, readonly string[]>
> = {
  [CTRLYOKE_FILE_KINDS.WORKFLOW_YAML]: [".ctrlyoke.yaml", ".ctrlyoke.yml"],
  [CTRLYOKE_FILE_KINDS.WORKFLOW_JSON]: [".ctrlyoke.json"],
  [CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN]: [".prompt.md"],
};

/** Basename-suffix match, case-insensitive; accepts `/` and `\` separators. */
export function getCtrlYokeFileKind(filePath: string): CtrlYokeFileKind | null {
  const baseName = filePath.slice(
    Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1
  );
  const lower = baseName.toLowerCase();
  for (const kind of Object.values(CTRLYOKE_FILE_KINDS)) {
    // A bare ".prompt.md" is a dotfile with no stem; require one.
    if (
      CTRLYOKE_FILE_SUFFIXES[kind].some(
        (suffix) => lower.length > suffix.length && lower.endsWith(suffix)
      )
    ) {
      return kind;
    }
  }
  return null;
}

/** VS Code document-selector globs for the given kinds (all kinds by default). */
export function getCtrlYokeFileGlobs(
  kinds: readonly CtrlYokeFileKind[] = Object.values(CTRLYOKE_FILE_KINDS)
): string[] {
  return kinds.flatMap((kind) =>
    CTRLYOKE_FILE_SUFFIXES[kind].map((suffix) => `**/*${suffix}`)
  );
}
