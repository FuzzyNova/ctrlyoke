/**
 * Shared rules for `spelling.words` entries, used by the host when it saves a
 * word and by the dashboard's custom-words editor. Keep in step with the
 * `spelling.words` item constraints in `schemas/settings-schema.json`.
 */

const SPELLING_WORD_MAX_LENGTH = 64;

/** Why a candidate custom word was rejected, or `null` when it is valid. */
export function getSpellingWordError(word: string): string | null {
  if (word.length === 0) return "Word cannot be empty.";
  if (/\s/.test(word)) return "A word cannot contain spaces.";
  if (word.length > SPELLING_WORD_MAX_LENGTH) {
    return `A word can be at most ${SPELLING_WORD_MAX_LENGTH} characters.`;
  }
  return null;
}

/** `words` with `word` appended, or `words` itself when it is already listed. */
export function appendSpellingWord(
  words: readonly string[],
  word: string
): string[] {
  return words.includes(word) ? [...words] : [...words, word];
}
