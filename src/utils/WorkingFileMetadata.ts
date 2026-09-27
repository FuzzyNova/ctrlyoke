/** Removes lineage-owned fields left in pre-release run files. */
export function stripLegacyWorkingFileLineageMetadata<T extends object>(
  workingFile: T
): T {
  const record = workingFile as Record<string, unknown>;
  delete record.workflowName;
  delete record.originalFile;
  delete record.isFavorite;
  delete record.lastModifiedAt;
  return workingFile;
}
