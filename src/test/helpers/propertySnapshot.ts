/**
 * Snapshot a property's descriptor so a stub can be undone exactly, and return
 * the undo.
 *
 * Use this, not `const original = obj.prop` plus
 * `Object.defineProperty(obj, prop, { value: original })`, for any property
 * that is a getter. `vscode.workspace.workspaceFolders`/`textDocuments` and
 * `vscode.window.activeTextEditor`/`visibleTextEditors` all are: reading one
 * captures a snapshot, and restoring it as a `value` replaces the live getter
 * with that snapshot for the rest of the extension host. Every later test file
 * in the shard then sees a frozen list, which is how `PromptDiagnosticsProvider`
 * failed only under `npm test` (its re-check walks `textDocuments`).
 */
export function snapshotProperty<T extends object>(
  target: T,
  key: keyof T & string
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return () => {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    } else {
      delete (target as Record<string, unknown>)[key];
    }
  };
}
