/** Make terminal and directional control characters visible in displayed text. */
export function escapeUntrustedDisplayText(
  text: string,
  options: { escapeNewlines?: boolean } = {}
): string {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
    (character) => {
      if (character === "\n" && !options.escapeNewlines) return character;
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  );
}
