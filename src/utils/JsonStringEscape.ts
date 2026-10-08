/**
 * Escapes text for insertion between the quotes of an existing JSON string
 * (`"`, `\`, line breaks and control characters). Shared so VS Code and the
 * hosted editor cannot drift on what a JSON-embedded completion looks like.
 */
export function escapeJsonStringFragment(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}
