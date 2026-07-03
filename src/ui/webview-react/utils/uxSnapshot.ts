/**
 * UX Snapshot capture (dev-only)
 *
 * Serializes the live webview UI into a single self-describing Markdown document:
 *   1. Header / context (viewport, theme, standalone vs webview, device metrics)
 *   2. Serialized DOM (pretty-printed outerHTML of the App root)
 *   3. Per-element style table (non-default computed styles + matched author rules)
 *   4. Stylesheet inventory (readable + cross-origin-skipped sheets)
 *
 * Why this exists: Nathan often drives ctrlyoke from a phone (PWA / hosted
 * dashboard) where there are no browser dev tools to inspect the rendered DOM
 * and see which CSS applied. This is a pure, side-effect-free capture usable in
 * both the webview and the standalone browser client, and unit-testable in jsdom.
 *
 * Provenance note: true DevTools-grade provenance
 * (`CSS.getMatchedStylesForNode`) is unavailable in-page. The best in-page
 * approximation — and it is a very good one for a Tailwind app where every
 * utility class is a real CSS rule — is to pair `getComputedStyle` (ground
 * truth of what painted) with the author rules that `el.matches()` in source
 * order. The output is explicit about this being an approximation.
 */

const MAX_ELEMENTS = 4000;
const MAX_ATTR_VALUE_LENGTH = 200;
const MAX_TEXT_LENGTH = 200;
const MAX_MATCHED_RULES_PER_ELEMENT = 40;
const MAX_DECLARATION_LENGTH = 600;

/** Attributes stripped from the serialized DOM to cut noise. */
const NOISY_ATTRIBUTES = new Set(["data-reactroot"]);

export interface UxSnapshotResult {
  markdown: string;
  /** Reserved for a future visual companion — never populated in v1. */
  png?: string;
}

/**
 * Capture a full UX snapshot of the given root (defaults to the App root:
 * `#root`, falling back to `document.body`).
 */
export function captureUxSnapshot(root?: HTMLElement): UxSnapshotResult {
  const rootEl =
    root ??
    (document.getElementById("root") as HTMLElement | null) ??
    document.body;

  const sections: string[] = [];
  sections.push(buildHeaderSection(rootEl));
  sections.push(buildProvenanceNote());
  sections.push(buildStylesheetInventory());
  sections.push(buildSerializedDomSection(rootEl));
  sections.push(buildStyleTableSection(rootEl));

  return { markdown: sections.join("\n\n") };
}

// ============================================================================
// Header / context
// ============================================================================

export function buildHeaderSection(rootEl: HTMLElement): string {
  const vv = typeof visualViewport !== "undefined" ? visualViewport : undefined;
  const themeKind = getCssVar("--fp-color-theme-kind") || "(unset)";
  const bodyClasses = document.body.className || "(none)";
  const standalone = Boolean(
    (window as unknown as Record<string, unknown>).__ctrlyokeStandalone
  );

  const lines: string[] = [
    "# UX Snapshot",
    "",
    `- **Captured:** ${new Date().toISOString()}`,
    `- **Mode:** ${standalone ? "standalone (browser/PWA)" : "webview (VS Code)"}`,
    `- **Root element:** ${describeElementTag(rootEl)}`,
    `- **Window:** ${window.innerWidth}×${window.innerHeight} (devicePixelRatio ${window.devicePixelRatio})`,
    `- **Visual viewport:** ${
      vv
        ? `${Math.round(vv.width)}×${Math.round(vv.height)} @ offset ` +
          `(${Math.round(vv.offsetLeft)}, ${Math.round(vv.offsetTop)}), scale ${vv.scale}`
        : "(unavailable)"
    }`,
    `- **Theme kind (--fp-color-theme-kind):** ${themeKind}`,
    `- **Body classes:** \`${bodyClasses}\``,
    `- **User agent:** ${navigator.userAgent}`,
  ];
  return lines.join("\n");
}

function buildProvenanceNote(): string {
  return [
    "## About this snapshot",
    "",
    "This is an **in-page approximation** of DevTools, not DevTools output.",
    "True per-property provenance (`CSS.getMatchedStylesForNode`) is unavailable",
    "inside a webview/PWA. Instead, each element below lists its **non-default",
    "computed styles** (the values the browser actually resolved, diffed against",
    "a bare element of the same tag) and the **author CSS rules that match it**",
    "(in stylesheet source order). For a Tailwind app the matched-rules list",
    "names the utility classes doing the work, which is close to full provenance.",
  ].join("\n");
}

// ============================================================================
// Stylesheet inventory
// ============================================================================

export interface StylesheetInfo {
  index: number;
  href: string | null;
  ruleCount: number | null;
  readable: boolean;
  note?: string;
}

export function collectStylesheetInfo(): StylesheetInfo[] {
  const out: StylesheetInfo[] = [];
  for (let i = 0; i < document.styleSheets.length; i++) {
    const sheet = document.styleSheets[i];
    let ruleCount: number | null = null;
    let readable = true;
    let note: string | undefined;
    try {
      // Accessing cssRules throws SecurityError for cross-origin sheets.
      ruleCount = sheet.cssRules ? sheet.cssRules.length : 0;
    } catch {
      readable = false;
      note = "unreadable (cross-origin)";
    }
    out.push({
      index: i,
      href: sheet.href ?? null,
      ruleCount,
      readable,
      note,
    });
  }
  return out;
}

function buildStylesheetInventory(): string {
  const sheets = collectStylesheetInfo();
  const lines: string[] = ["## Stylesheet inventory", ""];
  if (sheets.length === 0) {
    lines.push("_No stylesheets found._");
    return lines.join("\n");
  }
  for (const s of sheets) {
    const label = s.href ?? "(inline <style>)";
    const detail = s.readable
      ? `${s.ruleCount} rules`
      : (s.note ?? "unreadable");
    lines.push(`- [${s.index}] ${label} — ${detail}`);
  }
  return lines.join("\n");
}

// ============================================================================
// Serialized DOM
// ============================================================================

function buildSerializedDomSection(rootEl: HTMLElement): string {
  return [
    "## Serialized DOM",
    "",
    "```html",
    serializeElement(rootEl, 0),
    "```",
  ].join("\n");
}

/** Recursively serialize an element into indented, noise-stripped HTML. */
export function serializeElement(el: Element, depth: number): string {
  const indent = "  ".repeat(depth);
  const tag = el.tagName.toLowerCase();
  const attrs = serializeAttributes(el);
  const open = `${indent}<${tag}${attrs}>`;

  // <script>/<style> bodies are noise — collapse them.
  if (tag === "script" || tag === "style") {
    return `${open}…${indent ? "" : ""}</${tag}>`;
  }

  const childParts: string[] = [];
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      childParts.push(serializeElement(node as Element, depth + 1));
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").trim();
      if (text.length > 0) {
        childParts.push(`${"  ".repeat(depth + 1)}${truncate(text, MAX_TEXT_LENGTH)}`);
      }
    }
  });

  if (childParts.length === 0) {
    return `${open}</${tag}>`;
  }
  return `${open}\n${childParts.join("\n")}\n${indent}</${tag}>`;
}

function serializeAttributes(el: Element): string {
  const parts: string[] = [];
  for (const attr of Array.from(el.attributes)) {
    if (NOISY_ATTRIBUTES.has(attr.name)) {
      continue;
    }
    const value = truncate(attr.value, MAX_ATTR_VALUE_LENGTH);
    parts.push(`${attr.name}="${escapeAttr(value)}"`);
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

// ============================================================================
// Per-element style table
// ============================================================================

function buildStyleTableSection(rootEl: HTMLElement): string {
  const lines: string[] = [
    "## Per-element styles",
    "",
    "For each element: a stable path, its non-default computed styles, and the",
    "author rules that match it (stylesheet source order).",
    "",
  ];

  const probeCache = new Map<string, Record<string, string>>();
  const probeHost = createProbeHost();
  let count = 0;
  let truncated = false;

  try {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = rootEl;
    while (current) {
      const el = current as Element;
      if (count >= MAX_ELEMENTS) {
        truncated = true;
        break;
      }
      count++;

      lines.push(`### ${count}. \`${buildElementPath(el, rootEl)}\``);

      const styleDiff = diffComputedStyles(el, probeCache, probeHost);
      if (styleDiff.length > 0) {
        lines.push("");
        lines.push("Computed (non-default):");
        lines.push("```css");
        for (const { prop, value } of styleDiff) {
          lines.push(`${prop}: ${value};`);
        }
        lines.push("```");
      }

      const matched = getMatchedAuthorRules(el);
      if (matched.length > 0) {
        lines.push("");
        lines.push("Matched author rules:");
        lines.push("```css");
        for (const rule of matched) {
          lines.push(rule);
        }
        lines.push("```");
      }
      lines.push("");

      current = walker.nextNode();
    }
  } finally {
    probeHost.remove();
  }

  if (truncated) {
    lines.push(
      `_Truncated at ${MAX_ELEMENTS} elements to bound file size._`
    );
  }
  return lines.join("\n");
}

/**
 * Build a stable, human-readable path selector for an element, from the root
 * down: `tag#id.class1.class2:nth-child(n)` segments joined by " > ".
 */
export function buildElementPath(el: Element, root: Element): string {
  const segments: string[] = [];
  let node: Element | null = el;
  while (node && node !== root.parentElement) {
    segments.unshift(describeElementTag(node));
    if (node === root) {
      break;
    }
    node = node.parentElement;
  }
  return segments.join(" > ");
}

function describeElementTag(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes =
    typeof el.className === "string" && el.className.trim().length > 0
      ? "." + el.className.trim().split(/\s+/).join(".")
      : "";
  const nth = nthChildIndex(el);
  const nthPart = nth !== null ? `:nth-child(${nth})` : "";
  return `${tag}${id}${classes}${nthPart}`;
}

function nthChildIndex(el: Element): number | null {
  const parent = el.parentElement;
  if (!parent) {
    return null;
  }
  let index = 1;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === el) {
      return index;
    }
    index++;
  }
  return null;
}

/**
 * Compute the list of computed-style properties whose value differs from a
 * bare element of the same tag placed in the same document. This keeps the
 * output to the interesting (element-specific) styles rather than all ~350
 * inherited/default properties per node.
 */
export function diffComputedStyles(
  el: Element,
  probeCache: Map<string, Record<string, string>>,
  probeHost: HTMLElement
): Array<{ prop: string; value: string }> {
  const computed = getComputedStyle(el);
  const tag = el.tagName.toLowerCase();
  const defaults = getTagDefaults(tag, probeCache, probeHost);

  const out: Array<{ prop: string; value: string }> = [];
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i];
    const value = computed.getPropertyValue(prop);
    if (value !== defaults[prop]) {
      out.push({ prop, value });
    }
  }
  return out;
}

/** A detached-but-attached offscreen host so probe elements get resolved styles. */
function createProbeHost(): HTMLElement {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "-99999px";
  host.style.top = "0";
  host.style.width = "0";
  host.style.height = "0";
  host.style.overflow = "hidden";
  host.style.visibility = "hidden";
  document.body.appendChild(host);
  return host;
}

function getTagDefaults(
  tag: string,
  cache: Map<string, Record<string, string>>,
  host: HTMLElement
): Record<string, string> {
  const cached = cache.get(tag);
  if (cached) {
    return cached;
  }
  const probe = document.createElement(tag);
  host.appendChild(probe);
  const computed = getComputedStyle(probe);
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i];
    snapshot[prop] = computed.getPropertyValue(prop);
  }
  host.removeChild(probe);
  cache.set(tag, snapshot);
  return snapshot;
}

/**
 * Collect the author CSS rules that match an element, in stylesheet source
 * order. Cross-origin sheets throw on `.cssRules` and are skipped (recorded in
 * the stylesheet inventory). Grouping rules (@media / @supports) are recursed
 * into and annotated with their condition.
 */
export function getMatchedAuthorRules(el: Element): string[] {
  const out: string[] = [];
  for (let i = 0; i < document.styleSheets.length; i++) {
    let rules: CSSRuleList | undefined;
    try {
      rules = document.styleSheets[i].cssRules;
    } catch {
      continue; // cross-origin — noted in inventory
    }
    if (!rules) {
      continue;
    }
    collectMatchingRules(rules, el, out, undefined);
    if (out.length >= MAX_MATCHED_RULES_PER_ELEMENT) {
      out.push("/* …additional matched rules truncated… */");
      break;
    }
  }
  return out;
}

function collectMatchingRules(
  rules: CSSRuleList,
  el: Element,
  out: string[],
  condition: string | undefined
): void {
  for (let i = 0; i < rules.length; i++) {
    if (out.length >= MAX_MATCHED_RULES_PER_ELEMENT) {
      return;
    }
    const rule = rules[i];
    if (isStyleRule(rule)) {
      if (elementMatches(el, rule.selectorText)) {
        const prefix = condition ? `${condition} ` : "";
        out.push(
          `${prefix}${rule.selectorText} { ${truncate(collapseWhitespace(rule.style.cssText), MAX_DECLARATION_LENGTH)} }`
        );
      }
    } else if (isGroupingRule(rule)) {
      const cond = groupingRuleCondition(rule);
      collectMatchingRules(rule.cssRules, el, out, cond);
    }
  }
}

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return typeof (rule as CSSStyleRule).selectorText === "string";
}

function isGroupingRule(rule: CSSRule): rule is CSSGroupingRule {
  return (
    typeof (rule as CSSGroupingRule).cssRules === "object" &&
    (rule as CSSGroupingRule).cssRules !== null &&
    !isStyleRule(rule)
  );
}

function groupingRuleCondition(rule: CSSGroupingRule): string {
  const media = (rule as CSSMediaRule).media;
  if (media && typeof media.mediaText === "string" && media.mediaText) {
    return `@media (${media.mediaText})`;
  }
  const conditionText = (rule as CSSSupportsRule).conditionText;
  if (typeof conditionText === "string" && conditionText) {
    return `@supports (${conditionText})`;
  }
  return "@group";
}

/** `el.matches` throws on selectors jsdom/older browsers can't parse — guard it. */
export function elementMatches(el: Element, selectorText: string): boolean {
  if (!selectorText) {
    return false;
  }
  // A selector list may contain individual selectors the engine rejects
  // (e.g. vendor pseudo-elements). Test each part independently so one bad
  // fragment doesn't discard a whole matching rule.
  for (const part of selectorText.split(",")) {
    const selector = part.trim();
    if (!selector) {
      continue;
    }
    try {
      if (el.matches(selector)) {
        return true;
      }
    } catch {
      // Unsupported selector fragment — skip it.
    }
  }
  return false;
}

// ============================================================================
// Helpers
// ============================================================================

function getCssVar(name: string): string {
  try {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  } catch {
    return "";
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}
