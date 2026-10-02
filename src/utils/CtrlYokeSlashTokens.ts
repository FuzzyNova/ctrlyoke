import {
  CTRLYOKE_SLASH_TOKEN_KINDS,
  type CtrlYokeSlashTokenKind,
} from "../types/DashboardConstants";
import { maskFencedCodeBlocks } from "./FileReferenceParser";
import { NOT_AFTER_BOUNDARY } from "./ReferenceBoundary";

// A name may contain `.`, `_`, and `-` internally but must start and end on an
// alphanumeric, so ordinary sentence punctuation is not swallowed into it:
// "commit the changes using /skill:commit." references `commit`, not `commit.`.
const TOKEN_NAME_PATTERN = "[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?";
// Only a further `:` disqualifies a match, so the three-segment
// `/mcp:<server>:<tool>` form (a follow-on phase) is left entirely alone rather
// than being mistaken for a server reference with trailing text.
const TOKEN_BOUNDARY_PATTERN = "[a-zA-Z0-9:]";
const TOKEN_PATTERN = new RegExp(
  `${NOT_AFTER_BOUNDARY}(?<![\\/.:])\\/(${Object.values(CTRLYOKE_SLASH_TOKEN_KINDS).join("|")}):(${TOKEN_NAME_PATTERN})(?!${TOKEN_BOUNDARY_PATTERN})`,
  "g"
);
const COMPLETE_TOKEN_PATTERN = new RegExp(
  `^\\/(${Object.values(CTRLYOKE_SLASH_TOKEN_KINDS).join("|")}):(${TOKEN_NAME_PATTERN})$`
);

/** A parsed ctrlyoke slash reference, including its source-text location. */
export interface CtrlYokeSlashToken {
  kind: CtrlYokeSlashTokenKind;
  name: string;
  index: number;
  length: number;
  raw: string;
}

/** The semantic parts of a complete ctrlyoke slash reference. */
export interface CtrlYokeSlashTokenParts {
  kind: CtrlYokeSlashTokenKind;
  name: string;
}

/** Classify a complete token without interpreting ordinary slash commands. */
export function classifyCtrlYokeSlashToken(
  token: string
): CtrlYokeSlashTokenKind | undefined {
  return extractCtrlYokeSlashToken(token)?.kind;
}

/** Extract the kind and name from one complete ctrlyoke slash reference. */
export function extractCtrlYokeSlashToken(
  token: string
): CtrlYokeSlashTokenParts | undefined {
  const match = COMPLETE_TOKEN_PATTERN.exec(token);
  COMPLETE_TOKEN_PATTERN.lastIndex = 0;

  if (!match) {
    return undefined;
  }

  return {
    kind: match[1] as CtrlYokeSlashTokenKind,
    name: match[2],
  };
}

/**
 * Find every ctrlyoke slash reference in a prompt.
 *
 * Triple-backtick fenced blocks are masked first (see
 * `FileReferenceParser.maskFencedCodeBlocks`), so a `/skill:`/`/mcp:` example
 * inside a fenced code/log excerpt is never mistaken for a live force-attach
 * grant.
 */
export function scanCtrlYokeSlashTokens(text: string): CtrlYokeSlashToken[] {
  const tokens: CtrlYokeSlashToken[] = [];
  const maskedText = maskFencedCodeBlocks(text);
  TOKEN_PATTERN.lastIndex = 0;

  for (const match of maskedText.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    const parts = extractCtrlYokeSlashToken(raw);
    if (!parts || match.index === undefined) {
      continue;
    }

    tokens.push({
      ...parts,
      index: match.index,
      length: raw.length,
      raw,
    });
  }

  TOKEN_PATTERN.lastIndex = 0;
  return tokens;
}

/** Rewrite all ctrlyoke slash references while preserving all other text. */
export function rewriteCtrlYokeSlashTokens(
  text: string,
  shouldRewrite: (token: CtrlYokeSlashToken) => boolean = () => true
): string {
  const tokens = scanCtrlYokeSlashTokens(text);
  let rewritten = text;

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!shouldRewrite(token)) {
      continue;
    }
    const replacement = `${token.kind}: ${token.name}`;
    rewritten =
      rewritten.slice(0, token.index) +
      replacement +
      rewritten.slice(token.index + token.length);
  }

  return rewritten;
}
