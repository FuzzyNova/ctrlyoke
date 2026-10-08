import { syntaxHighlighting, type Language } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { styleTags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { php } from "@codemirror/lang-php";
import { yaml } from "@codemirror/lang-yaml";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  getLanguageFromPath,
  normalizeSyntaxLanguage,
} from "@utils/syntaxHighlighting";
import {
  createCtrlYokeHighlightStyle,
  LIST_MARK_TAG,
  QUOTE_MARK_TAG,
} from "@utils/syntaxPalette";
import { CODEMIRROR_LANGUAGE_IDS } from "@root/types/DashboardConstants";

/**
 * Maps a language name or alias (a fence info string such as `ts` or
 * `language-yml`, or a canonical id from {@link getLanguageFromPath}) to its
 * CodeMirror LanguageSupport. Returns null for plain text or an unsupported
 * language.
 */
export function resolveCodeMirrorLanguage(name: string | undefined) {
  switch (normalizeSyntaxLanguage(name)) {
    case CODEMIRROR_LANGUAGE_IDS.JAVASCRIPT:
      return javascript({ jsx: false });
    case CODEMIRROR_LANGUAGE_IDS.JSX:
      return javascript({ jsx: true });
    case CODEMIRROR_LANGUAGE_IDS.TYPESCRIPT:
      return javascript({ typescript: true });
    case CODEMIRROR_LANGUAGE_IDS.TSX:
      return javascript({ typescript: true, jsx: true });
    case CODEMIRROR_LANGUAGE_IDS.PYTHON:
      return python();
    case CODEMIRROR_LANGUAGE_IDS.RUST:
      return rust();
    case CODEMIRROR_LANGUAGE_IDS.JSON:
      return json();
    case CODEMIRROR_LANGUAGE_IDS.MARKUP:
      return html();
    case CODEMIRROR_LANGUAGE_IDS.CSS:
    case CODEMIRROR_LANGUAGE_IDS.SCSS:
      return css();
    case CODEMIRROR_LANGUAGE_IDS.YAML:
      return yaml();
    case CODEMIRROR_LANGUAGE_IDS.MARKDOWN:
      return markdown();
    case CODEMIRROR_LANGUAGE_IDS.JAVA:
      return java();
    case CODEMIRROR_LANGUAGE_IDS.CPP:
    case CODEMIRROR_LANGUAGE_IDS.C:
      return cpp();
    case CODEMIRROR_LANGUAGE_IDS.PHP:
      return php();
    default:
      return null;
  }
}

/** Maps a file path to the appropriate CodeMirror LanguageSupport extension. Returns null for plain text. */
export function getLanguageExtension(filePath: string) {
  return resolveCodeMirrorLanguage(getLanguageFromPath(filePath));
}

const fenceLanguageCache = new Map<string, Language | null>();

/**
 * `codeLanguages` resolver for markdown: maps a fence info string to the
 * nested language. Only the first word counts (`ts title=a.ts` is `ts`), and
 * each language is built on first use and then reused, so a prompt with many
 * fences does not rebuild a `LanguageSupport` per fence.
 */
export function resolveFenceLanguage(info: string): Language | null {
  const name = info.trim().split(/\s+/, 1)[0] ?? "";
  const key = normalizeSyntaxLanguage(name) ?? "";
  let language = fenceLanguageCache.get(key);
  if (language === undefined) {
    language = key ? (resolveCodeMirrorLanguage(key)?.language ?? null) : null;
    fenceLanguageCache.set(key, language);
  }
  return language;
}

/**
 * Markdown (GFM) for prompt text: strikethrough, tables and task lists get
 * styling, fenced code is highlighted in its own language, and the quote and
 * list marks carry their own tags. No keymap and no HTML tag completion, so
 * Enter, Tab, Backspace and the completion sources behave exactly as they do
 * without a language.
 */
export function createPromptMarkdownLanguage() {
  return markdown({
    base: markdownLanguage,
    codeLanguages: resolveFenceLanguage,
    addKeymap: false,
    completeHTMLTags: false,
    extensions: {
      props: [
        styleTags({ QuoteMark: QUOTE_MARK_TAG, ListMark: LIST_MARK_TAG }),
      ],
    },
  });
}

/** Workspace editor syntax highlighting, coloured by the shared `--cy-syntax-*` palette. */
export function createWorkspaceEditorHighlightExtension() {
  return syntaxHighlighting(createCtrlYokeHighlightStyle());
}

/** Markdown language plus the shared palette, for the prompt editor. */
export function createPromptMarkdownExtension(): Extension {
  return [
    createPromptMarkdownLanguage(),
    createWorkspaceEditorHighlightExtension(),
  ];
}
