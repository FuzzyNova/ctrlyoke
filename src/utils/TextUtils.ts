/** Remove a UTF-8 byte order mark represented as U+FEFF at the start of text. */
export function stripLeadingBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}
