import { NOT_AFTER_BOUNDARY, NOT_BEFORE_BOUNDARY } from "./ReferenceBoundary";

/** Build a fresh regex for complete ~git-change references. */
export function createGitChangeReferencePattern(): RegExp {
  return new RegExp(
    `${NOT_AFTER_BOUNDARY}~(diff|staged|stash:(\\d+)|([0-9a-f]{7,40}))${NOT_BEFORE_BOUNDARY}`,
    "gi"
  );
}

/**
 * Canonical regexes for decorating prompt references (`@file`, `@dir/`,
 * `#selection:`, `#sym:`) in an editor.
 *
 * These were previously three near-identical private tables in
 * `atomicReferences.ts`, `WorkspaceFileEditor.tsx`, and `PromptLinkProvider.ts`,
 * each carrying a comment telling the next reader to keep them in lockstep.
 * They had already drifted in ways that produced visibly different chips — see
 * the trailing-lookahead note on `fullFile` below.
 *
 * These are *decoration* patterns. The runtime expansion parser in
 * `FileReferenceParser.ts` is deliberately a separate implementation with a
 * looser `@` body, because it resolves a reference rather than highlighting
 * one. The invariant that matters is directional: a reference decorated here
 * must also expand at runtime, or the user gets a chip that silently resolves
 * to nothing.
 *
 * Consumed by the webview bundle as well as the extension host, so this module
 * must stay free of `vscode` and Node-only imports.
 *
 * Capture groups are part of the contract:
 * - `fullFileQuoted`, `fullFile`, `directoryQuoted`, `directory`: 1 = path
 * - `lineRange`: 1 = quoted path, 2 = bare path, 3 = start line, 4 = end line
 * - `symbol`: 1 = kind, 2/3 = quoted/bare path, 4/5 = quoted/bare symbol name,
 *   6 = start line, 7 = end line
 */
export interface ReferencePatterns {
  fullFileQuoted: RegExp;
  fullFile: RegExp;
  directoryQuoted: RegExp;
  directory: RegExp;
  lineRange: RegExp;
  symbol: RegExp;
}

/**
 * Build a fresh pattern table.
 *
 * Returns new `RegExp` objects each call so a caller can never inherit another
 * caller's `lastIndex` from the `g` flag.
 */
export function createReferencePatterns(): ReferencePatterns {
  return {
    // @"path with spaces/file.ts"
    fullFileQuoted: new RegExp(
      `${NOT_AFTER_BOUNDARY}@"([^"]+\\.[a-zA-Z0-9]+)"(?!\\/)`,
      "g"
    ),
    // @path/to/file.ts
    //
    // The trailing `(?![a-zA-Z0-9/])` is load-bearing and must not be relaxed
    // to `(?!\/)`. Blocking only `/` lets the `[a-zA-Z0-9]+` quantifier
    // backtrack: on `@dir/file.ts/` it gives back the `s`, sees `s` rather
    // than `/` ahead, and matches the truncated path `dir/file.t`. Blocking
    // alphanumerics too means every backtrack still leaves an alphanumeric
    // ahead, so no partial match survives and the whole token correctly falls
    // through to `directory`. The bug only hides on one-character extensions
    // (`@dir.d/`), where there is nothing to give back.
    fullFile: new RegExp(
      `${NOT_AFTER_BOUNDARY}@([^\\s#"]+\\.[a-zA-Z0-9]+)(?![a-zA-Z0-9/])`,
      "g"
    ),
    // @"path with spaces/dir/"
    directoryQuoted: new RegExp(
      `${NOT_AFTER_BOUNDARY}@"([^"]+\\/)"(?![\\w])`,
      "g"
    ),
    // @path/to/dir/
    directory: new RegExp(`${NOT_AFTER_BOUNDARY}@([^\\s#"]+\\/)`, "g"),
    // #selection:<path>:10-20 — path quoted, or bare with no whitespace/`:`/`"`.
    lineRange: new RegExp(
      `${NOT_AFTER_BOUNDARY}#selection:(?:"([^"]+)"|([^\\s:"]+)):(\\d+)-(\\d+)`,
      "g"
    ),
    // #sym[.kind]:<path>:<symbol>:42-58 — both fields quoted or bare.
    // Matches: #sym:src/extension.ts:activate:14-36
    //          #sym:"C:/dev/my repo/a.ts":"get value":14-36
    symbol: new RegExp(
      `${NOT_AFTER_BOUNDARY}#sym(?:\\.([a-z-]+))?:(?:"([^"]+)"|([^\\s:"]+)):(?:"([^"]+)"|([^\\s:"]+)):(\\d+)-(\\d+)`,
      "g"
    ),
  };
}
