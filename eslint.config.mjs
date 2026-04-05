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
  // Prettier config must be last to override other configs
  prettierConfig,
];
