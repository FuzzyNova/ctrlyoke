import type {
  WorkspacePathEntry,
  WorkspacePathStore,
} from "../../completions/WorkspacePathStore";

/** Every entry of a store, in store order, materialized for assertions. */
export function workspacePathStoreEntries(
  store: WorkspacePathStore
): WorkspacePathEntry[] {
  return Array.from({ length: store.size }, (_, position) =>
    store.entryAt(position)
  );
}
