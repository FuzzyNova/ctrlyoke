import { describe, it, expect, afterEach } from "vitest";
import {
  captureUxSnapshot,
  buildElementPath,
  buildHeaderSection,
  collectStylesheetInfo,
  elementMatches,
  getMatchedAuthorRules,
  serializeElement,
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

describe("buildElementPath", () => {
  it("builds a path from the root down with tag, id, class and nth-child", () => {
    const root = mount(
      '<section id="root"><div class="a b"></div><div class="c"></div></section>'
    ).firstElementChild as HTMLElement;
    const target = root.querySelector(".c") as HTMLElement;

    const path = buildElementPath(target, root);
    expect(path).toContain("section#root");
    expect(path.endsWith("div.c:nth-child(2)")).toBe(true);
    expect(path).toContain(" > ");
  });

  it("stops at the provided root", () => {
    const outer = mount('<main><span id="inner"></span></main>')
      .firstElementChild as HTMLElement;
    const inner = outer.querySelector("#inner") as HTMLElement;

    const path = buildElementPath(inner, outer);
    expect(path.startsWith("main")).toBe(true);
    expect(path).toContain("span#inner");
  });
});

describe("elementMatches", () => {
  it("returns true when any selector fragment matches", () => {
    const el = mount('<div class="foo"></div>').firstElementChild as HTMLElement;
    expect(elementMatches(el, ".foo")).toBe(true);
    expect(elementMatches(el, ".bar, .foo")).toBe(true);
    expect(elementMatches(el, ".bar")).toBe(false);
  });

  it("ignores selector fragments the engine cannot parse", () => {
    const el = mount('<div class="foo"></div>').firstElementChild as HTMLElement;
    // A bogus fragment must not throw or discard the valid one.
    expect(elementMatches(el, "::-webkit-bogus, .foo")).toBe(true);
    expect(elementMatches(el, "")).toBe(false);
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

  it("recurses into @media grouping rules and annotates the condition", () => {
    addStyle("@media (min-width: 1px) { .responsive { display: flex; } }");
    const el = mount('<div class="responsive"></div>')
      .firstElementChild as HTMLElement;

    const rules = getMatchedAuthorRules(el);
    expect(rules.some((r) => r.includes("@media") && r.includes(".responsive"))).toBe(
      true
    );
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
    expect(markdown).toContain("## Serialized DOM");
    expect(markdown).toContain("## Per-element styles");
    // Matched author rule for the mounted element should surface.
    expect(markdown).toContain(".cap");
  });
});
