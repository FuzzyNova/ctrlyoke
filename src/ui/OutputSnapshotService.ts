import { outputCaptureCache } from "../completions/OutputCaptureCache";
import { buildFileReferenceValue } from "../completions/ContextReferenceBuilder";
import { TempFileManager } from "../utils/TempFileManager";

/**
 * Persist a pending output completion capture and return the workspace-
 * relative reference value used by prompt editors.
 *
 * This is deliberately independent of the webview transport so the native
 * VS Code completion command and the dashboard message handler share the
 * cache-consumption and attachment-writing behavior.
 */
export async function savePendingOutputSnapshot(
  getWorkspaceRoot: () => string,
  captureId: string
): Promise<string> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error("No workspace folder open");
  }

  const entry = outputCaptureCache.take(captureId);
  if (!entry) {
    throw new Error("Output capture expired — try again");
  }

  const tempFileManager = new TempFileManager(workspaceRoot);
  const absolutePath = await tempFileManager.createOutputSnapshotFile(
    entry.text,
    entry.channel,
    entry.range,
    tempFileManager.getAttachmentsDir()
  );
  return buildFileReferenceValue(tempFileManager.getRelativePath(absolutePath));
}
