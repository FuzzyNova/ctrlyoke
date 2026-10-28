/**
 * Turns assistant markdown into text meant to be heard rather than seen.
 *
 * Shared by the dashboard's screen-reader announcer and, later, read-aloud
 * (`dev/backlog/VOICE_INPUT_AND_READ_ALOUD_PLAN.md`), so both say the same
 * thing about a response. Dependency-free apart from event types so the
 * webview can import it through `@root/utils`.
 *
 * Regexes here avoid lookbehind: older iOS Safari rejects it at parse time,
 * which would break the whole dashboard bundle, not just this module.
 */
import type { CliEvent } from "../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../types/DashboardConstants";
import { normalizeCliEvents } from "./CliEventNormalizer";
import { normalizeCliFilePathKey } from "./CliEventVisibility";

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_MARKER = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const BLOCKQUOTE_MARKER = /^\s*(?:>\s?)+/;
const LIST_MARKER = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/;
const HORIZONTAL_RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function isFenceClose(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length >= marker.length &&
    trimmed[0] === marker[0] &&
    [...trimmed].every((char) => char === marker[0])
  );
}

function isTableSeparator(line: string): boolean {
  return line.includes("|") && /^[\s|:-]+$/.test(line) && /-{3,}/.test(line);
}

function urlHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] || "link";
}

/** Strip inline markdown and shorten what is tiresome to hear. */
function cleanInline(text: string): string {
  return (
    text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => alt || "image")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<(https?:\/\/[^>]+)>/gi, (_m, url: string) => urlHost(url))
      .replace(/https?:\/\/[^\s)>\]]+/gi, (url) => urlHost(url))
      .replace(/<\/?[A-Za-z][^>]*>/g, "")
      .replace(/`+([^`]+?)`+/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      .replace(/~~([^~\n]+)~~/g, "$1")
      .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1$2")
      // Absolute paths read as their file name: "C:\dev\repo\src\a.ts" and
      // "/home/me/repo/src/a.ts" both become "a.ts". Relative paths stay.
      .replace(
        /(^|[\s("'[=:,])((?:[A-Za-z]:)?[\\/](?:[^\s\\/'"`()<>|]+[\\/])+)([^\s\\/'"`()<>|]+)/g,
        "$1$3"
      )
  );
}

/**
 * Markdown → speakable text. Fenced code becomes "Code block, N lines,
 * omitted." and a table "Table with N rows."; formatting marks, link targets
 * and HTML are dropped, URLs shrink to their host and absolute paths to their
 * file name. Paragraph breaks survive as blank lines.
 */
export function toSpeechText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      let end = index + 1;
      while (end < lines.length && !isFenceClose(lines[end], fence[1])) {
        end++;
      }
      const lineCount = end - index - 1;
      out.push(`Code block, ${plural(lineCount, "line", "lines")}, omitted.`);
      index = end + 1;
      continue;
    }
    if (
      TABLE_ROW.test(line) &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1])
    ) {
      let end = index + 2;
      while (end < lines.length && TABLE_ROW.test(lines[end])) end++;
      out.push(`Table with ${plural(end - index - 2, "row", "rows")}.`);
      index = end;
      continue;
    }
    if (HORIZONTAL_RULE.test(line)) {
      out.push("");
      index++;
      continue;
    }
    const heading = HEADING_MARKER.exec(line);
    const body = heading
      ? heading[1]
      : line.replace(BLOCKQUOTE_MARKER, "").replace(LIST_MARKER, "");
    out.push(
      cleanInline(body)
        .replace(/[ \t]+/g, " ")
        .trim()
    );
    index++;
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Where the complete paragraphs of a still-streaming reply end: the offset
 * just past its last blank line that is not inside a code fence. Text after it
 * may still grow, so a streaming reader stops there. Returns 0 when nothing
 * is complete yet.
 */
export function findSettledSpeechBoundary(markdown: string): number {
  const lines = markdown.split("\n");
  let boundary = 0;
  let offset = 0;
  let fence: string | null = null;
  // The last element has no newline after it yet, so it is never complete.
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index];
    offset += line.length + 1;
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1];
    } else if (line.trim() === "") {
      boundary = offset;
    }
  }
  return boundary;
}

/**
 * One sentence summing up what a turn did besides talking, e.g. "Changed 3
 * files, ran 2 commands." Tool calls and diffs are summarized, never read
 * out. Empty when the turn only wrote text.
 */
export function describeActivityForSpeech(events: readonly CliEvent[]): string {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  let commands = 0;
  for (const event of normalizeCliEvents([...events])) {
    const path =
      "path" in event.data && typeof event.data.path === "string"
        ? normalizeCliFilePathKey(event.data.path)
        : undefined;
    switch (event.type) {
      case CLI_EVENT_TYPES.FILE_EDIT:
      case CLI_EVENT_TYPES.FILE_WRITE:
        if (path) changed.add(path);
        break;
      case CLI_EVENT_TYPES.FILE_DELETE:
        if (path) deleted.add(path);
        break;
      case CLI_EVENT_TYPES.BASH_COMMAND:
        commands++;
        break;
    }
  }
  const parts = [
    changed.size > 0 ? `changed ${plural(changed.size, "file", "files")}` : "",
    deleted.size > 0 ? `deleted ${plural(deleted.size, "file", "files")}` : "",
    commands > 0 ? `ran ${plural(commands, "command", "commands")}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  const sentence = parts.join(", ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}
