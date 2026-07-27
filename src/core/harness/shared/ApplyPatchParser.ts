import { UnifiedDiffHunk } from "../../../types/CliOutputTypes";
import { Log } from "../../../utils/Log";

export interface ApplyPatchFileEdit {
  path: string;
  kind: "add" | "update" | "delete";
  structuredPatch?: UnifiedDiffHunk[];
}

export class ApplyPatchParser {
  static parse(patchInput: string): UnifiedDiffHunk[] | undefined {
    try {
      const lines = patchInput.split("\n");
      const hunks: UnifiedDiffHunk[] = [];
      let currentHunk: UnifiedDiffHunk | null = null;
      let oldLineNum = 1;
      let newLineNum = 1;
      let inPatch = false;

      for (const line of lines) {
        if (line.startsWith("*** Begin Patch")) {
          inPatch = true;
          continue;
        }

        if (line.startsWith("*** End Patch")) {
          if (currentHunk && currentHunk.lines.length > 0) {
            hunks.push(currentHunk);
          }
          break;
        }

        if (!inPatch) {
          continue;
        }

        if (
          line.startsWith("*** Add File:") ||
          line.startsWith("*** Update File:")
        ) {
          oldLineNum = 1;
          newLineNum = 1;
          continue;
        }

        if (line === "@@" || line.startsWith("@@")) {
          if (currentHunk && currentHunk.lines.length > 0) {
            hunks.push(currentHunk);
          }
          currentHunk = {
            oldStart: oldLineNum,
            oldLines: 0,
            newStart: newLineNum,
            newLines: 0,
            lines: [],
          };
          continue;
        }

        if (!currentHunk) {
          continue;
        }

        if (line.startsWith("+")) {
          currentHunk.lines.push(line);
          currentHunk.newLines++;
          newLineNum++;
          continue;
        }

        if (line.startsWith("-")) {
          currentHunk.lines.push(line);
          currentHunk.oldLines++;
          oldLineNum++;
          continue;
        }

        currentHunk.lines.push(
          " " + line.substring(line.startsWith(" ") ? 1 : 0)
        );
        currentHunk.oldLines++;
        currentHunk.newLines++;
        oldLineNum++;
        newLineNum++;
      }

      if (currentHunk && currentHunk.lines.length > 0) {
        hunks.push(currentHunk);
      }

      return hunks.length > 0 ? hunks : undefined;
    } catch (error) {
      Log.debug(`[ApplyPatchParser] Failed to parse patch input: ${error}`);
      return undefined;
    }
  }

  static parseFileEdits(patchInput: string): ApplyPatchFileEdit[] {
    try {
      const lines = patchInput.split("\n");
      const fileEdits: ApplyPatchFileEdit[] = [];

      let currentFile:
        | {
            path: string;
            kind: ApplyPatchFileEdit["kind"];
            hunks: UnifiedDiffHunk[];
          }
        | undefined;
      let currentHunk: UnifiedDiffHunk | undefined;
      let oldLineNum = 1;
      let newLineNum = 1;
      let inPatch = false;

      const flushHunk = (): void => {
        if (currentFile && currentHunk && currentHunk.lines.length > 0) {
          currentFile.hunks.push(currentHunk);
        }
        currentHunk = undefined;
      };

      const flushFile = (): void => {
        flushHunk();
        if (!currentFile) {
          return;
        }
        fileEdits.push({
          path: currentFile.path,
          kind: currentFile.kind,
          structuredPatch:
            currentFile.hunks.length > 0 ? currentFile.hunks : undefined,
        });
        currentFile = undefined;
      };

      const ensureCurrentHunk = (): UnifiedDiffHunk | undefined => {
        if (!currentFile) {
          return undefined;
        }
        if (!currentHunk) {
          currentHunk = {
            oldStart: oldLineNum,
            oldLines: 0,
            newStart: newLineNum,
            newLines: 0,
            lines: [],
          };
        }
        return currentHunk;
      };

      for (const line of lines) {
        if (line.startsWith("*** Begin Patch")) {
          inPatch = true;
          continue;
        }

        if (!inPatch) {
          continue;
        }

        if (line.startsWith("*** End Patch")) {
          flushFile();
          break;
        }

        const fileMatch = line.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/);
        if (fileMatch) {
          flushFile();
          const kind = line.startsWith("*** Add File:")
            ? "add"
            : line.startsWith("*** Delete File:")
              ? "delete"
              : "update";
          currentFile = {
            path: fileMatch[1].trim(),
            kind,
            hunks: [],
          };
          oldLineNum = 1;
          newLineNum = 1;
          continue;
        }

        if (line.startsWith("*** Move to:")) {
          if (currentFile) {
            currentFile.path = line.replace("*** Move to:", "").trim();
          }
          continue;
        }

        if (line === "@@" || line.startsWith("@@")) {
          flushHunk();
          if (!currentFile) {
            continue;
          }
          currentHunk = {
            oldStart: oldLineNum,
            oldLines: 0,
            newStart: newLineNum,
            newLines: 0,
            lines: [],
          };
          continue;
        }

        if (line.startsWith("*** End of File")) {
          continue;
        }

        const hunk = ensureCurrentHunk();
        if (!hunk) {
          continue;
        }

        if (line.startsWith("+")) {
          hunk.lines.push(line);
          hunk.newLines++;
          newLineNum++;
          continue;
        }

        if (line.startsWith("-")) {
          hunk.lines.push(line);
          hunk.oldLines++;
          oldLineNum++;
          continue;
        }

        hunk.lines.push(" " + line.substring(line.startsWith(" ") ? 1 : 0));
        hunk.oldLines++;
        hunk.newLines++;
        oldLineNum++;
        newLineNum++;
      }

      flushFile();
      return fileEdits;
    } catch (error) {
      Log.debug(
        `[ApplyPatchParser] Failed to parse patch file edits: ${error}`
      );
      return [];
    }
  }

  static extractFirstPath(patchInput: string): string | undefined {
    const fileMatch = patchInput.match(
      /\*\*\* (?:Add|Update|Delete) File: (.+)/
    );
    return fileMatch?.[1]?.trim();
  }
}
