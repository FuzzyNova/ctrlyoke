/**
 * Workflow-property patches lose their deletes on the way to the extension.
 *
 * Every webview -> extension message is serialized as JSON, and `JSON.stringify`
 * drops object members whose value is `undefined`. A workflow-property patch
 * uses exactly that value to mean "remove this property", so a patch built as
 * `{ trustedExternalRoots: undefined }` arrives as `{}` and the write is
 * skipped entirely. The sender therefore lists the keys it is clearing
 * alongside the patch, and the receiving handler re-materializes them here
 * before `applyWorkflowPropertyWrites` sees them.
 *
 * This matters most for undo: an undo snapshot is the complete normalized
 * property set, so the keys it holds as `undefined` are precisely the ones the
 * restored state did not have. Without them an undo can only ever overwrite a
 * property, never take it back off the workflow.
 */
export function restoreClearedWorkflowProperties(
  properties: Record<string, unknown> | undefined,
  clearedKeys: readonly string[] | undefined
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...(properties ?? {}) };
  for (const key of clearedKeys ?? []) {
    patch[key] = undefined;
  }
  return patch;
}
