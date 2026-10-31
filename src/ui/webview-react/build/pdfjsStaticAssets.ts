/**
 * The pdf.js data directories the webview build copies to `pdfjs/`, and which
 * of their files ship. `vite.config.ts` builds its copy targets from this list
 * and `scripts/generate-third-party-notices.mjs` reads it to decide which
 * bundled licenses THIRD_PARTY_NOTICES.md must disclose, so the two cannot
 * drift. Keep this module free of imports: the notices script loads it with
 * Node's type stripping, outside Vite.
 */

/** One `pdfjs-dist` directory copied into the build. */
export interface PdfjsStaticDir {
  /** Directory name inside `node_modules/pdfjs-dist/` and under `pdfjs/` in the build. */
  readonly dir: string;
  /** Returns whether a file (path relative to `dir`) ships. Absent: every file ships. */
  readonly ships?: (relativePath: string) => boolean;
}

/**
 * Standard font files pdf.js can actually request from us. `WorkspacePdfViewer`
 * leaves `useSystemFonts` at its browser default (on), and with it on
 * `fetchStandardFontData` returns before fetching anything except Symbol and
 * ZapfDingbats; the other Foxit fonts and the Liberation Sans fonts are only
 * used when `useSystemFonts` is off. Liberation Sans is GPL-2.0, so turning
 * `useSystemFonts` off means shipping it again and disclosing it as GPL in
 * THIRD_PARTY_NOTICES.md (see the notices script).
 */
const SHIPPED_STANDARD_FONT_FILES = new Set([
  "FoxitSymbol.pfb",
  "FoxitDingbats.pfb",
  "LICENSE_FOXIT",
]);

export const PDFJS_STATIC_DIRS: readonly PdfjsStaticDir[] = [
  { dir: "cmaps" },
  {
    dir: "standard_fonts",
    ships: (relativePath) => SHIPPED_STANDARD_FONT_FILES.has(relativePath),
  },
  { dir: "iccs" },
  {
    dir: "wasm",
    // QuickJS is only for PDF scripting, which the viewer leaves off.
    ships: (relativePath) => !/^quickjs-eval\./i.test(relativePath),
  },
];
