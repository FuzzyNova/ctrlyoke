import { describe, it, expect, afterEach } from "vitest";
import {
  captureUxSnapshot,
  buildHeaderSection,
  collectAmbientRules,
  collectMatchedRuleDictionary,
  collectStylesheetInfo,
  elementMatches,
  getMatchedAuthorRules,
  isUniversalRule,
  serializeElement,
  stripPseudoElements,
} from "@utils/uxSnapshot";

/** Track nodes appended to <head>/<body> so each test cleans up after itself. */
const appended: Element[] = [];

function addStyle(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  appended.push(style);
  return style;
}

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  appended.push(host);
  return host;
}

afterEach(() => {
  while (appended.length > 0) {
    appended.pop()?.remove();
  }
});

describe("collectMatchedRuleDictionary", () => {
  it("lists a shared rule once across many elements that match it", () => {
    addStyle(".shared { color: red; } .only-b { display: flex; }");
    const root = mount(
      '<div id="root"><div class="shared"></div><div class="shared"></div><div class="shared only-b"></div></div>'
    ).firstElementChild as HTMLElement;

    const { rules, truncated } = collectMatchedRuleDictionary(root);
    expect(truncated).toBe(false);
    const sharedCount = rules.filter((r) => r.startsWith(".shared")).length;
    expect(sharedCount).toBe(1);
    // Rules that only match one element are still included, once.
    expect(rules.filter((r) => r.startsWith(".only-b")).length).toBe(1);
  });

  it("excludes universal rules (they live in Ambient)", () => {
    addStyle("* { box-sizing: border-box; } .scoped { color: red; }");
    const root = mount('<div id="root"><p class="scoped"></p></div>')
      .firstElementChild as HTMLElement;

    const { rules } = collectMatchedRuleDictionary(root);
    expect(rules.some((r) => r.startsWith("*"))).toBe(false);
    expect(rules.some((r) => r.startsWith(".scoped"))).toBe(true);
  });
});

describe("elementMatches", () => {
  it("returns true when any selector fragment matches", () => {
    const el = mount('<div class="foo"></div>')
      .firstElementChild as HTMLElement;
    expect(elementMatches(el, ".foo")).toBe(true);
    expect(elementMatches(el, ".bar, .foo")).toBe(true);
    expect(elementMatches(el, ".bar")).toBe(false);
  });

  it("ignores selector fragments the engine cannot parse", () => {
    const el = mount('<div class="foo"></div>')
      .firstElementChild as HTMLElement;
    // A bogus fragment must not throw or discard the valid one.
    expect(elementMatches(el, "::-webkit-bogus, .foo")).toBe(true);
    expect(elementMatches(el, "")).toBe(false);
  });

  it("matches pseudo-element rules against their origin element", () => {
    const el = mount('<span class="badge"></span>')
      .firstElementChild as HTMLElement;
    // `.badge::after` targets a pseudo-element but applies to `.badge` elements.
    expect(elementMatches(el, ".badge::after")).toBe(true);
    expect(elementMatches(el, ".badge::before")).toBe(true);
    expect(elementMatches(el, ".other::after")).toBe(false);
  });
});

describe("stripPseudoElements", () => {
  it("removes pseudo-elements but keeps the origin selector", () => {
    expect(stripPseudoElements(".codicon-add::before")).toBe(".codicon-add");
    expect(stripPseudoElements(".list li::marker")).toBe(".list li");
    expect(stripPseudoElements(".x::-webkit-scrollbar-thumb")).toBe(".x");
    expect(stripPseudoElements(".legacy:before")).toBe(".legacy");
  });

  it("leaves pseudo-classes intact (state-dependent)", () => {
    expect(stripPseudoElements(".btn:hover")).toBe(".btn:hover");
    expect(stripPseudoElements(".btn:hover::after")).toBe(".btn:hover");
  });

  it("reduces a pure pseudo-element to empty", () => {
    expect(stripPseudoElements("::before")).toBe("");
  });
});

describe("getMatchedAuthorRules", () => {
  it("collects author rules that match, with declarations", () => {
    addStyle(".matched { color: rgb(1, 2, 3); } .other { color: blue; }");
    const el = mount('<p class="matched"></p>')
      .firstElementChild as HTMLElement;

    const rules = getMatchedAuthorRules(el);
    expect(rules.some((r) => r.includes(".matched"))).toBe(true);
    expect(rules.some((r) => r.includes("color"))).toBe(true);
    expect(rules.some((r) => r.includes(".other"))).toBe(false);
  });

  it("captures ::before/::after content rules for the origin element", () => {
    addStyle('.badge::after { content: "!"; } .icon::before { content: "x"; }');
    const el = mount('<span class="badge"></span>')
      .firstElementChild as HTMLElement;

    const rules = getMatchedAuthorRules(el);
    expect(rules.some((r) => r.includes(".badge::after"))).toBe(true);
    // A pseudo rule for a class this element lacks must not be captured.
    expect(rules.some((r) => r.includes(".icon::before"))).toBe(false);
  });

  it("recurses into @media grouping rules and annotates the condition", () => {
    addStyle("@media (min-width: 1px) { .responsive { display: flex; } }");
    const el = mount('<div class="responsive"></div>')
      .firstElementChild as HTMLElement;

    const rules = getMatchedAuthorRules(el);
    expect(
      rules.some((r) => r.includes("@media") && r.includes(".responsive"))
    ).toBe(true);
  });
});

describe("isUniversalRule", () => {
  it("classifies bare universal and pseudo-element-only selectors", () => {
    expect(isUniversalRule("*")).toBe(true);
    expect(isUniversalRule("*, ::before, ::after")).toBe(true);
    expect(isUniversalRule("::before")).toBe(true);
    expect(isUniversalRule("*::after")).toBe(true);
  });

  it("does not classify element/class-scoped selectors as universal", () => {
    expect(isUniversalRule(".foo")).toBe(false);
    expect(isUniversalRule("html, body, #root")).toBe(false);
    expect(isUniversalRule("input::-webkit-inner-spin-button")).toBe(false);
    expect(isUniversalRule("")).toBe(false);
  });
});

describe("collectAmbientRules", () => {
  it("hoists universal rules once and strips --tw-* plumbing", () => {
    addStyle(
      "*, ::before, ::after { --tw-ring-color: red; box-sizing: border-box; } .scoped { color: red; }"
    );
    const ambient = collectAmbientRules();
    const universal = ambient.filter((r) =>
      r.startsWith("*, ::before, ::after")
    );
    expect(universal.length).toBe(1);
    expect(universal[0]).toContain("box-sizing: border-box");
    expect(universal[0]).not.toContain("--tw-ring-color");
    expect(universal[0]).toContain("--tw-* vars omitted");
    // Scoped rules are not ambient.
    expect(ambient.some((r) => r.includes(".scoped"))).toBe(false);
  });

  it("does not repeat a universal rule in per-element matched rules", () => {
    addStyle(
      "* { -webkit-tap-highlight-color: transparent; } .kept { color: red; }"
    );
    const el = mount('<div class="kept"></div>')
      .firstElementChild as HTMLElement;
    const matched = getMatchedAuthorRules(el);
    // The universal rule is hoisted, so it must not appear per element…
    expect(matched.some((r) => r.startsWith("* {"))).toBe(false);
    // …but the element-scoped rule still does.
    expect(matched.some((r) => r.includes(".kept"))).toBe(true);
  });
});

describe("collectStylesheetInfo", () => {
  it("reports readable inline stylesheets with rule counts", () => {
    addStyle(".x { color: red; } .y { color: blue; }");
    const sheets = collectStylesheetInfo();
    expect(sheets.length).toBeGreaterThan(0);
    const readable = sheets.filter((s) => s.readable);
    expect(readable.length).toBeGreaterThan(0);
    expect(readable.every((s) => typeof s.ruleCount === "number")).toBe(true);
  });
});

describe("serializeElement", () => {
  it("emits indented HTML and strips noisy attributes", () => {
    const root = mount(
      '<div data-reactroot="" class="wrap"><span>hi</span></div>'
    ).firstElementChild as HTMLElement;

    const html = serializeElement(root, 0);
    expect(html).toContain('<div class="wrap">');
    expect(html).not.toContain("data-reactroot");
    expect(html).toContain("<span>");
    expect(html).toContain("hi");
  });

  it("collapses <script> and <style> bodies", () => {
    const root = mount("<div><script>doStuff()</script></div>")
      .firstElementChild as HTMLElement;
    const html = serializeElement(root, 0);
    expect(html).not.toContain("doStuff()");
    expect(html).toContain("<script>");
  });

  it("truncates large repetitive sibling runs with an elision note", () => {
    const rows = Array.from(
      { length: 40 },
      (_, i) => `<span class="row">r${i}</span>`
    ).join("");
    const root = mount(`<div>${rows}</div>`).firstElementChild as HTMLElement;

    const html = serializeElement(root, 0);
    const serializedSpans = html.split('<span class="row">').length - 1;
    expect(serializedSpans).toBe(12); // MAX_CHILDREN_PER_ELEMENT
    expect(html).toContain("28 more <span> child element(s) elided");
  });
});

describe("buildHeaderSection", () => {
  it("includes viewport, mode and user agent context", () => {
    const root = mount('<div id="root"></div>')
      .firstElementChild as HTMLElement;
    const header = buildHeaderSection(root);
    expect(header).toContain("# UX Snapshot");
    expect(header).toContain("Window:");
    expect(header).toContain("User agent:");
    expect(header).toMatch(/Mode:.*(webview|standalone)/);
  });
});

describe("captureUxSnapshot", () => {
  it("produces a markdown document with all sections", () => {
    addStyle(".cap { color: red; }");
    const root = mount(
      '<div id="root"><div class="cap"><span>content</span></div></div>'
    ).firstElementChild as HTMLElement;

    const { markdown, png } = captureUxSnapshot(root);
    expect(png).toBeUndefined();
    expect(markdown).toContain("# UX Snapshot");
    expect(markdown).toContain("## Stylesheet inventory");
    expect(markdown).toContain("## Ambient rules (match all elements)");
    expect(markdown).toContain("## Styles (unique matched rules)");
    expect(markdown).toContain("## Serialized DOM");
    // Matched author rule for the mounted element should surface in Styles.
    expect(markdown).toContain(".cap");
  });

  it("lists universal rules once (ambient) rather than per element", () => {
    addStyle("* { box-sizing: border-box; }");
    const root = mount(
      '<div id="root"><div class="a"></div><div class="b"></div></div>'
    ).firstElementChild as HTMLElement;

    const { markdown } = captureUxSnapshot(root);
    const occurrences =
      markdown.split("* { box-sizing: border-box; }").length - 1;
    // Once in the Ambient section, never repeated across the 3 elements.
    expect(occurrences).toBe(1);
  });
});
