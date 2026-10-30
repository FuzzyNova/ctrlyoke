import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { linter, type Action, type Diagnostic } from "@codemirror/lint";
import { looksLikeFilePath } from "@root/utils/promptPathUtils";
import { createGitChangeReferencePattern } from "@root/utils/ReferencePatterns";
import { findVariablePlaceholders } from "@root/utils/VariablePlaceholders";
import {
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import type { SpellCheckService } from "./spellChecker";
import { isLintRefreshUpdate } from "./codemirrorRelint";

const MAX_SPELLING_SUGGESTIONS = 5;

export interface SpellCheckExtensionOptions {
  checker: SpellCheckService;
  allowWorkspaceFolderPrefix: boolean;
  /** Read on every lint pass; when false the linter reports nothing. */
  isEnabled: () => boolean;
  /** Whether a workspace is open, so the workspace-dictionary fix can be offered. */
  hasWorkspace: () => boolean;
  /** Save `word` to that scope's `spelling.words`. */
  onAddWord: (word: string, scope: SettingWriteScope) => void;
}

/**
 * A spelling diagnostic whose actions are computed on first read: Typo.js
 * suggestions are slow, and most diagnostics are never opened.
 */
function createSpellingDiagnostic(
  from: number,
  to: number,
  word: string,
  buildActions: () => readonly Action[]
): Diagnostic {
  let actions: readonly Action[] | undefined;
  return {
    from,
    to,
    severity: "error",
    message: `Spelling: "${word}"`,
    get actions() {
      actions ??= buildActions();
      return actions;
    },
  };
}

function buildSpellingActions(
  word: string,
  options: SpellCheckExtensionOptions
): Action[] {
  const changeActions = options.checker
    .suggest(word)
    .slice(0, MAX_SPELLING_SUGGESTIONS)
    .map((suggestion): Action => ({
      name: `Change to "${suggestion}"`,
      apply: (view: EditorView, from: number, to: number) => {
        view.dispatch({ changes: { from, to, insert: suggestion } });
      },
    }));
  const addActions: Action[] = [
    {
      name: `Add "${word}" to dictionary`,
      apply: () => options.onAddWord(word, SETTING_SCOPES.USER),
    },
  ];
  if (options.hasWorkspace()) {
    addActions.push({
      name: `Add "${word}" to workspace dictionary`,
      apply: () => options.onAddWord(word, SETTING_SCOPES.WORKSPACE),
    });
  }
  return [...changeActions, ...addActions];
}

/**
 * Prompt-editor spell check. Words come from the shared `SpellCheckService`,
 * so every editor reuses one loaded dictionary and one custom-word list.
 */
export function createSpellCheckExtension(options: SpellCheckExtensionOptions) {
  const { checker, allowWorkspaceFolderPrefix } = options;
  return linter(
    (view) => {
      if (!options.isEnabled() || !checker.isReady()) return [];

      // Skip spellcheck entirely when the document is a lone file-path reference
      if (
        looksLikeFilePath(view.state.doc.toString().trim(), {
          allowWorkspaceFolderPrefix,
        })
      ) {
        return [];
      }

      const diagnostics: Diagnostic[] = [];

      // Only check visible ranges for performance
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);

        // Get ranges to exclude from spell checking (@ and # references)
        const excludedRanges = [
          ...getCompletionRanges(text),
          ...getMarkdownNonProseRanges(view.state, from, to),
        ];

        // Match words and contractions in any script. Hyphens and underscores
        // act as separators — the regex stops at them, so "step-by-step" is
        // matched as three separate tokens. CamelCase words are further split
        // by splitCamelCaseWord().
        const wordRegex = /\p{L}+(?:['’]\p{L}+)*/gu;
        let match;

        while ((match = wordRegex.exec(text)) !== null) {
          const word = match[0];

          // Skip if word is within a completion range
          if (
            isInExcludedRange(
              match.index,
              match.index + word.length,
              excludedRanges
            )
          ) {
            continue;
          }

          // Skip all-caps words (likely acronyms)
          if (word === word.toUpperCase() && word.length > 1) {
            continue;
          }

          // A custom word is matched whole, before the camelCase split, so a
          // saved "CtrlYoke" is not checked as "Ctrl" and "Yoke".
          if (checker.isCustomWord(word)) continue;

          // Split camelCase / PascalCase words into component parts and check
          // each individually with its correct document position.
          const parts = splitCamelCaseWord(word);
          for (const part of parts) {
            if (part.text.length <= 1) continue;
            // Skip all-caps parts (e.g. "XML" within "XMLParser")
            if (part.text === part.text.toUpperCase()) continue;

            // The dictionary spells contractions with a straight apostrophe.
            const dictionaryWord = part.text.replace(/’/g, "'");
            if (checker.check(dictionaryWord)) continue;

            const partFrom = from + match.index + part.offset;
            diagnostics.push(
              createSpellingDiagnostic(
                partFrom,
                partFrom + part.text.length,
                part.text,
                () => buildSpellingActions(part.text, options)
              )
            );
          }
        }
      }

      return diagnostics;
    },
    { delay: 200, needsRefresh: isLintRefreshUpdate }
  );
}

// Get ranges of @/#/~ references and {{var}} placeholders to exclude from
// spell checking — a variable name is an identifier, not prose.
function getCompletionRanges(
  text: string
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];

  // Match both plain paths (@src/file.ts) and quoted paths (@"path with spaces/file.ts"),
  // as well as ~ git change references (~diff, ~staged, ~stash:N, ~<hash>).
  const patterns = [
    /@"[^"]*"|@[^\s@#~]+/g,
    /#"[^"]*"|#[^\s@#~]+/g,
    createGitChangeReferencePattern(),
  ];

  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(text)) !== null) {
      ranges.push({
        from: match.index,
        to: match.index + match[0].length,
      });
    }
  }

  for (const { from, to } of findVariablePlaceholders(text)) {
    ranges.push({ from, to });
  }

  return ranges;
}

/**
 * Fence info strings (`typescript`, `ts title=a.ts`) and link/image
 * destinations are not prose, so spellcheck skips them. Offsets are relative to
 * `from`, matching the text slice the caller checks.
 */
function getMarkdownNonProseRanges(
  state: EditorState,
  from: number,
  to: number
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name === "CodeInfo" || node.name === "URL") {
        ranges.push({ from: node.from - from, to: node.to - from });
      }
    },
  });
  return ranges;
}

// Check if a range overlaps with any excluded range
function isInExcludedRange(
  from: number,
  to: number,
  excludedRanges: Array<{ from: number; to: number }>
): boolean {
  for (const range of excludedRanges) {
    if (from < range.to && to > range.from) {
      return true;
    }
  }
  return false;
}

// Split a camelCase or PascalCase word into component parts with their offsets.
// Returns the original word as a single entry when no camelCase splitting applies
// (i.e. the word has no uppercase letter after position 0).
//
// Examples:
//   "camelCase"   → [{ text: "camel", offset: 0 }, { text: "Case", offset: 5 }]
//   "XMLParser"   → [{ text: "XML",   offset: 0 }, { text: "Parser", offset: 3 }]
//   "hello"       → [{ text: "hello", offset: 0 }]
//   "don't"       → [{ text: "don't", offset: 0 }]
export function splitCamelCaseWord(
  word: string
): Array<{ text: string; offset: number }> {
  // Only split if there's an uppercase letter after position 0
  if (!/\p{Lu}/u.test(word.slice(1))) {
    return [{ text: word, offset: 0 }];
  }

  const parts: Array<{ text: string; offset: number }> = [];
  // Three alternations (tried in order):
  //   1. Uppercase run before an UpperLower transition ("XML" in "XMLParser")
  //   2. Uppercase letter followed by zero-or-more lowercase ("Parser", "Case")
  //   3. Pure lowercase run ("camel", "my")
  const camelRegex = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}\p{Ll}*|\p{Ll}+/gu;
  let m;
  while ((m = camelRegex.exec(word)) !== null) {
    if (m[0].length > 1) {
      parts.push({ text: m[0], offset: m.index });
    }
  }
  return parts.length > 0 ? parts : [{ text: word, offset: 0 }];
}
