/**
 * UI-only atomic-reference parsing and presentation.
 *
 * This intentionally stays separate from src/utils/FileReferenceParser.ts:
 * that parser feeds runtime harness context expansion and is tuned for prose
 * tolerance, while this parser needs exact source ranges and UI match types.
 */

import { sliceDecorationMatches, type RowFindDecoration } from "./outputFind";
import { SYMBOL_KIND_ICONS } from "../../../types/SymbolKindConstants";
import {
  scanCtrlYokeSlashTokens,
  type CtrlYokeSlashToken,
} from "../../../utils/CtrlYokeSlashTokens";
import {
  CTRLYOKE_SLASH_TOKEN_KINDS,
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
  type RetryPromptPlaceholder,
} from "../../../types/DashboardConstants";
import { parseSecretReferences } from "../../../utils/SecretReferenceParser";
import { NOT_AFTER_BOUNDARY } from "../../../utils/ReferenceBoundary";
import { createReferencePatterns } from "../../../utils/ReferencePatterns";

export { SYMBOL_KIND_ICONS } from "../../../types/SymbolKindConstants";

export interface AtomicReferenceRange {
  from: number;
  to: number;
}

/**
 * Maps a source range represented by the compact label to its label range.
 * Keeping both sides explicit is important for authored Markdown labels and
 * labels whose spelling differs slightly from the source (for example a
 * directory's added trailing slash).
 */
export interface AtomicReferenceCompactRange {
  source: AtomicReferenceRange;
  label: AtomicReferenceRange;
}

export interface AtomicReferencePresentation {
  /** Canonical full source/target text, with offsets relative to this string. */
  sourceText: string;
  /** Range of sourceText in the row's canonical find-search segment. */
  rowRange: AtomicReferenceRange;
  /** Source portions represented by compactLabel and their label offsets. */
  compactRanges: AtomicReferenceCompactRange[];
  compactLabel: string;
  /** Text used when the user copies the reference from output. */
  selectionText: string;
}

export interface AtomicReferenceFindMark {
  from: number;
  to: number;
  active: boolean;
}

export interface AtomicReferenceRenderSegment {
  text: string;
  marks: AtomicReferenceFindMark[];
  expanded: boolean;
  selectionText: string;
  /** Index into marks, when one of the projected matches is active. */
  activeMarkIndex?: number;
}

/**
 * Projects authoritative row-global find decorations onto one atomic
 * reference. This is deliberately a projection only: the find hook remains
 * responsible for searching, match count, ordering, and active-match state.
 */
export function projectAtomicReferenceFind(
  presentation: AtomicReferencePresentation,
  matches: RowFindDecoration["matches"]
): AtomicReferenceRenderSegment {
  const sourceMatches = sliceDecorationMatches(
    { matches },
    presentation.rowRange.from,
    presentation.rowRange.to
  );
  const compactRanges = presentation.compactRanges.filter(
    ({ source, label }) =>
      source.to > source.from &&
      label.to > label.from &&
      source.from >= 0 &&
      source.to <= presentation.sourceText.length &&
      label.from >= 0 &&
      label.to <= presentation.compactLabel.length
  );

  const expanded = sourceMatches.some(
    (match) => !isRangeCovered(match.start, match.end, compactRanges)
  );
  const text = expanded ? presentation.sourceText : presentation.compactLabel;
  const marks: AtomicReferenceFindMark[] = [];

  for (const match of sourceMatches) {
    if (expanded) {
      marks.push({ from: match.start, to: match.end, active: match.active });
      continue;
    }

    for (const range of compactRanges) {
      const from = Math.max(match.start, range.source.from);
      const to = Math.min(match.end, range.source.to);
      if (from >= to) continue;

      marks.push({
        from: range.label.from + (from - range.source.from),
        to: range.label.from + (to - range.source.from),
        active: match.active,
      });
    }
  }

  return {
    text,
    marks,
    expanded,
    selectionText: presentation.selectionText,
    ...(marks.findIndex((mark) => mark.active) >= 0
      ? { activeMarkIndex: marks.findIndex((mark) => mark.active) }
      : {}),
  };
}

function isRangeCovered(
  from: number,
  to: number,
  ranges: AtomicReferenceCompactRange[]
): boolean {
  let cursor = from;
  for (const range of [...ranges].sort(
    (left, right) => left.source.from - right.source.from
  )) {
    if (range.source.to <= cursor) continue;
    if (range.source.from > cursor) return false;
    cursor = Math.max(cursor, range.source.to);
    if (cursor >= to) return true;
  }
  return cursor >= to;
}

export type ContextReferenceType =
  | "file"
  | "directory"
  | "lineRange"
  | "symbol"
  | "git"
  | "priorContext"
  | "secret"
  | "skill"
  | "mcp";

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

export interface AtomicReferenceChip {
  from: number;
  to: number;
  /** Codicon name (without the `codicon-` prefix) shown as the chip's leading icon. */
  icon: string;
  /** Short label shown in place of the full reference text. */
  label: string;
  /** Full original reference text — surfaced as the chip's hover title. */
  title: string;
  /** data-* attributes forwarded to the existing link click/tap handler. */
  attrs: Record<string, string>;
  /**
   * True once the async validation pass has confirmed the reference doesn't
   * resolve. Undefined until validated, so a freshly-typed chip isn't flagged.
   */
  invalid?: boolean;
}

/** Build a file-operation descriptor directly from its canonical event path. */
export function createFileReferenceChip(path: string): AtomicReferenceChip {
  const directory = path.endsWith("/") || path.endsWith("\\");
  return {
    from: 0,
    to: path.length,
    icon: directory ? "folder" : "symbol-file",
    label: `${referenceBasename(path)}${directory ? "/" : ""}`,
    title: path,
    attrs: {
      "data-type": directory ? "directory" : "file",
      "data-path": path,
    },
  };
}

/** Build the row-local source/label projection consumed by AtomicReferenceChip. */
export function createAtomicReferencePresentation(
  descriptor: AtomicReferenceChip,
  sourceText: string
): AtomicReferencePresentation {
  const label = descriptor.label;
  const type = descriptor.attrs["data-type"];
  const compactStart = (() => {
    switch (type) {
      case "directory":
      case "file":
        return Math.max(
          0,
          sourceText.lastIndexOf(
            referenceBasename(descriptor.attrs["data-path"] ?? "")
          )
        );
      case "lineRange":
        return Math.max(
          0,
          sourceText.lastIndexOf(
            `${referenceBasename(descriptor.attrs["data-path"] ?? "")}:${descriptor.attrs["data-line-start"] ?? ""}-${descriptor.attrs["data-line-end"] ?? ""}`
          )
        );
      case "symbol":
        return Math.max(
          0,
          sourceText.lastIndexOf(descriptor.attrs["data-symbol-name"] ?? label)
        );
      case "git":
        return Math.max(
          0,
          sourceText.lastIndexOf(descriptor.attrs["data-git-ref"] ?? label)
        );
      case "priorContext":
        return sourceText.startsWith("$") ? 1 : 0;
      case "secret":
        return Math.max(
          0,
          sourceText.lastIndexOf(descriptor.attrs["data-secret-name"] ?? label)
        );
      case CTRLYOKE_SLASH_TOKEN_KINDS.SKILL:
        return Math.max(
          0,
          sourceText.lastIndexOf(descriptor.attrs["data-skill-name"] ?? label)
        );
      case CTRLYOKE_SLASH_TOKEN_KINDS.MCP:
        return Math.max(
          0,
          sourceText.lastIndexOf(
            descriptor.attrs["data-mcp-server-name"] ?? label
          )
        );
      default:
        return 0;
    }
  })();

  return {
    sourceText,
    rowRange: { from: descriptor.from, to: descriptor.to },
    compactRanges: [
      {
        source: {
          from: compactStart,
          to: Math.min(sourceText.length, compactStart + label.length),
        },
        label: { from: 0, to: label.length },
      },
    ],
    compactLabel: label,
    selectionText: sourceText,
  };
}

export const DEFAULT_COMPLETION_ICON = "symbol-misc";

// The 5 chart accent colors are the only saturated, mutually-distinct accent
// colors verified present in every sampled VS Code theme. They are shared by
// CodeMirror's generated rules and future React atomic-reference chips.
export const CHART_ACCENT_COLORS = {
  blue: "var(--vscode-charts-blue, #59a4f9)",
  green: "var(--vscode-charts-green, #89d185)",
  orange: "var(--vscode-charts-orange, #cd861a)",
  purple: "var(--vscode-charts-purple, #b180d7)",
  red: "var(--vscode-charts-red, #f14c4c)",
  yellow: "var(--vscode-charts-yellow, #cca700)",
} as const;

// Maps codicon names to the VS Code symbolIcon theme variable that colors the
// icon. This is the single source for completions and atomic-reference chips.
export const SYMBOL_ICON_COLORS: Record<string, string> = {
  // DEFAULT_COMPLETION_ICON must have an entry: a chip whose icon is missing
  // from this map gets no icon color *and* no accent, because the accent is
  // driven off the same lookup (--atomic-reference-accent in
  // AtomicReferenceChip, buildChipAccentShadowRules in codemirrorTheme). A
  // #sym: reference renders with the fallback icon until its kind resolves, so
  // without this it would paint as a bare uncolored box in the meantime.
  [DEFAULT_COMPLETION_ICON]: "var(--vscode-symbolIcon-textForeground, #cccccc)",
  "symbol-text": "var(--vscode-symbolIcon-textForeground, #cccccc)",
  "symbol-method": "var(--vscode-symbolIcon-methodForeground, #b180d7)",
  "symbol-function": "var(--vscode-symbolIcon-functionForeground, #b180d7)",
  "symbol-constructor":
    "var(--vscode-symbolIcon-constructorForeground, #b180d7)",
  "symbol-field": "var(--vscode-symbolIcon-fieldForeground, #75beff)",
  "symbol-variable": "var(--vscode-symbolIcon-variableForeground, #75beff)",
  "symbol-class": "var(--vscode-symbolIcon-classForeground, #ee9d28)",
  "symbol-interface": "var(--vscode-symbolIcon-interfaceForeground, #75beff)",
  "symbol-module": "var(--vscode-symbolIcon-moduleForeground, #cccccc)",
  "symbol-property": "var(--vscode-symbolIcon-propertyForeground, #cccccc)",
  "symbol-value": "var(--vscode-symbolIcon-constantForeground, #cccccc)",
  "symbol-enum": "var(--vscode-symbolIcon-enumeratorForeground, #ee9d28)",
  "symbol-keyword": "var(--vscode-symbolIcon-keywordForeground, #cccccc)",
  "symbol-snippet": "var(--vscode-symbolIcon-snippetForeground, #cccccc)",
  "symbol-color": "var(--vscode-symbolIcon-colorForeground, #cccccc)",
  "symbol-file": CHART_ACCENT_COLORS.blue,
  folder: CHART_ACCENT_COLORS.yellow,
  "symbol-enum-member":
    "var(--vscode-symbolIcon-enumeratorMemberForeground, #75beff)",
  "symbol-constant": "var(--vscode-symbolIcon-constantForeground, #cccccc)",
  "symbol-struct": "var(--vscode-symbolIcon-structForeground, #cccccc)",
  "symbol-event": "var(--vscode-symbolIcon-eventForeground, #ee9d28)",
  "symbol-operator": "var(--vscode-symbolIcon-operatorForeground, #cccccc)",
  "symbol-type-parameter":
    "var(--vscode-symbolIcon-typeParameterForeground, #cccccc)",
  "list-selection": CHART_ACCENT_COLORS.purple,
  "source-control": CHART_ACCENT_COLORS.green,
  book: CHART_ACCENT_COLORS.red,
  shield: CHART_ACCENT_COLORS.blue,
  checklist: CHART_ACCENT_COLORS.green,
  // /skill: and /mcp: slash-token chips (see describeSlashTokenChip) share the
  // orange accent so both read as one "ctrlyoke attachment" family, distinct
  // from the file/symbol/git/prior-context accents above.
  tools: CHART_ACCENT_COLORS.orange,
  mcp: CHART_ACCENT_COLORS.orange,
  key: CHART_ACCENT_COLORS.purple,
};

export type SymbolIconResolver = (
  path: string,
  symbolName: string,
  lineStart?: string,
  lineEnd?: string
) => string | undefined;

// Basename of a path, tolerant of a trailing separator and of either separator.
//
// Backslashes matter here: references authored in the prompt editor are always
// forward-slash workspace-relative, but a *file-operation event* path comes
// straight off the harness's tool call, and in a multi-root workspace ctrlyoke
// hands the harness absolute paths (see CliIntegration.getEffectiveAbsolute) —
// on Windows that means `C:\dev\repo\src\foo.ts`. Splitting on `/` alone found
// no separator there and returned the whole path, so every multi-root file chip
// rendered fully expanded instead of showing just `foo.ts`.
export function referenceBasename(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

// Compact label for a ~git reference; the full hash remains in the title.
export function gitReferenceLabel(gitRef: string): string {
  if (gitRef === "diff" || gitRef === "staged") return gitRef;
  const stash = gitRef.match(/^stash:(\d+)$/);
  if (stash) return `stash ${stash[1]}`;
  return gitRef.slice(0, 7);
}

export interface InlinePriorContextRef {
  from: number;
  to: number;
  token: string;
  kind: "previous" | "all" | "finalStep" | "allFinalStep" | "step";
  indices?: number[];
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

/**
 * Find condition-output refs without widening the prior-context ref type.
 *
 * This intentionally mirrors findInlinePriorContextRefs' tokenizer. The two
 * namespaces have different runtime meanings and must remain separate.
 */
export function findConditionOutputRefs(
  text: string,
  offset = 0
): ConditionOutputRef[] {
  const results: ConditionOutputRef[] = [];
  const regex = new RegExp(
    `${NOT_AFTER_BOUNDARY}\\$([A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9,\\-]*)?)`,
    "g"
  );
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const body = match[1];
    const separatorIndex = body.indexOf(":");
    if (separatorIndex === -1) continue;

    const phase = body.slice(0, separatorIndex);
    const field = body.slice(separatorIndex + 1);
    if (!isConditionOutputPhase(phase) || !isConditionOutputField(field)) {
      continue;
    }

    const token = match[0];
    const from = offset + match.index;
    results.push({
      from,
      to: from + token.length,
      token,
      phase,
      field,
    });
  }

  return results;
}

export const PRIOR_CONTEXT_CHIP_LABELS: Record<
  Exclude<InlinePriorContextRef["kind"], "step">,
  string
> = {
  previous: "previous",
  all: "all steps",
  finalStep: "final step",
  allFinalStep: "all final",
};

function describeContextReferenceChip(
  ref: ContextReferenceMatch,
  docText: string,
  getSymbolIcon?: SymbolIconResolver
): Omit<AtomicReferenceChip, "from" | "to"> {
  const title = docText.slice(ref.from, ref.to);
  const attrs: Record<string, string> = { "data-type": ref.type };

  switch (ref.type) {
    case "directory":
      attrs["data-path"] = ref.path ?? "";
      return {
        icon: "folder",
        label: `${referenceBasename(ref.path ?? "")}/`,
        title,
        attrs,
      };
    case "lineRange":
      attrs["data-path"] = ref.path ?? "";
      if (ref.lineStart) attrs["data-line-start"] = ref.lineStart;
      if (ref.lineEnd) attrs["data-line-end"] = ref.lineEnd;
      return {
        icon: "list-selection",
        label: `${referenceBasename(ref.path ?? "")}:${ref.lineStart}-${ref.lineEnd}`,
        title,
        attrs,
      };
    case "symbol":
      attrs["data-path"] = ref.path ?? "";
      if (ref.symbolName) attrs["data-symbol-name"] = ref.symbolName;
      if (ref.lineStart) attrs["data-line-start"] = ref.lineStart;
      if (ref.lineEnd) attrs["data-line-end"] = ref.lineEnd;
      return {
        icon:
          (ref.path &&
            ref.symbolName &&
            getSymbolIcon?.(
              ref.path,
              ref.symbolName,
              ref.lineStart,
              ref.lineEnd
            )) ||
          (ref.symbolKind && SYMBOL_KIND_ICONS[ref.symbolKind]) ||
          DEFAULT_COMPLETION_ICON,
        label: ref.symbolName || referenceBasename(ref.path ?? ""),
        title,
        attrs,
      };
    case "git":
      if (ref.gitRef) attrs["data-git-ref"] = ref.gitRef;
      return {
        icon: "source-control",
        label: gitReferenceLabel(ref.gitRef ?? ""),
        title,
        attrs,
      };
    case "secret":
      attrs["data-secret-name"] = ref.secretName ?? "";
      return {
        icon: "key",
        label: ref.secretName ?? "",
        title,
        attrs,
      };
    case "file":
    default:
      attrs["data-path"] = ref.path ?? "";
      return {
        icon: "symbol-file",
        label: referenceBasename(ref.path ?? ""),
        title,
        attrs,
      };
  }
}

export function describePriorContextChip(
  ref: InlinePriorContextRef,
  docText: string
): Omit<AtomicReferenceChip, "from" | "to"> {
  const title = docText.slice(ref.from, ref.to);
  const dataRef =
    ref.kind === "step" ? `step:${ref.indices?.join(",") ?? ""}` : ref.kind;
  const label =
    ref.kind === "step"
      ? `step ${ref.indices?.join(",") ?? ""}`
      : PRIOR_CONTEXT_CHIP_LABELS[ref.kind];
  return {
    icon: "book",
    label,
    title,
    attrs: { "data-type": "priorContext", "data-ref": dataRef },
  };
}

function describeConditionOutputChip(
  ref: ConditionOutputRef,
  docText: string
): Omit<AtomicReferenceChip, "from" | "to"> {
  return {
    icon:
      ref.phase === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
        ? "shield"
        : "checklist",
    label: `${ref.phase}:${ref.field}`,
    title: docText.slice(ref.from, ref.to),
    attrs: {
      "data-type": "conditionOutput",
      "data-phase": ref.phase,
      "data-field": ref.field,
    },
  };
}

// Explicit /skill:<name> and /mcp:<name> references (see CtrlYokeSlashTokens.ts).
// A separate parser from findContextReferenceMatches by design — the two
// namespaces don't overlap and share no token grammar — but the resulting
// chip follows the exact same icon/label/title/attrs shape so it renders and
// finds identically to every other atomic reference.
function describeSlashTokenChip(
  token: CtrlYokeSlashToken
): Omit<AtomicReferenceChip, "from" | "to"> {
  if (token.kind === CTRLYOKE_SLASH_TOKEN_KINDS.MCP) {
    return {
      icon: "mcp",
      label: token.name,
      title: token.raw,
      attrs: {
        "data-type": CTRLYOKE_SLASH_TOKEN_KINDS.MCP,
        "data-mcp-server-name": token.name,
      },
    };
  }
  return {
    icon: "tools",
    label: token.name,
    title: token.raw,
    attrs: {
      "data-type": CTRLYOKE_SLASH_TOKEN_KINDS.SKILL,
      "data-skill-name": token.name,
    },
  };
}

export function findAtomicReferences(
  docText: string,
  getSymbolIcon?: SymbolIconResolver,
  getValidity?: (referenceToken: string) => boolean | undefined
): AtomicReferenceChip[] {
  const fencedRanges = getFencedBlockRanges(docText);
  const candidates: Array<{
    from: number;
    to: number;
    invalid?: boolean;
    describe: () => Omit<AtomicReferenceChip, "from" | "to">;
  }> = [
    ...findContextReferenceMatches(docText).map((ref) => ({
      from: ref.from,
      to: ref.to,
      invalid:
        getValidity?.(docText.slice(ref.from, ref.to)) === false
          ? true
          : undefined,
      describe: () => describeContextReferenceChip(ref, docText, getSymbolIcon),
    })),
    ...findInlinePriorContextRefs(docText).map((ref) => ({
      from: ref.from,
      to: ref.to,
      invalid:
        getValidity?.(docText.slice(ref.from, ref.to)) === false
          ? true
          : undefined,
      describe: () => describePriorContextChip(ref, docText),
    })),
    ...findConditionOutputRefs(docText).map((ref) => ({
      from: ref.from,
      to: ref.to,
      describe: () => describeConditionOutputChip(ref, docText),
    })),
    ...scanCtrlYokeSlashTokens(docText).map((token) => ({
      from: token.index,
      to: token.index + token.length,
      describe: () => describeSlashTokenChip(token),
    })),
  ]
    .filter((ref) => !isInFencedBlock(ref.from, ref.to, fencedRanges))
    .sort((a, b) => a.from - b.from || b.to - a.to);

  const chips: AtomicReferenceChip[] = [];
  let lastTo = -1;
  for (const candidate of candidates) {
    if (candidate.from < lastTo) continue;
    chips.push({
      ...candidate.describe(),
      from: candidate.from,
      to: candidate.to,
      invalid: candidate.invalid,
    });
    lastTo = candidate.to;
  }
  return chips;
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
    type: "secret",
    secretName: reference.name,
  }));
  const gitMatches: ContextReferenceMatch[] = [];
  let match: RegExpExecArray | null;
  const collectPathMatches = (
    pattern: RegExp,
    type: "file" | "directory",
    target: ContextReferenceMatch[]
  ) => {
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      target.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type,
        path: match[1],
      });
    }
  };
  collectPathMatches(patterns.fullFileQuoted, "file", fileMatches);
  collectPathMatches(patterns.fullFile, "file", fileMatches);
  collectPathMatches(patterns.directoryQuoted, "directory", directoryMatches);
  collectPathMatches(patterns.directory, "directory", directoryMatches);
  const collectLineRangeMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      lineRangeMatches.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type: "lineRange",
        path: match[1] ?? match[2],
        lineStart: match[3],
        lineEnd: match[4],
      });
    }
  };
  collectLineRangeMatches(patterns.lineRange);
  const collectSymbolMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      symbolMatches.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type: "symbol",
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
          type: "git",
          gitRef: normalize(match),
        });
      }
    }
  };
  collectGitMatches(
    new RegExp(`${NOT_AFTER_BOUNDARY}~(diff|staged)`, "g"),
    (m) => m[1]
  );
  collectGitMatches(
    new RegExp(`${NOT_AFTER_BOUNDARY}~(stash:\\d+)`, "g"),
    (m) => m[1]
  );
  collectGitMatches(
    new RegExp(`${NOT_AFTER_BOUNDARY}~([0-9a-f]{7,40})`, "gi"),
    (m) => m[1].toLowerCase()
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

export function getFencedBlockRanges(
  text: string
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const regex = /```[\s\S]*?```/g;
  let match;
  while ((match = regex.exec(text)) !== null)
    ranges.push({ from: match.index, to: match.index + match[0].length });
  return ranges;
}

export function isInFencedBlock(
  from: number,
  to: number,
  fencedRanges: Array<{ from: number; to: number }>
): boolean {
  return fencedRanges.some((r) => from >= r.from && to <= r.to);
}

function parsePriorContextStepRange(rangeText: string): number[] | null {
  if (!rangeText) return null;
  const indices: number[] = [];
  for (const part of rangeText.split(",")) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end) return null;
      for (let i = start; i <= end; i++) indices.push(i);
    } else if (/^\d+$/.test(part)) indices.push(parseInt(part, 10));
    else return null;
  }
  return indices.length > 0 ? indices : null;
}

export function findInlinePriorContextRefs(
  text: string,
  offset = 0
): InlinePriorContextRef[] {
  const results: InlinePriorContextRef[] = [];
  // Same word-boundary rationale as the @/#/~ patterns above.
  const regex = new RegExp(
    `${NOT_AFTER_BOUNDARY}\\$([A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9,\\-]*)?)`,
    "g"
  );
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const body = match[1];
    const token = match[0];
    const from = offset + match.index;
    const to = from + token.length;
    if (body === "previous")
      results.push({ from, to, token, kind: "previous" });
    else if (body === "all") results.push({ from, to, token, kind: "all" });
    else if (body === "finalStep")
      results.push({ from, to, token, kind: "finalStep" });
    else if (body === "allFinalStep")
      results.push({ from, to, token, kind: "allFinalStep" });
    else if (body.startsWith("step:")) {
      const indices = parsePriorContextStepRange(body.slice("step:".length));
      if (indices !== null)
        results.push({ from, to, token, kind: "step", indices });
    }
  }
  return results;
}
