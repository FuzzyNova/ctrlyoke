import * as fs from "fs";

/**
 * The single definition of where a line ends, for every consumer that reads a
 * file or a buffer line by line: JSONL record files (`events.jsonl`,
 * search-index shards), harness stdout, and workspace text search.
 *
 * It exists because the obvious readers disagree with each other:
 *
 * - Node's `readline` also treats U+2028 LINE SEPARATOR and U+2029 PARAGRAPH
 *   SEPARATOR as line terminators, while `JSON.stringify` leaves both
 *   unescaped (they are legal inside a JSON string). A CLI response quoting
 *   text that contains a raw U+2028 -- routine for web-fetched page content --
 *   therefore writes one valid JSONL record that `readline` splits into two
 *   malformed fragments, and the whole run becomes unreadable with
 *   `Unterminated string in JSON at position <n>`.
 * - A lone carriage return is a line break to an editor but not to a naive
 *   split on newline, so a server-side line number computed that way does not
 *   address the line the client renders.
 *
 * `LINE_BREAK_PATTERN` is therefore exactly CodeMirror's own `DefaultSplit`,
 * which is what decides the line numbers the dashboard displays and navigates
 * to. Matching it is the point: a line number produced here addresses the same
 * line in the editor.
 *
 * Use `splitLines` for content already in memory and `streamFileLines` for a
 * file that should not be materialized. What to do with an unparseable line is
 * the caller's policy -- `TimelineRecorder` tolerates only a partial trailing
 * record, `CliParseUtils.parseJsonLines` skips and logs any bad line -- but
 * where a line *ends* is decided only here.
 */

/**
 * Matches a line break and nothing else: CRLF, a lone CR, or a lone LF. Never
 * U+2028/U+2029. Identical to `DefaultSplit` in `@codemirror/state`.
 */
export const LINE_BREAK_PATTERN = /\r\n?|\n/;

const CARRIAGE_RETURN = "\r";

/**
 * Splits already-loaded content into lines. Content ending in a line break
 * yields a final empty line, exactly as `String.prototype.split` does;
 * `streamFileLines` drops that one instead, since a file's trailing newline is
 * a terminator rather than an empty last record.
 */
export function splitLines(content: string): string[] {
  return content.split(LINE_BREAK_PATTERN);
}

/**
 * Streams a file line by line without materializing it. A final line with no
 * trailing break is yielded as-is, so callers keep the option of tolerating a
 * partially written last record.
 */
export async function* streamFileLines(
  filePath: string
): AsyncGenerator<string, void, undefined> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  let buffered = "";

  try {
    for await (const chunk of stream) {
      buffered += chunk as string;

      // A trailing CR is held back: only the next chunk can say whether it is a
      // lone CR line break or the first half of a CRLF pair.
      const endsWithCarriageReturn = buffered.endsWith(CARRIAGE_RETURN);
      const searchable = endsWithCarriageReturn
        ? buffered.slice(0, -1)
        : buffered;

      const lines = searchable.split(LINE_BREAK_PATTERN);
      buffered =
        (lines.pop() ?? "") + (endsWithCarriageReturn ? CARRIAGE_RETURN : "");

      for (const line of lines) {
        yield line;
      }
    }

    if (buffered.length > 0) {
      // Whatever survived the loop holds at most the held-back CR as a break,
      // so this is the last line plus, when the file ended on that CR, the
      // empty string a trailing terminator produces. Drop it.
      const remaining = splitLines(buffered);
      if (remaining[remaining.length - 1] === "") {
        remaining.pop();
      }
      for (const line of remaining) {
        yield line;
      }
    }
  } finally {
    stream.destroy();
  }
}
