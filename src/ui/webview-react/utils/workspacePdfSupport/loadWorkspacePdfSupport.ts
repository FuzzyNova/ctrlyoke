import type * as PdfJs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export type WorkspacePdfSupport = typeof PdfJs;

/** Shared base path for the static data files required by pdf.js. */
export const PDFJS_ASSET_PATH = "/pdfjs/";

let loading: Promise<WorkspacePdfSupport> | null = null;

/** Load pdf.js only when a workspace PDF is first opened. */
export function loadWorkspacePdfSupport(): Promise<WorkspacePdfSupport> {
  loading ??= import("pdfjs-dist")
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}
