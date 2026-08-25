import type { HarnessId } from "../../../types/DashboardConstants";

/** A flag and the optional information shown while editing its value. */
export interface HarnessFlagCompletion {
  flag: string;
  alias?: string;
  valueHints?: string[];
  detail?: string;
}

type HarnessHelpParser = (helpText: string) => HarnessFlagCompletion[];

interface ParsedFlagRow {
  flag: string;
  alias?: string;
  descriptionParts: string[];
  placeholderHints: string[];
}

interface ParsedOptionLine {
  flags: string[];
  description: string;
  placeholderHints: string[];
  aliasTarget?: string;
}

const OPTION_LINE_INDENT_MAX = 8;
const OPTION_TOKEN = /--?[A-Za-z][A-Za-z0-9-]*(?:\[[^\]\r\n]*\]|<[^>\r\n]*>)?/g;
const OPTION_LINE = new RegExp(
  `^(?<indent>\\s*)(?<options>${OPTION_TOKEN.source}(?:\\s*,\\s*${OPTION_TOKEN.source})*)(?<remainder>.*)$`
);

/**
 * Harness-specific parsers are deliberately opt-in.  The captured CLIs all
 * use a compatible option-table shape, so this remains empty until a fixture
 * demonstrates that the generic parser is no longer sufficient for one CLI.
 */
const HARNESS_HELP_PARSER_OVERRIDES: Partial<
  Record<HarnessId, HarnessHelpParser>
> = {};

function parseOptionLine(line: string): ParsedOptionLine | undefined {
  const match = OPTION_LINE.exec(line);
  if (!match?.groups) {
    return undefined;
  }

  if (
    match.groups.indent.length === 0 ||
    match.groups.indent.length > OPTION_LINE_INDENT_MAX
  ) {
    return undefined;
  }

  const flags = match.groups.options.match(OPTION_TOKEN) ?? [];
  const remainder = match.groups.remainder.trim();
  const placeholderMatch = remainder.match(/^(<[^>]+>|\[[^\]]+\])(?:\s+|$)/);
  const placeholder = placeholderMatch?.[1];
  const description = placeholder
    ? remainder.slice(placeholderMatch[0].length).trim()
    : remainder;
  const placeholderHints = placeholder
    ? extractValueHints(placeholder.slice(1, -1))
    : [];
  const longFlags = flags.filter((flag) => flag.startsWith("--"));
  const aliasTarget =
    longFlags.length === 0
      ? description.match(/\balias\s+for\s+(--[A-Za-z][A-Za-z0-9-]*)/i)?.[1]
      : undefined;

  return {
    flags,
    description,
    placeholderHints,
    aliasTarget,
  };
}

function stripValuePlaceholder(flag: string): string {
  return flag.replace(/(?:\[[^\]]+\]|<[^>]+>)$/, "");
}

function extractValueHints(text: string): string[] {
  const hints: string[] = [];
  const addHints = (source: string): void => {
    const bulletHints = [
      ...source.matchAll(
        /(?:^|\s)-\s*([A-Za-z0-9][A-Za-z0-9_.-]*)(?=\s*:|\s*$)/g
      ),
    ].map((match) => match[1]);
    const quotedHints = [...source.matchAll(/["']([^"']+)["']/g)].map((match) =>
      match[1].trim()
    );
    const candidates =
      bulletHints.length > 0
        ? bulletHints
        : quotedHints.length > 0
          ? quotedHints
          : source.split(/[,|]/);

    for (const candidate of candidates) {
      const hint = candidate
        .trim()
        .replace(/^[-•]\s*/, "")
        .replace(/^or\s+/i, "")
        .replace(/[.)]+$/, "")
        .trim();
      if (hint && !hints.includes(hint)) {
        hints.push(hint);
      }
    }
  };

  if (/^[^()[\]]*\|[^()[\]]*$/.test(text.trim())) {
    addHints(text);
  }

  for (const match of text.matchAll(
    /\b(?:choices?|possible values?)\s*:\s*([^\)\]]+)/gi
  )) {
    addHints(match[1]);
  }

  for (const match of text.matchAll(/[\[(]([^()[\]]*\|[^()[\]]*)[\])]/g)) {
    addHints(match[1]);
  }

  for (const match of text.matchAll(/\(([^()]+,[^()]+)\)/g)) {
    const candidates = match[1].split(",").map((candidate) => candidate.trim());
    if (
      candidates.length > 1 &&
      candidates.every((candidate) =>
        /^["']?[A-Za-z0-9][A-Za-z0-9_.-]*["']?$/.test(candidate)
      )
    ) {
      addHints(match[1]);
    }
  }

  return hints;
}

function normalizeDescription(parts: readonly string[]): string | undefined {
  const description = parts.join(" ").replace(/\s+/g, " ").trim();
  return description || undefined;
}

function parseGenericHelp(helpText: string): HarnessFlagCompletion[] {
  if (typeof helpText !== "string" || helpText.trim() === "") {
    return [];
  }

  const rows: ParsedFlagRow[] = [];
  const aliasLinks: Array<{ alias: string; target: string }> = [];
  let currentRow: ParsedFlagRow | undefined;

  const finishCurrentRow = (): void => {
    if (currentRow) {
      rows.push(currentRow);
      currentRow = undefined;
    }
  };

  for (const line of helpText.split(/\r?\n/)) {
    const parsedLine = parseOptionLine(line);
    if (parsedLine) {
      finishCurrentRow();
      const longFlags = parsedLine.flags
        .filter((flag) => flag.startsWith("--"))
        .map(stripValuePlaceholder);
      if (longFlags.length === 0) {
        if (parsedLine.aliasTarget && parsedLine.flags.length > 0) {
          aliasLinks.push({
            alias: stripValuePlaceholder(parsedLine.flags[0]),
            target: parsedLine.aliasTarget,
          });
        }
        continue;
      }

      const flag = longFlags[longFlags.length - 1];
      const shortAlias = parsedLine.flags.find(
        (candidate) => candidate.startsWith("-") && !candidate.startsWith("--")
      );
      const longAlias = longFlags.length > 1 ? longFlags[0] : undefined;
      currentRow = {
        flag,
        alias: shortAlias ?? longAlias,
        descriptionParts: parsedLine.description
          ? [parsedLine.description]
          : [],
        placeholderHints: parsedLine.placeholderHints,
      };
      continue;
    }

    if (/^\s*$/.test(line)) {
      continue;
    }

    if (currentRow && /^\s{4,}\S/.test(line)) {
      currentRow.descriptionParts.push(line.trim());
      continue;
    }

    finishCurrentRow();
  }
  finishCurrentRow();

  const completionsByFlag = new Map<string, HarnessFlagCompletion>();
  for (const row of rows) {
    const detail = normalizeDescription(row.descriptionParts);
    const valueHints = extractValueHints(row.descriptionParts.join(" ")).concat(
      row.placeholderHints
    );
    const completion: HarnessFlagCompletion = { flag: row.flag };
    if (row.alias) {
      completion.alias = row.alias;
    }
    if (valueHints.length > 0) {
      completion.valueHints = [...new Set(valueHints)];
    }
    if (detail) {
      completion.detail = detail;
    }

    const existing = completionsByFlag.get(row.flag);
    if (existing) {
      existing.alias ??= completion.alias;
      existing.detail ??= completion.detail;
      existing.valueHints = [
        ...new Set([
          ...(existing.valueHints ?? []),
          ...(completion.valueHints ?? []),
        ]),
      ];
    } else {
      completionsByFlag.set(row.flag, completion);
    }
  }

  for (const link of aliasLinks) {
    const completion = completionsByFlag.get(link.target);
    if (completion && !completion.alias) {
      completion.alias = link.alias;
    }
  }

  return [...completionsByFlag.values()];
}

/** Parse a harness's live --help output into stable completion data. */
export function getHarnessFlagCompletions(
  harnessId: HarnessId,
  helpText: string
): HarnessFlagCompletion[] {
  try {
    const parser = HARNESS_HELP_PARSER_OVERRIDES[harnessId];
    return (parser ?? parseGenericHelp)(helpText);
  } catch {
    return [];
  }
}
