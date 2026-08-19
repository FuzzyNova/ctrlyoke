import * as fs from "fs";
import * as path from "path";

/**
 * Themed HTML landing page for hosted-server error responses (401 token
 * rejection, 404 missing resource). Mirrors the current VS Code theme by
 * reusing the same `<style>` block and body class that CtrlYokeHostedServer
 * injects into the main app shell, so the error page never flashes an
 * unstyled/mismatched background before a user has a valid session.
 *
 * The markup lives in hosted-error-page.html (real HTML, real editor
 * support) rather than a template-literal string here — see
 * HostedServiceWorkerScript.ts for the same read-template/substitute-
 * placeholders pattern used for the service worker script.
 */

const TITLE_PLACEHOLDER = "__CTRLYOKE_TITLE__";
const THEME_STYLE_BLOCK_PLACEHOLDER = "__CTRLYOKE_THEME_STYLE_BLOCK__";
const BODY_CLASS_PLACEHOLDER = "__CTRLYOKE_BODY_CLASS__";
const STATUS_CODE_PLACEHOLDER = "__CTRLYOKE_STATUS_CODE__";
const MESSAGE_PLACEHOLDER = "__CTRLYOKE_MESSAGE__";
const HINTS_BLOCK_PLACEHOLDER = "__CTRLYOKE_HINTS_BLOCK__";

const ERROR_PAGE_TEMPLATE_CANDIDATE_PATHS = [
  path.join(__dirname, "server", "hosted-error-page.html"),
  path.join(__dirname, "hosted-error-page.html"),
];

let cachedTemplate: string | undefined;

export interface HostedErrorPageOptions {
  statusCode: 401 | 404;
  message: string;
  hints?: string[];
  themeBodyClass: string;
  themeStyleBlock: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildHostedErrorPage(options: HostedErrorPageOptions): string {
  return renderHostedErrorPage(getHostedErrorPageTemplate(), options);
}

export function renderHostedErrorPage(
  template: string,
  options: HostedErrorPageOptions
): string {
  const { statusCode, message, hints, themeBodyClass, themeStyleBlock } =
    options;
  const title = statusCode === 401 ? "Unauthorized" : "Not Found";
  const hintsBlock =
    hints && hints.length > 0
      ? `<ul class="ctrlyoke-error-hints">${hints
          .map((hint) => `<li>${escapeHtml(hint)}</li>`)
          .join("")}</ul>`
      : "";

  const substitutions: Array<[string, string]> = [
    [TITLE_PLACEHOLDER, title],
    [THEME_STYLE_BLOCK_PLACEHOLDER, themeStyleBlock],
    [BODY_CLASS_PLACEHOLDER, themeBodyClass],
    [STATUS_CODE_PLACEHOLDER, String(statusCode)],
    [MESSAGE_PLACEHOLDER, escapeHtml(message)],
    [HINTS_BLOCK_PLACEHOLDER, hintsBlock],
  ];
  return substitutions.reduce(
    (html, [placeholder, value]) =>
      replacePlaceholder(html, placeholder, value),
    template
  );
}

function replacePlaceholder(
  template: string,
  placeholder: string,
  value: string
): string {
  if (!template.includes(placeholder)) {
    throw new Error(`Missing hosted error page placeholder: ${placeholder}`);
  }
  return template.replaceAll(placeholder, value);
}

function getHostedErrorPageTemplate(): string {
  if (!cachedTemplate) {
    const templatePath = ERROR_PAGE_TEMPLATE_CANDIDATE_PATHS.find((file) =>
      fs.existsSync(file)
    );
    if (!templatePath) {
      throw new Error("Hosted error page template file was not found");
    }
    cachedTemplate = fs.readFileSync(templatePath, "utf8");
  }
  return cachedTemplate;
}
