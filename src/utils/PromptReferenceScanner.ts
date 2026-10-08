/**
 * Prompt-reference scanners shared by the dashboard editor (chips, links, lint)
 * and the prompt diagnostic rules. Pure: no `vscode`, no DOM, no `fs`.
 */

import {
  ATOMIC_REFERENCE_KINDS,
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
  type AtomicReferenceKind,
  type RetryPromptPlaceholder,
} from "../types/DashboardConstants";
import { parseSecretReferences } from "./SecretReferenceParser";
import {
  createConditionOutputReferencePattern,
  createGitChangeReferencePattern,
  createReferencePatterns,
} from "./ReferencePatterns";
import {
  findCodeRanges as findSharedCodeRanges,
  scanInlinePriorContextRefs,
  type InlinePriorContextRef,
} from "./FileReferenceParser";

export type ContextReferenceType = AtomicReferenceKind;

export interface ContextReferenceMatch {
  from: number;
  to: number;
  type: ContextReferenceType;
  path?: string;
  gitRef?: string;
  lineStart?: string;
  lineEnd?: string;
  symbolName?: string;
  symbolKind?: string;
  ref?: string;
  skillName?: string;
  mcpServerName?: string;
  secretName?: string;
}

/** An inline prior-context ref located in editor/document text. */
export interface InlinePriorContextRange {
  from: number;
  to: number;
  token: string;
  ref: InlinePriorContextRef;
}

type ConditionOutputPhase =
  | typeof SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
  | typeof SCRIPT_OUTPUT_SOURCES.END_CONDITION;

export interface ConditionOutputRef {
  from: number;
  to: number;
  token: string;
  phase: ConditionOutputPhase;
  field: RetryPromptPlaceholder;
}

const CONDITION_OUTPUT_PHASES: readonly ConditionOutputPhase[] = [
  SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
  SCRIPT_OUTPUT_SOURCES.END_CONDITION,
];

const CONDITION_OUTPUT_FIELDS = new Set<string>(
  Object.values(RETRY_PROMPT_PLACEHOLDERS)
);

function isConditionOutputPhase(value: string): value is ConditionOutputPhase {
  return CONDITION_OUTPUT_PHASES.includes(value as ConditionOutputPhase);
}

function isConditionOutputField(
  value: string
): value is RetryPromptPlaceholder {
  return CONDITION_OUTPUT_FIELDS.has(value);
}

/** A `$phase:field` token whose phase is known but whose field is not. */
export interface UnknownConditionOutputFieldRef {
  from: number;
  to: number;
  token: string;
  phase: ConditionOutputPhase;
  field: string;
  /** The known field the author most likely meant, when one is close. */
  suggestion?: RetryPromptPlaceholder;
}

/**
 * Every `$phase:field` token with a known phase, using the same shared
 * pattern as the runtime parser (`parseConditionOutputRefs`), so the editor
 * chips exactly what a run will substitute.
 */
function scanConditionOutputTokens(
  text: string,
  offset: number
): Array<{
  from: number;
  to: number;
  token: string;
  phase: ConditionOutputPhase;
  field: string;
}> {
  const results = [];
  const regex = createConditionOutputReferencePattern();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const phase = match[1];
    const field = match[2];
    if (field === undefined || !isConditionOutputPhase(phase)) continue;
    const token = match[0];
    const from = offset + match.index;
    results.push({ from, to: from + token.length, token, phase, field });
  }
  return results;
}

/**
 * Find condition-output refs without widening the prior-context ref type.
 * Only known fields are returned; see {@link findUnknownConditionOutputFields}.
 */
export function findConditionOutputRefs(
  text: string,
  offset = 0
): ConditionOutputRef[] {
  return scanConditionOutputTokens(text, offset).flatMap((ref) =>
    isConditionOutputField(ref.field) ? [{ ...ref, field: ref.field }] : []
  );
}

/**
 * Find `$phase:field` tokens with a known phase and an unknown field (for
 * example `$preCondition:stdout2`). Neither the editor nor a run expands
 * these, so the editor reports them instead of leaving them silently inert.
 */
export function findUnknownConditionOutputFields(
  text: string,
  offset = 0
): UnknownConditionOutputFieldRef[] {
  return scanConditionOutputTokens(text, offset).flatMap((ref) => {
    if (isConditionOutputField(ref.field)) return [];
    const suggestion = suggestConditionOutputField(ref.field);
    return [suggestion ? { ...ref, suggestion } : ref];
  });
}

/**
 * The known field an unknown one was probably meant to be: a case-insensitive
 * match, the longest known field the typed one extends (`stdout2`,
 * `exitCodes`), or a known field the typed one abbreviates (`stdo`).
 */
function suggestConditionOutputField(
  field: string
): RetryPromptPlaceholder | undefined {
  const typed = field.toLowerCase();
  const known = [...CONDITION_OUTPUT_FIELDS] as RetryPromptPlaceholder[];
  const extended = known
    .filter((candidate) => typed.startsWith(candidate.toLowerCase()))
    .sort((left, right) => right.length - left.length)[0];
  return (
    extended ??
    known.find((candidate) => candidate.toLowerCase().startsWith(typed))
  );
}

export function findContextReferenceMatches(
  text: string,
  offset = 0
): ContextReferenceMatch[] {
  const patterns = createReferencePatterns();
  const fileMatches: ContextReferenceMatch[] = [];
  const directoryMatches: ContextReferenceMatch[] = [];
  const lineRangeMatches: ContextReferenceMatch[] = [];
  const symbolMatches: ContextReferenceMatch[] = [];
  const secretMatches: ContextReferenceMatch[] = parseSecretReferences(
    text
  ).map((reference) => ({
    from: offset + reference.startOffset,
    to: offset + reference.endOffset,
    type: ATOMIC_REFERENCE_KINDS.SECRET,
    secretName: reference.name,
  }));
  const gitMatches: ContextReferenceMatch[] = [];
  let match: RegExpExecArray | null;
  const collectPathMatches = (
    pattern: RegExp,
    type: AtomicReferenceKind,
    target: ContextReferenceMatch[]
  ) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(text)) !== null) {
      target.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type,
        path: match[1],
      });
    }
  };
  collectPathMatches(
    patterns.fullFileQuoted,
    ATOMIC_REFERENCE_KINDS.FILE,
    fileMatches
  );
  collectPathMatches(
    patterns.fullFile,
    ATOMIC_REFERENCE_KINDS.FILE,
    fileMatches
  );
  collectPathMatches(
    patterns.directoryQuoted,
    ATOMIC_REFERENCE_KINDS.DIRECTORY,
    directoryMatches
  );
  collectPathMatches(
    patterns.directory,
    ATOMIC_REFERENCE_KINDS.DIRECTORY,
    directoryMatches
  );
  const collectLineRangeMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(text)) !== null) {
      lineRangeMatches.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type: ATOMIC_REFERENCE_KINDS.LINE_RANGE,
        path: match[1] ?? match[2],
        lineStart: match[3],
        lineEnd: match[4],
      });
    }
  };
  collectLineRangeMatches(patterns.lineRange);
  const collectSymbolMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(text)) !== null) {
      symbolMatches.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type: ATOMIC_REFERENCE_KINDS.SYMBOL,
        ...(match[1] ? { symbolKind: match[1] } : {}),
        path: match[2] ?? match[3],
        symbolName: match[4] ?? match[5],
        lineStart: match[6],
        lineEnd: match[7],
      });
    }
  };
  collectSymbolMatches(patterns.symbol);
  const filteredDirectoryMatches = directoryMatches.filter(
    (dirMatch) =>
      !fileMatches.some(
        (fileMatch) =>
          dirMatch.from >= fileMatch.from && dirMatch.to <= fileMatch.to
      )
  );
  const collectGitMatches = (
    pattern: RegExp,
    normalize: (match: RegExpExecArray) => string
  ) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(text)) !== null) {
      const matchFrom = offset + match.index;
      if (!gitMatches.some((existing) => existing.from === matchFrom)) {
        gitMatches.push({
          from: matchFrom,
          to: offset + match.index + match[0].length,
          type: ATOMIC_REFERENCE_KINDS.GIT,
          gitRef: normalize(match),
        });
      }
    }
  };
  collectGitMatches(createGitChangeReferencePattern(), (m) =>
    m[1].toLowerCase()
  );
  return [
    ...fileMatches,
    ...filteredDirectoryMatches,
    ...lineRangeMatches,
    ...symbolMatches,
    ...secretMatches,
    ...gitMatches,
  ].sort((a, b) => a.from - b.from);
}

export function getCodeRanges(
  text: string
): Array<{ from: number; to: number }> {
  return findSharedCodeRanges(text);
}

export function isInCodeRange(
  from: number,
  to: number,
  codeRanges: Array<{ from: number; to: number }>
): boolean {
  return codeRanges.some((r) => from >= r.from && to <= r.to);
}

export function findInlinePriorContextRefs(
  text: string,
  offset = 0
): InlinePriorContextRange[] {
  return scanInlinePriorContextRefs(text).map((match) => ({
    from: offset + match.startOffset,
    to: offset + match.endOffset,
    token: match.token,
    ref: match.ref,
  }));
}
