import * as fs from "fs/promises";
import type { WorkingFile } from "../../types/CtrlYokeTypes";
import { writeAnchoredRunDefinition } from "../../utils/RunDefinitionAnchor";

/**
 * Write a run file the way another ctrlyoke process would: through the
 * definition anchor, so the change is trusted rather than treated as an edit
 * made outside ctrlyoke. Use it to seed fixtures or stand in for a second
 * writer; a raw `fs` write is what tampering looks like.
 */
export async function writeTrustedRunFile(
  workingFilePath: string,
  workingFile: WorkingFile | Record<string, unknown>
): Promise<void> {
  await writeAnchoredRunDefinition(
    workingFilePath,
    workingFile as WorkingFile,
    () =>
      fs.writeFile(
        workingFilePath,
        JSON.stringify(workingFile, null, 2),
        "utf8"
      ),
    { overwriteChangedDefinition: true }
  );
}
