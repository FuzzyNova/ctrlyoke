export interface WorkspaceRenameConfirmation {
  fileCount: number;
  respond: (confirmed: boolean) => void;
}

let current: WorkspaceRenameConfirmation | null = null;
const listeners = new Set<() => void>();

export function subscribeWorkspaceRenameConfirmation(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWorkspaceRenameConfirmation(): WorkspaceRenameConfirmation | null {
  return current;
}

function setCurrent(next: WorkspaceRenameConfirmation | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function confirmWorkspaceRename(fileCount: number): Promise<boolean> {
  current?.respond(false);
  return new Promise((resolve) => {
    setCurrent({
      fileCount,
      respond: (confirmed) => {
        setCurrent(null);
        resolve(confirmed);
      },
    });
  });
}
