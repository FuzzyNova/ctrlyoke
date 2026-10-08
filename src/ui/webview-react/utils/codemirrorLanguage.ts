import { syntaxHighlighting } from "@codemirror/language";
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
import { markdown } from "@codemirror/lang-markdown";
import {
  getLanguageFromPath,
  normalizeSyntaxLanguage,
} from "@utils/syntaxHighlighting";
import { createCtrlYokeHighlightStyle } from "@utils/syntaxPalette";
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

/** Workspace editor syntax highlighting, coloured by the shared `--cy-syntax-*` palette. */
export function createWorkspaceEditorHighlightExtension() {
  return syntaxHighlighting(createCtrlYokeHighlightStyle());
}
