/**
 * UX Snapshot capture (dev-only)
 *
 * Serializes the live webview UI into a single self-describing Markdown document
 * sized so an agent can actually read and parse the whole thing:
 *   1. Header / context (viewport, theme, standalone vs webview, device metrics)
 *   2. Stylesheet inventory (readable + cross-origin-skipped sheets)
 *   3. Ambient rules — universal selectors (`*`, `::before`, …) listed once
 *   4. Styles — every unique author rule that matches somewhere, listed once
 *   5. Serialized DOM (pretty-printed outerHTML of the App root)
 *
 * Why this exists: Nathan often drives ctrlyoke from a phone (PWA / hosted
 * dashboard) where there are no browser dev tools to inspect the rendered DOM
 * and see which CSS applied. This is a pure, side-effect-free capture usable in
 * both the webview and the standalone browser client, and unit-testable in jsdom.
 *
 * Design for readability: a naive per-element dump is O(elements × properties)
 * and reaches tens of MB — far past any context window. Instead we exploit the
 * fact that for a Tailwind app the **class list is the provenance**: every
 * utility class is a real CSS rule. So the DOM carries each element's classes,
 * and each matched author rule is listed **once** in the Styles dictionary
 * rather than repeated on every element. Computed ("what actually painted")
 * values are intentionally omitted here — they mostly restate the classes and
 * dominate size; a focused per-element computed mode can be a later addition.
 *
 * Provenance note: true DevTools-grade provenance
 * (`CSS.getMatchedStylesForNode`) is unavailable in-page. Pairing an element's
 * classes (in the DOM) with the Styles dictionary is the closest in-page
 * approximation, and a very good one for a utility-class app.
 */

const MAX_ATTR_VALUE_LENGTH = 200;
const MAX_TEXT_LENGTH = 200;
const MAX_MATCHED_RULES_PER_ELEMENT = 40;
const MAX_DECLARATION_LENGTH = 600;
/** Bound the rule-collection DOM walk so a pathological tree can't hang capture. */
const MAX_DICTIONARY_WALK_ELEMENTS = 8000;
/**
 * Cap on element children serialized per parent. A live UI has huge repetitive
 * sibling runs (terminal span rows, table bodies, icon lists) that dominate the
 * DOM byte count without adding provenance. We keep a representative prefix and
 * note how many were elided.
 */
const MAX_CHILDREN_PER_ELEMENT = 12;
/** Global backstop on total serialized DOM nodes for very large/deep trees. */
const MAX_SERIALIZED_NODES = 8000;

/** Attributes stripped from the serialized DOM to cut noise. */
const NOISY_ATTRIBUTES = new Set(["data-reactroot"]);

/**
 * Attributes never truncated in the serialized DOM. The `class` list is the
 * primary provenance now (it maps each element to the Styles dictionary), so it
 * must be preserved in full even when long.
 */
const UNTRUNCATED_ATTRIBUTES = new Set(["class"]);

/**
 * Tailwind writes dozens of `--tw-*` custom properties on the universal
 * selector as plumbing. They are omitted from rule declarations — they are
 * almost never what a UX bug is about and they dominate file size.
 */
const TW_CUSTOM_PROP_PREFIX = "--tw-";

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
  sections.push(buildAmbientRulesSection());
  sections.push(buildStyleDictionarySection(rootEl));
  sections.push(buildSerializedDomSection(rootEl));

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
    "inside a webview/PWA.",
    "",
    "To read it: each element in the **Serialized DOM** carries its `class` list,",
    "and every author rule that matches somewhere is listed once in **Styles**.",
    "So to see why an element looks the way it does, take its classes from the DOM",
    "and look them up in Styles (for a Tailwind app the class *is* the rule).",
    "Universal rules are in **Ambient rules**. Computed 'what actually painted'",
    "values are omitted here to keep the file small enough to read whole.",
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
// Ambient rules (universal selectors, listed once)
// ============================================================================

/**
 * Collect the author rules whose selectors match every element (`*`,
 * `::before`, `::after`, …), deduped across stylesheets and with `--tw-*`
 * plumbing stripped. These are emitted once instead of on every element.
 */
export function collectAmbientRules(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const walk = (rules: CSSRuleList, condition: string | undefined): void => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (isStyleRule(rule)) {
        if (!isUniversalRule(rule.selectorText)) {
          continue;
        }
        const formatted = formatStyleRule(rule, condition);
        if (!seen.has(formatted)) {
          seen.add(formatted);
          out.push(formatted);
        }
      } else if (isGroupingRule(rule)) {
        walk(rule.cssRules, groupingRuleCondition(rule));
      }
    }
  };

  for (let i = 0; i < document.styleSheets.length; i++) {
    let rules: CSSRuleList | undefined;
    try {
      rules = document.styleSheets[i].cssRules;
    } catch {
      continue; // cross-origin — noted in inventory
    }
    if (rules) {
      walk(rules, undefined);
    }
  }
  return out;
}

function buildAmbientRulesSection(): string {
  const rules = collectAmbientRules();
  const lines: string[] = [
    "## Ambient rules (match all elements)",
    "",
    "Universal rules (`*`, `::before`, `::after`, …) apply to every element, so",
    "they are listed once here. Tailwind `--tw-*` custom-property declarations",
    "are omitted as plumbing.",
    "",
  ];
  if (rules.length === 0) {
    lines.push("_None._");
    return lines.join("\n");
  }
  lines.push("```css");
  for (const rule of rules) {
    lines.push(rule);
  }
  lines.push("```");
  return lines.join("\n");
}

// ============================================================================
// Styles dictionary (every unique matched rule, listed once)
// ============================================================================

/**
 * Walk the tree and collect every non-universal author rule that matches at
 * least one element, deduped. This replaces per-element matched-rule blocks:
 * because each element's classes are in the DOM, an agent can map element →
 * classes → these rules without the O(elements × rules) repetition.
 */
export function collectMatchedRuleDictionary(rootEl: HTMLElement): {
  rules: string[];
  truncated: boolean;
} {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
  let current: Node | null = rootEl;
  let count = 0;
  let truncated = false;

  while (current) {
    if (count >= MAX_DICTIONARY_WALK_ELEMENTS) {
      truncated = true;
      break;
    }
    count++;
    for (const rule of collectMatchedRuleStrings(current as Element)) {
      if (!seen.has(rule)) {
        seen.add(rule);
        ordered.push(rule);
      }
    }
    current = walker.nextNode();
  }
  return { rules: ordered, truncated };
}

function buildStyleDictionarySection(rootEl: HTMLElement): string {
  const { rules, truncated } = collectMatchedRuleDictionary(rootEl);
  const lines: string[] = [
    "## Styles (unique matched rules)",
    "",
    "Every author rule that matches at least one element in the tree, listed",
    "once (deduplicated). Map an element to its styles via the class names in",
    "the **Serialized DOM** below — the classes are the provenance, so",
    "per-element rule lists are not repeated. `--tw-*` plumbing is omitted.",
    "Pseudo-element rules (`::before`/`::after` generated `content`, e.g. icon",
    "glyphs) are included and attributed to their origin element's classes.",
    "",
  ];
  if (rules.length === 0) {
    lines.push("_None._");
    return lines.join("\n");
  }
  lines.push("```css");
  for (const rule of rules) {
    lines.push(rule);
  }
  lines.push("```");
  if (truncated) {
    lines.push(
      "",
      `_Rule collection stopped after ${MAX_DICTIONARY_WALK_ELEMENTS} elements; some rules on deeper elements may be missing._`
    );
  }
  return lines.join("\n");
}

/** All matched, non-universal, formatted rules for one element (no cap). */
function collectMatchedRuleStrings(el: Element): string[] {
  const out: string[] = [];
  for (let i = 0; i < document.styleSheets.length; i++) {
    let rules: CSSRuleList | undefined;
    try {
      rules = document.styleSheets[i].cssRules;
    } catch {
      continue; // cross-origin — noted in inventory
    }
    if (rules) {
      collectMatchingRules(rules, el, out, undefined, null);
    }
  }
  return out;
}

/**
 * Collect the author rules that match an element, in stylesheet source order,
 * capped at `MAX_MATCHED_RULES_PER_ELEMENT`. Retained as a standalone utility
 * (and for tests); the snapshot itself uses the deduped dictionary instead.
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
    collectMatchingRules(rules, el, out, undefined, MAX_MATCHED_RULES_PER_ELEMENT);
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
  condition: string | undefined,
  cap: number | null
): void {
  for (let i = 0; i < rules.length; i++) {
    if (cap !== null && out.length >= cap) {
      return;
    }
    const rule = rules[i];
    if (isStyleRule(rule)) {
      // Universal rules are hoisted into the Ambient section and listed once,
      // so skip them here to avoid repeating them on every element.
      if (isUniversalRule(rule.selectorText)) {
        continue;
      }
      if (elementMatches(el, rule.selectorText)) {
        out.push(formatStyleRule(rule, condition));
      }
    } else if (isGroupingRule(rule)) {
      const cond = groupingRuleCondition(rule);
      collectMatchingRules(rule.cssRules, el, out, cond, cap);
    }
  }
}

/**
 * A rule is "universal" (ambient) when every one of its selector fragments
 * matches all elements — `*`, `::before`, `::after`, `*::before`, etc. Such
 * rules (Tailwind preflight, resets) are listed once in the Ambient section
 * rather than repeated on every element.
 */
export function isUniversalRule(selectorText: string): boolean {
  if (!selectorText) {
    return false;
  }
  const fragments = selectorText
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (fragments.length === 0) {
    return false;
  }
  return fragments.every(
    (frag) => frag === "*" || /^\*?::[a-z-]+$/.test(frag)
  );
}

/** Format a style rule, filtering `--tw-*` plumbing from its declarations. */
function formatStyleRule(rule: CSSStyleRule, condition: string | undefined): string {
  const prefix = condition ? `${condition} ` : "";
  return `${prefix}${rule.selectorText} { ${formatDeclarations(rule.style)} }`;
}

/**
 * Build a declaration string from a rule's style, dropping `--tw-*` custom
 * properties and noting how many were omitted.
 */
function formatDeclarations(style: CSSStyleDeclaration): string {
  const parts: string[] = [];
  let omittedTw = 0;
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    if (prop.startsWith(TW_CUSTOM_PROP_PREFIX)) {
      omittedTw++;
      continue;
    }
    parts.push(`${prop}: ${style.getPropertyValue(prop)};`);
  }
  let out = parts.join(" ");
  if (omittedTw > 0) {
    out += `${parts.length > 0 ? " " : ""}/* +${omittedTw} --tw-* vars omitted */`;
  }
  return truncate(collapseWhitespace(out), MAX_DECLARATION_LENGTH);
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

/**
 * Strip trailing pseudo-elements from a selector fragment so it can be tested
 * against an origin element. A rule like `.codicon-add::before { content }`
 * targets a pseudo-element, and `el.matches('.codicon-add::before')` throws —
 * but the rule *does* apply to elements matching `.codicon-add`, so we test the
 * origin (`.codicon-add`) while keeping the full selector (with `::before`) in
 * the output. This is what surfaces icon glyphs, badges, tooltip arrows, and
 * other generated `content` — all of which are real UI-bug surfaces.
 *
 * Pseudo-CLASSES (`:hover`, `:focus`, …) are deliberately left intact: they are
 * state-dependent, so `el.matches('.btn:hover')` correctly reflects whether the
 * rule applies to the current (static) snapshot rather than over-matching.
 */
export function stripPseudoElements(selector: string): string {
  return selector
    .replace(/::[-a-zA-Z]+(\([^)]*\))?/g, "")
    .replace(/:(?:before|after|first-line|first-letter)\b/gi, "")
    .trim();
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
    const selector = stripPseudoElements(part.trim());
    if (!selector) {
      // Pure pseudo-element fragment (e.g. `::before`) — universal, handled
      // by isUniversalRule / the Ambient section, not here.
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
// Serialized DOM
// ============================================================================

function buildSerializedDomSection(rootEl: HTMLElement): string {
  return [
    "## Serialized DOM",
    "",
    `Repetitive sibling runs are truncated to the first ${MAX_CHILDREN_PER_ELEMENT}`,
    "children per parent (with an elision note) to keep the tree readable.",
    "",
    "```html",
    serializeElement(rootEl, 0),
    "```",
  ].join("\n");
}

interface SerializeBudget {
  /** Remaining node budget shared across the whole serialization. */
  remaining: number;
}

/** Recursively serialize an element into indented, noise-stripped HTML. */
export function serializeElement(el: Element, depth: number): string {
  return serializeNode(el, depth, { remaining: MAX_SERIALIZED_NODES });
}

function serializeNode(
  el: Element,
  depth: number,
  budget: SerializeBudget
): string {
  const indent = "  ".repeat(depth);
  const tag = el.tagName.toLowerCase();
  const attrs = serializeAttributes(el);
  const open = `${indent}<${tag}${attrs}>`;

  // <script>/<style> bodies are noise — collapse them.
  if (tag === "script" || tag === "style") {
    return `${open}…</${tag}>`;
  }

  const childIndent = "  ".repeat(depth + 1);
  const childParts: string[] = [];
  let serializedElementChildren = 0;
  let elidedElementChildren = 0;
  let firstElidedTag: string | undefined;

  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // Per-parent cap: keep a representative prefix, count the rest.
      if (serializedElementChildren >= MAX_CHILDREN_PER_ELEMENT) {
        elidedElementChildren++;
        firstElidedTag ??= (node as Element).tagName.toLowerCase();
        continue;
      }
      // Global backstop: stop serializing new nodes once the budget is spent.
      if (budget.remaining <= 0) {
        elidedElementChildren++;
        firstElidedTag ??= (node as Element).tagName.toLowerCase();
        continue;
      }
      budget.remaining--;
      childParts.push(serializeNode(node as Element, depth + 1, budget));
      serializedElementChildren++;
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").trim();
      if (text.length > 0) {
        childParts.push(`${childIndent}${truncate(text, MAX_TEXT_LENGTH)}`);
      }
    }
  }

  if (elidedElementChildren > 0) {
    const tagHint = firstElidedTag ? ` <${firstElidedTag}>` : "";
    childParts.push(
      `${childIndent}<!-- ${elidedElementChildren} more${tagHint} child element(s) elided -->`
    );
  }

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
    const value = UNTRUNCATED_ATTRIBUTES.has(attr.name)
      ? attr.value
      : truncate(attr.value, MAX_ATTR_VALUE_LENGTH);
    parts.push(`${attr.name}="${escapeAttr(value)}"`);
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

// ============================================================================
// Element description helpers
// ============================================================================

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
