import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CustomWordSet,
  SpellCheckService,
  type TypoChecker,
} from "@utils/spellChecker";

class FakeTypo implements TypoChecker {
  static instances = 0;
  constructor() {
    FakeTypo.instances++;
  }
  check = (word: string) => word === "hello";
  suggest = (word: string) => (word === "helo" ? ["hello"] : []);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("CustomWordSet", () => {
  it("matches a lowercase word in any capitalization", () => {
    const words = new CustomWordSet(["ctrlyoke"]);
    expect(words.has("ctrlyoke")).toBe(true);
    expect(words.has("Ctrlyoke")).toBe(true);
    expect(words.has("CTRLYOKE")).toBe(true);
  });

  it("matches a word with a capital letter only exactly", () => {
    const words = new CustomWordSet(["GitHub"]);
    expect(words.has("GitHub")).toBe(true);
    expect(words.has("github")).toBe(false);
    expect(words.has("Github")).toBe(false);
  });
});

describe("SpellCheckService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeTypo.instances = 0;
  });

  function stubDictionaryLoad() {
    const fetchMock = vi.fn(async () => new Response("dictionary"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Typo", FakeTypo);
    return fetchMock;
  }

  it("loads the dictionary once however many editors ask for it", async () => {
    const fetchMock = stubDictionaryLoad();
    const service = new SpellCheckService();
    const listener = vi.fn();
    service.subscribe(listener);

    service.ensureLoaded("a.aff", "a.dic");
    service.ensureLoaded("a.aff", "a.dic");
    await vi.waitFor(() => expect(service.isReady()).toBe(true));
    service.ensureLoaded("a.aff", "a.dic");
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeTypo.instances).toBe(1);
    expect(service.isReady()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.check("hello")).toBe(true);
    expect(service.check("helo")).toBe(false);
    expect(service.suggest("helo")).toEqual(["hello"]);
  });

  it("accepts everything until the dictionary has loaded", () => {
    const service = new SpellCheckService();
    expect(service.isReady()).toBe(false);
    expect(service.check("helo")).toBe(true);
  });

  it("accepts custom words and a locally added word before settings echo it", async () => {
    stubDictionaryLoad();
    const service = new SpellCheckService();
    service.ensureLoaded("a.aff", "a.dic");
    await vi.waitFor(() => expect(service.isReady()).toBe(true));
    const listener = vi.fn();
    service.subscribe(listener);

    service.setCustomWords(["ctrlyoke"]);
    expect(service.check("Ctrlyoke")).toBe(true);

    service.addWordLocally("frobnicate");
    expect(service.check("frobnicate")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);

    // An unrelated settings update that has not caught up yet keeps it.
    service.setCustomWords(["ctrlyoke", "other"]);
    expect(service.check("frobnicate")).toBe(true);

    // Once the saved list contains it, removing it from settings sticks.
    service.setCustomWords(["ctrlyoke", "frobnicate"]);
    service.setCustomWords(["ctrlyoke"]);
    expect(service.check("frobnicate")).toBe(false);
  });

  it("does not notify when the same custom words are set again", () => {
    const service = new SpellCheckService();
    service.setCustomWords(["ctrlyoke"]);
    const listener = vi.fn();
    service.subscribe(listener);
    service.setCustomWords(["ctrlyoke"]);
    expect(listener).not.toHaveBeenCalled();
  });
});
