import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default [
  {
    ignores: ["src/ui/webview-react/static/typo.js"],
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
    },
  },
  // Prettier config must be last to override other configs
  prettierConfig,
];
