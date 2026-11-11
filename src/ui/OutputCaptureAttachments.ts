import {
  outputCaptureCache,
  type OutputCaptureEntry,
} from "../completions/OutputCaptureCache";
import { TempFileManager } from "../utils/TempFileManager";

/** Write an output capture to the workspace attachment store. */
export async function writeOutputCaptureAttachment(
  getWorkspaceRoot: () => string,
  entry: OutputCaptureEntry
): Promise<string> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error("No workspace folder open");
  }

  const tempFileManager = new TempFileManager(workspaceRoot);
  const absolutePath = await tempFileManager.createOutputCaptureFile(
    entry.text,
    entry.channel,
    entry.range,
    tempFileManager.getAttachmentsDir()
  );
  return tempFileManager.getRelativePath(absolutePath).replace(/\\/g, "/");
}

/**
 * Persist a pending output completion capture and return the workspace-
 * relative path used to build a prompt reference.
 *
 * This is deliberately independent of the webview transport so the native
 * VS Code completion command and the dashboard message handler share the
 * cache-consumption and attachment-writing behavior.
 */
export async function savePendingOutputCapture(
  getWorkspaceRoot: () => string,
  captureId: string
): Promise<string> {
  const entry = outputCaptureCache.take(captureId);
  if (!entry) {
    throw new Error("Output capture expired — try again");
  }
  return writeOutputCaptureAttachment(getWorkspaceRoot, entry);
}
