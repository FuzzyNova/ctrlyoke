/**
 * Single source of truth for the prompt-reference word boundary.
 *
 * Every ctrlyoke reference trigger (`@`, `#`, `~`, `$`, `!`) is only a trigger
 * at a word start. "Word" here means *filename*, not identifier: the boundary
 * class below is the set of characters that are legal inside a filename, so
 * `(@file.ts` and `"@file.ts` still match (punctuation is not a filename
 * character) while an email address (`nathan@gmail.com`) or a filename
 * mentioned in prose (`data_file~@backup!.csv`) does not.
 *
 * This class was previously copy-pasted into ~30 regex literals across the
 * completion providers, the link provider, both editors, and the runtime
 * parsers, each carrying a comment telling the next reader to keep the copies
 * in sync. Compose from these constants instead of re-typing the class.
 *
 * This module is consumed by the webview bundle as well as the extension host,
 * so it must stay free of `vscode` and Node-only imports.
 */

/** Characters that are legal inside a filename, as a character-class body. */
export const REFERENCE_BOUNDARY_CHARS = "A-Za-z0-9_+=@#$%^&!~-";

/** Matches exactly one boundary character. */
export const REFERENCE_BOUNDARY_CHAR_RE = new RegExp(
  `[${REFERENCE_BOUNDARY_CHARS}]`
);

/**
 * Lookbehind asserting a trigger is not preceded by a filename character —
 * i.e. that it starts a word rather than sitting mid-word or mid-filename.
 */
export const NOT_AFTER_BOUNDARY = `(?<![${REFERENCE_BOUNDARY_CHARS}])`;

/** Lookahead asserting a reference is not followed by a filename character. */
export const NOT_BEFORE_BOUNDARY = `(?![${REFERENCE_BOUNDARY_CHARS}])`;

/**
 * Find the rightmost occurrence of `triggerChar` in `text` that starts a word.
 *
 * It can start right after whitespace, punctuation like `(`/`"`, or the start
 * of the string, but not mid-word or mid-filename. This still resolves to an
 * earlier, legitimate trigger when one exists, so `@src/myimage@512x512.p`
 * resolves to the leading `@` and keeps the embedded `@` in the query.
 *
 * Shared by `PromptCompletionProvider` (extension host) and
 * `CodeMirrorEditor`'s `customCompletions` (webview), which previously held
 * byte-identical private copies.
 */
export function findWordStartTriggerIndex(
  text: string,
  triggerChar: string
): number {
  let index = text.lastIndexOf(triggerChar);
  while (index > 0 && REFERENCE_BOUNDARY_CHAR_RE.test(text[index - 1])) {
    index = text.lastIndexOf(triggerChar, index - 1);
  }
  return index;
}
