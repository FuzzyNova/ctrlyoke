import { StringDecoder } from "string_decoder";

/**
 * Attach a UTF-8 decoder to a byte stream so characters split across chunks
 * are not corrupted into replacement characters. The returned function flushes
 * any incomplete trailing sequence when the stream ends.
 */
export function attachStreamTextDecoder(
  stream: {
    on(event: "data", listener: (data: Buffer) => void): unknown;
  },
  onText: (text: string) => void
): () => string {
  const decoder = new StringDecoder("utf8");

  stream.on("data", (data: Buffer) => {
    const text = decoder.write(data);
    if (text.length > 0) {
      onText(text);
    }
  });

  return () => decoder.end();
}
