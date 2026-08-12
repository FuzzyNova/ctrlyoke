import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tailwindcss from "eslint-plugin-tailwindcss";
import ctrlyoke from "./scripts/eslint-rules/index.mjs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TAILWIND_CONFIG = resolve(
  __dirname,
  "src/ui/webview-react/tailwind.config.js"
);

export default [
  {
    ignores: [
      "src/ui/webview-react/static/typo.js",
      "src/ui/webview-react/coverage/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
  },
  {
    plugins: {
      "@typescript-eslint": typescriptEslint,
    },

    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },

    rules: {
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],

      curly: "warn",
      eqeqeq: ["warn", "always", { null: "ignore" }],
      "no-throw-literal": "warn",
      semi: "warn",
    },
  },
  // React hooks rules for TSX files
  {
    files: ["**/*.tsx"],
    plugins: {
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // jsx-a11y rules as warnings to match project lint style
      ...Object.fromEntries(
        Object.entries(jsxA11y.configs.recommended.rules).map(([key]) => [
          key,
          "warn",
        ])
      ),
      // Allow autoFocus for form inputs in controlled UI flows
      "jsx-a11y/no-autofocus": "off",
      // label-has-for is deprecated (replaced by label-has-associated-control).
      // It was accidentally enabled by the rule-mapping above; turn it off explicitly.
      "jsx-a11y/label-has-for": "off",
      // Restore control-has-associated-label with the recommended options so that
      // standard form elements (<input>, <textarea>, etc.) are not flagged when they
      // are already associated with a <label> via htmlFor/id.
      "jsx-a11y/control-has-associated-label": [
        "warn",
        {
          ignoreElements: [
            "audio",
            "canvas",
            "embed",
            "input",
            "textarea",
            "tr",
            "video",
          ],
          ignoreRoles: [
            "grid",
            "listbox",
            "menu",
            "menubar",
            "radiogroup",
            "row",
            "tablist",
            "toolbar",
            "tree",
            "treegrid",
          ],
          includeRoles: ["alert", "dialog"],
        },
      ],
    },
  },
  // Local rules. Scoped to webview-react: zustand stores live only there, and an
  // allocating selector there is a crash (React #185), not a style preference.
  {
    files: ["src/ui/webview-react/**/*.{ts,tsx}"],
    plugins: { ctrlyoke },
    rules: {
      "ctrlyoke/stable-store-selector": "error",
    },
  },
  // Tailwind CSS linting for webview-react files.
  // Scoped to webview-react (the only part of the codebase that uses Tailwind).
  // flat/recommended is an array [pluginEntry, rulesEntry] — spread both with
  // the file scope applied, then add settings + rule overrides in a third block.
  ...tailwindcss.configs["flat/recommended"].map((config) => ({
    ...config,
    files: ["src/ui/webview-react/**/*.{ts,tsx}"],
  })),
  {
    files: ["src/ui/webview-react/**/*.{ts,tsx}"],
    settings: {
      tailwindcss: { config: TAILWIND_CONFIG },
    },
    rules: {
      // classnames-order: off — no prettier-plugin-tailwindcss to auto-fix ordering.
      // Also uses context.getSourceCode() removed in ESLint v10.
      "tailwindcss/classnames-order": "off",
      // enforces-shorthand: off — also uses context.getSourceCode() (ESLint v10 incompatible)
      "tailwindcss/enforces-shorthand": "off",
      // migration-from-tailwind-2: off — already off in recommended, but explicit
      "tailwindcss/migration-from-tailwind-2": "off",
      // no-custom-classname: off — project has many custom VS Code theme tokens
      "tailwindcss/no-custom-classname": "off",
      // no-contradicting-classname: matches VS Code Tailwind IntelliSense cssConflict
      "tailwindcss/no-contradicting-classname": "warn",
    },
  },
  // Prettier config must be last to override other configs
  prettierConfig,
];
