/**
 * How long a download's object URL stays alive after the click. Chrome on
 * Android reads the blob asynchronously after `click()` returns, so revoking
 * synchronously can leave the download with nothing to read.
 */
const OBJECT_URL_REVOKE_DELAY_MS = 60_000;

/** Trigger a browser file download for an in-memory blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS);
}

/**
 * Trigger a browser file download for arbitrary text content.
 * Shared by ContentPreviewModal, DryRunModal and the WorkspaceDiffPane download button.
 */
export function downloadTextFile(filename: string, content: string): void {
  downloadBlob(filename, new Blob([content], { type: "text/plain" }));
}
