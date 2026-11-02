/** Shared dashboard/backend decision and wording for imported output undo. */
export const IMPORTED_OUTPUT_READ_ONLY_MESSAGE =
  "This output was imported and is read-only.";

export function isPreImportOutput(
  outputSequence: number | undefined,
  importedSequenceBoundary: number | undefined
): boolean {
  return (
    outputSequence !== undefined &&
    importedSequenceBoundary !== undefined &&
    outputSequence < importedSequenceBoundary
  );
}
