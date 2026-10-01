import { NOT_AFTER_BOUNDARY, NOT_BEFORE_BOUNDARY } from "./ReferenceBoundary";

/** Shared unquoted @ path body. A colon is valid only in the drive prefix. */
export const UNQUOTED_AT_REFERENCE_PATH = String.raw`(?:[A-Za-z]:)?[^\s:"]+`;

/** Build the shared inline prior-context pattern for parsing and decoration. */
export function createInlinePriorContextReferencePattern(): RegExp {
  return new RegExp(
    `${NOT_AFTER_BOUNDARY}\\$((?:step:[A-Za-z0-9,\\-]*|[A-Za-z][A-Za-z0-9]*))`,
    "g"
  );
}

/**
 * Build the shared `$phase:field` condition-output pattern (`$preCondition:stdout`).
 * Capture 1 = phase, 2 = field (absent when there is no `:`).
 *
 * Both captures are whole word tokens (letters, digits, `_`) so a reference
 * never matches a prefix of a longer word: `$preCondition:stdout2` captures the
 * unknown field `stdout2` rather than expanding `stdout` and gluing on `2`,
 * matching `$previous2` and `~diffx`, which are not references either. Prose
 * punctuation (`,` `.` `-` `)`) ends the token. Callers validate the phase and
 * field against the known sets; an unknown field is reported, not guessed at.
 */
export function createConditionOutputReferencePattern(): RegExp {
  return new RegExp(
    `${NOT_AFTER_BOUNDARY}\\$([A-Za-z][A-Za-z0-9_]*)(?::([A-Za-z0-9_]+))?`,
    "g"
  );
}

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
 * `FileReferenceParser.ts` uses the shared unquoted `@` path fragment but
 * remains a separate implementation because it resolves rather than
 * highlighting references. The invariant that matters is directional: a
 * reference decorated here must also expand at runtime, or the user gets a
 * chip that silently resolves to nothing.
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
      `${NOT_AFTER_BOUNDARY}@"([^"]+\\.[\\p{L}\\p{N}]+)"(?!\\/)`,
      "gu"
    ),
    // @path/to/file.ts
    //
    // The trailing Unicode-aware lookahead is load-bearing and must not be
    // relaxed to `(?!\/)`. Blocking only `/` lets the extension quantifier
    // backtrack: on `@dir/file.ts/` it gives back the `s`, sees `s` rather
    // than `/` ahead, and matches the truncated path `dir/file.t`. Blocking
    // letters and numbers too means every backtrack still leaves one
    // ahead, so no partial match survives and the whole token correctly falls
    // through to `directory`. The bug only hides on one-character extensions
    // (`@dir.d/`), where there is nothing to give back.
    fullFile: new RegExp(
      `${NOT_AFTER_BOUNDARY}@(${UNQUOTED_AT_REFERENCE_PATH}\\.[\\p{L}\\p{N}]+)(?![\\p{L}\\p{N}/])`,
      "gu"
    ),
    // @"path with spaces/dir/"
    directoryQuoted: new RegExp(
      `${NOT_AFTER_BOUNDARY}@"([^"]+\\/)"(?![\\w])`,
      "g"
    ),
    // @path/to/dir/
    directory: new RegExp(
      `${NOT_AFTER_BOUNDARY}@(${UNQUOTED_AT_REFERENCE_PATH}\\/)`,
      "g"
    ),
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
