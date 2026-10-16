import { PRIOR_CONTEXT_SUMMARY_SEGMENT } from "../types/DashboardConstants";
import { NOT_AFTER_BOUNDARY, NOT_BEFORE_BOUNDARY } from "./ReferenceBoundary";

/** Shared unquoted @ path body. A colon is valid only in the drive prefix. */
export const UNQUOTED_AT_REFERENCE_PATH = String.raw`(?:[A-Za-z]:)?[^\s:"]+`;
export const UNQUOTED_AT_REFERENCE_PATH_LAZY =
  UNQUOTED_AT_REFERENCE_PATH.replace(
    String.raw`[^\s:"]+`,
    String.raw`[^\s:"]+?`
  );

/** End of an unquoted token, allowing runtime-stripped prose punctuation. */
export const UNQUOTED_REFERENCE_END = String.raw`(?=$|[\s:"]|[^\p{L}\p{N}/\\\s:"]+(?:[\s:"]|$)|\]\()`;

/**
 * Build the shared inline prior-context pattern for parsing and decoration.
 * Capture 1 = the body after `$`; `parseInlinePriorContextBody` validates it.
 *
 * `previous:` takes its count only as a whole digit run, so prose such as
 * `$previous: fix it` or `$previous:3x` falls back to the bare `$previous`
 * alternative instead of swallowing the colon — the same bare-keyword
 * behaviour those texts had before counts existed.
 *
 * The optional `:summary` detail segment sits right after the kind and before
 * any arguments (`$previous:summary:3`, `$step:summary:1,3-5`). On a bare
 * keyword it must be a whole word, so `$previous:summary2` is `$previous`.
 */
export function createInlinePriorContextReferencePattern(): RegExp {
  const summary = PRIOR_CONTEXT_SUMMARY_SEGMENT;
  return new RegExp(
    `${NOT_AFTER_BOUNDARY}\\$((?:step(?:${summary})?:[A-Za-z0-9,_\\-]*|previous(?:${summary})?:[0-9]+(?![A-Za-z0-9_])|[A-Za-z][A-Za-z0-9_]*(?:${summary}(?![A-Za-z0-9_]))?))`,
    "gu"
  );
}

/**
 * Build the pattern for the retired detail-first order (`$summary:previous`),
 * which the editor flags with a quick fix to the current order. Capture 1 =
 * the selector after `summary:`.
 */
export function createLegacySummaryPrefixPattern(): RegExp {
  return new RegExp(
    `${NOT_AFTER_BOUNDARY}\\$summary:((?:step:[0-9,\\-]*[0-9]|previous:[0-9]+(?![A-Za-z0-9_])|[A-Za-z][A-Za-z0-9_]*))`,
    "gu"
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
    "gu"
  );
}

/** Build a fresh regex for complete ~git-change references. */
export function createGitChangeReferencePattern(): RegExp {
  return new RegExp(
    `${NOT_AFTER_BOUNDARY}~(diff|staged|stash:(\\d+)|([0-9a-f]{7,40}))${NOT_BEFORE_BOUNDARY}`,
    "giu"
  );
}

/**
 * Canonical regexes for decorating prompt references (`@file`, `@dir/`,
 * `#selection:`, `#sym:`) in an editor.
 *
 * These were previously three near-identical private tables in
 * `atomicReferences.ts`, `WorkspaceFileEditor.tsx`, and `PromptLinkProvider.ts`,
 * each carrying a comment telling the next reader to keep them in lockstep.
 * They had already drifted in ways that produced visibly different chips.
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
    // Quoting explicitly marks a file path, including root extensionless names.
    fullFileQuoted: new RegExp(`${NOT_AFTER_BOUNDARY}@"([^"]*[^/\\\\])"`, "gu"),
    // @path/to/file.ts
    //
    // The path marker and final boundary mirror runtime file-path and punctuation rules.
    fullFile: new RegExp(
      `${NOT_AFTER_BOUNDARY}@((?=(?:[A-Za-z]:)?[^\\s:"]*[/.\\\\])${UNQUOTED_AT_REFERENCE_PATH_LAZY}[\\p{L}\\p{N}])${UNQUOTED_REFERENCE_END}`,
      "gu"
    ),
    // @"path with spaces/dir/"
    directoryQuoted: new RegExp(
      `${NOT_AFTER_BOUNDARY}@"([^"]+\\/)"(?![\\p{L}\\p{N}])`,
      "gu"
    ),
    // @path/to/dir/
    directory: new RegExp(
      `${NOT_AFTER_BOUNDARY}@(${UNQUOTED_AT_REFERENCE_PATH}\\/)${UNQUOTED_REFERENCE_END}`,
      "gu"
    ),
    // #selection:<path>:10-20 — path quoted, or bare with no whitespace/`:`/`"`.
    lineRange: new RegExp(
      `${NOT_AFTER_BOUNDARY}#selection:(?:"([^"]+)"|([^\\s:"]+)):(\\d+)-(\\d+)`,
      "gu"
    ),
    // #sym[.kind]:<path>:<symbol>:42-58 — both fields quoted or bare.
    // Matches: #sym:src/extension.ts:activate:14-36
    //          #sym:"C:/dev/my repo/a.ts":"get value":14-36
    symbol: new RegExp(
      `${NOT_AFTER_BOUNDARY}#sym(?:\\.([a-z-]+))?:(?:"([^"]+)"|([^\\s:"]+)):(?:"([^"]+)"|([^\\s:"]+)):(\\d+)-(\\d+)`,
      "gu"
    ),
  };
}
