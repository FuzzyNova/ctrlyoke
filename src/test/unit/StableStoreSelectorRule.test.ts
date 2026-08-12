import * as path from "path";
import { pathToFileURL } from "url";
import { RuleTester, type Linter, type Rule } from "eslint";
import { suite, test } from "mocha";

// `@typescript-eslint/parser` publishes only an `exports` map, which this
// project's `node` module resolution cannot follow through a static import.
const tsParser = require("@typescript-eslint/parser") as Linter.Parser;

/**
 * Contract tests for the local ESLint rule `ctrlyoke/stable-store-selector`
 * (`scripts/eslint-rules/`), which forbids zustand selectors that allocate a new
 * object/array on every read — the defect behind React #185 crashes that no
 * component test can see, because component tests mock the hook holding the
 * selector.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../");

interface LocalEslintPlugin {
  rules: Record<string, Rule.RuleModule>;
}

/**
 * The rule is an ES module and this suite compiles to CommonJS, where tsc would
 * rewrite a literal `import()` into `require()` and fail on the `.mjs` file.
 * Constructing the import keeps it a genuine dynamic import at runtime.
 */
const importEsm = new Function("specifier", "return import(specifier);") as (
  specifier: string
) => Promise<{ default: LocalEslintPlugin }>;

async function loadRule(): Promise<Rule.RuleModule> {
  const plugin = await importEsm(
    pathToFileURL(path.join(REPO_ROOT, "scripts/eslint-rules/index.mjs")).href
  );
  return plugin.default.rules["stable-store-selector"];
}

// Parse with the same parser the real config uses, so TS-only syntax
// (annotations, `as` casts) is judged exactly as it is in `src/`.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

function unstable(code: string): {
  code: string;
  errors: { messageId: string }[];
} {
  return { code, errors: [{ messageId: "unstableSelector" }] };
}

suite("ESLint rule: stable-store-selector", () => {
  test("flags allocating selectors and accepts stable ones", async () => {
    const rule = await loadRule();

    ruleTester.run("stable-store-selector", rule, {
      valid: [
        // Stored references and primitives are the whole point of the rule.
        "const a = useUiStore((s) => s.value);",
        "const a = useUiStore((s: State) => s.nested.value);",
        "const a = useUiStore((s) => s.items.find((i) => i.on));",
        "const a = useUiStore((s) => s.list.length > 0);",
        "const a = useUiStore((s) => `${s.name} run`);",
        // A module-level constant fallback is the correct empty-value pattern.
        "const a = useUiStore((s) => s.list ?? EMPTY_LIST);",
        "const a = useUiStore((s) => s.tabs[id] ?? 'output');",
        // Sanctioned escape hatch: an equality function re-stabilizes the read.
        "const a = useUiStore(useShallow((s) => ({ x: s.x })));",
        "const a = useStore(store, (s) => ({ x: s.x }), shallow);",
        // Whole-store reads and non-selector calls are untouched.
        "const a = useUiStore();",
        "const a = useUiStore.getState().update({ x: 1 });",
        "useUiStore.setState({ x: 1 });",
        // React's own hook matches the naming pattern but takes no selector.
        "const a = useSyncExternalStore(subscribe, () => ({ x: 1 }));",
        // A callback inside the selector returns for itself, not the selector.
        "const a = useUiStore((s) => s.items.every((i) => ({ x: i }).x));",
      ],
      invalid: [
        unstable("const a = useUiStore((s) => ({ x: s.x, y: s.y }));"),
        unstable("const a = useUiStore((s) => [s.x, s.y]);"),
        // Conditional selectors only loop once the allocating branch is taken —
        // this is the shape that shipped as a live crash.
        unstable(
          "const a = useUiStore((s) => s.kind === 'run' ? { ref: s.ref } : null);"
        ),
        unstable("const a = useUiStore((s) => s.list ?? []);"),
        unstable("const a = useUiStore((s) => s.items.filter((i) => i.on));"),
        unstable("const a = useUiStore((s) => s.items.map((i) => i.id));"),
        unstable("const a = useUiStore((s) => Object.keys(s.map));"),
        unstable("const a = useUiStore((s) => new Set(s.ids));"),
        unstable("const a = useUiStore((s) => ({ x: s.x }) as Selected);"),
        unstable(
          "const a = useUiStore((s) => { const hit = s.items[0]; return { hit }; });"
        ),
        unstable("const a = useWorkflowTemporalStore((s) => ({ n: s.n }));"),
        unstable("const a = useStore(store, (s) => ({ x: s.x }));"),
      ],
    });
  });
});
