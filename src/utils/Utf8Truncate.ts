/** Truncate text to a UTF-8 byte limit without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }

  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end--;
  }
  return buffer.subarray(0, end).toString("utf8");
}
