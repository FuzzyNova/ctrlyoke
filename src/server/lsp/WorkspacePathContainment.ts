import * as fs from "node:fs";
import * as path from "node:path";
import { isPathWithinAnyDirectory } from "../../utils/PathSecurity";
import { fromViewerPath } from "../../platform/WorkspaceViewerPath";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";

export interface WorkspacePathContext {
  readonly workspaceRoot: string;
  readonly namedRoots: readonly ResolverWorkspaceFolder[];
  /** Additional roots are used only by the viewer's existing trust registry. */
  readonly trustedRoots?: readonly string[];
}

/** Resolve a viewer path only when both its lexical and real path stay in a workspace root. */
export function safeResolveWorkspacePath(
  viewerPath: string,
  context: WorkspacePathContext,
  options: { preserveLexicalPath?: boolean } = {}
): string | null {
  const workspaceRoots =
    context.namedRoots.length > 1
      ? context.namedRoots.map((root) => path.resolve(root.fsPath))
      : [path.resolve(context.workspaceRoot)];
  const roots = (context.trustedRoots ?? workspaceRoots).map((root) =>
    path.resolve(root)
  );
  const resolved = fromViewerPath(viewerPath, {
    primaryRoot: context.workspaceRoot,
    namedRoots: context.namedRoots,
  });
  if (!isPathWithinAnyDirectory(resolved, roots)) return null;

  try {
    const realResolved = fs.realpathSync(resolved);
    const realRoots = roots.map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return root;
      }
    });
    if (!isPathWithinAnyDirectory(realResolved, realRoots)) return null;
    return options.preserveLexicalPath ? resolved : realResolved;
  } catch {
    // A new file may not exist yet. Resolve its closest existing ancestor so
    // an intermediate symlink cannot escape the trusted root.
    let ancestor = path.dirname(resolved);
    while (ancestor !== path.dirname(ancestor)) {
      try {
        const realAncestor = fs.realpathSync(ancestor);
        const realRoots = roots.map((root) => {
          try {
            return fs.realpathSync(root);
          } catch {
            return root;
          }
        });
        if (!isPathWithinAnyDirectory(realAncestor, realRoots)) return null;
        return resolved;
      } catch {
        ancestor = path.dirname(ancestor);
      }
    }
    return resolved;
  }
}
