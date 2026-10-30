/**
 * The prompt editor's spell checker, shared by every CodeMirror editor on the
 * page. The dictionary is fetched and parsed once per URI pair (Typo.js parses
 * the whole `.dic` eagerly, so a per-editor instance multiplied that cost by
 * the number of editors mounted), and the custom-word list lives here too, so
 * one "Add to dictionary" clears the squiggle in every open editor at once.
 */
import { WebviewLog } from "./logger";

// Typo.js is loaded as a global <script> (see `vite.config.ts`).
declare global {
  interface Window {
    Typo?: new (
      lang: string,
      aff: string,
      dic: string,
      options?: object
    ) => TypoChecker;
  }
}

export interface TypoChecker {
  check: (word: string) => boolean;
  suggest: (word: string) => string[];
}

const TYPO_LANGUAGE = "en_US";
/** Bounds the memoized `check` results; the cache is simply dropped when full. */
const CHECK_CACHE_LIMIT = 20_000;

/**
 * Custom words with the matching rules users expect from other editors' spell
 * checkers: a word saved in lowercase matches any capitalization, and a word
 * saved with a capital letter must match exactly.
 */
export class CustomWordSet {
  private readonly exact: ReadonlySet<string>;
  private readonly anyCase: ReadonlySet<string>;

  constructor(words: Iterable<string>) {
    const exact = new Set<string>();
    const anyCase = new Set<string>();
    for (const word of words) {
      exact.add(word);
      if (word === word.toLowerCase()) anyCase.add(word);
    }
    this.exact = exact;
    this.anyCase = anyCase;
  }

  has(word: string): boolean {
    return this.exact.has(word) || this.anyCase.has(word.toLowerCase());
  }
}

type SpellCheckListener = () => void;

export class SpellCheckService {
  private checker: TypoChecker | null = null;
  private loadedKey: string | null = null;
  private loadingKey: string | null = null;
  private checkCache = new Map<string, boolean>();
  private configuredWords: readonly string[] = [];
  /** Words added from a quick fix whose settings round trip has not landed yet. */
  private readonly pendingWords = new Set<string>();
  private customWords = new CustomWordSet([]);
  private readonly listeners = new Set<SpellCheckListener>();

  /** Start loading the dictionary; later calls for the same files are free. */
  ensureLoaded(affUri: string, dicUri: string): void {
    const key = `${affUri}\n${dicUri}`;
    if (this.loadedKey === key || this.loadingKey === key) return;
    this.loadingKey = key;
    void this.load(key, affUri, dicUri);
  }

  private async load(
    key: string,
    affUri: string,
    dicUri: string
  ): Promise<void> {
    try {
      const [affData, dicData] = await Promise.all([
        fetch(affUri).then((r) => r.text()),
        fetch(dicUri).then((r) => r.text()),
      ]);
      // A newer request for other files supersedes this one.
      if (this.loadingKey !== key || !window.Typo) return;
      this.checker = new window.Typo(TYPO_LANGUAGE, affData, dicData, {
        platform: "any",
      });
      this.checkCache = new Map();
      this.loadedKey = key;
      this.notify();
    } catch (error) {
      WebviewLog.error(
        `[SpellCheck] Failed to load Typo.js dictionaries: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (this.loadingKey === key) this.loadingKey = null;
    }
  }

  isReady(): boolean {
    return this.checker !== null;
  }

  /** Replace the configured custom words (the merged `spelling.words`). */
  setCustomWords(words: readonly string[]): void {
    if (
      words.length === this.configuredWords.length &&
      words.every((word, index) => word === this.configuredWords[index])
    ) {
      return;
    }
    this.configuredWords = [...words];
    for (const word of words) this.pendingWords.delete(word);
    this.rebuildCustomWords();
  }

  /**
   * Accept `word` right away, before the settings write it triggers comes
   * back, so the squiggle clears the moment the quick fix is chosen.
   */
  addWordLocally(word: string): void {
    if (this.configuredWords.includes(word) || this.pendingWords.has(word)) {
      return;
    }
    this.pendingWords.add(word);
    this.rebuildCustomWords();
  }

  isCustomWord(word: string): boolean {
    return this.customWords.has(word);
  }

  /** Whether `word` is spelled correctly. Always true until the dictionary loads. */
  check(word: string): boolean {
    if (this.customWords.has(word)) return true;
    if (!this.checker) return true;
    const cached = this.checkCache.get(word);
    if (cached !== undefined) return cached;
    const result = this.checker.check(word);
    if (this.checkCache.size >= CHECK_CACHE_LIMIT) this.checkCache.clear();
    this.checkCache.set(word, result);
    return result;
  }

  suggest(word: string): string[] {
    return this.checker?.suggest(word) ?? [];
  }

  /** Called when the dictionary loads or the custom words change. */
  subscribe(listener: SpellCheckListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private rebuildCustomWords(): void {
    this.customWords = new CustomWordSet([
      ...this.configuredWords,
      ...this.pendingWords,
    ]);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const spellChecker = new SpellCheckService();
