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
// Tailwind 4 is configured in CSS: the plugin compiles this entry stylesheet.
const TAILWIND_CSS_CONFIG = resolve(
  __dirname,
  "src/ui/webview-react/styles/globals.css"
);
const jsxA11yRecommendedRules = Object.fromEntries(
  Object.entries(jsxA11y.configs.recommended.rules).map(([key, config]) => {
    const severity = Array.isArray(config) ? config[0] : config;
    return [key, severity === "off" ? "off" : "error"];
  })
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
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='updateStatusMessage']",
          message:
            "Use StatusMessageReporter.report() instead of calling updateStatusMessage() directly.",
        },
      ],
      semi: "warn",
    },
  },
  // no-console ratchet: application code routes all logging through Log.ts /
  // WebviewLog.ts (level, redaction, and file output stay centralized there —
  // see dev/implemented/LOG_CLEANUP_PLAN.md). console.* is only legitimate in
  // code that has no access to either logger.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-console": "error",
    },
  },
  // Exemptions: standalone processes with no Log/WebviewLog access (the CLI's
  // console output is intentional user-facing terminal output, not logging),
  // modules shared with those processes that can't assume either logger is
  // available, the loggers' own bootstrap/fallback paths, and tests.
  {
    files: [
      "src/cli.ts",
      "src/cli/**/*.{ts,tsx}",
      "src/mcp-server.ts",
      "src/config/**/*.{ts,tsx}",
      "src/core/orchestration/WorkflowLineageRepository.ts",
      "src/utils/FileLockUtils.ts",
      "src/utils/FileReferenceParser.ts",
      "src/utils/Log.ts",
      "src/ui/webview-react/utils/logger.ts",
      "src/ui/webview-react/hooks/useVsCodeApi.ts",
      "src/ui/webview-react/scripts/bootstrapScript.ts",
      "src/ui/webview-react/scripts/moduleLoaderScript.ts",
      "src/test/**/*.{ts,tsx}",
      "src/ui/webview-react/test/**/*.{ts,tsx}",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
    ],
    rules: {
      "no-console": "off",
    },
  },
  // Direct status-message calls are restricted to the reporter, transport
  // implementations, and the replay path that forwards already-persisted rows.
  {
    files: [
      "src/core/orchestration/StatusMessageReporter.ts",
      "src/core/WorkflowTaggedSink.ts",
      "src/ui/DashboardBroadcastHub.ts",
      "src/ui/PostMessageDashboardSink.ts",
      "src/ui/CtrlYokeWebviewProvider.ts",
      "src/server/CtrlYokeHostedServer.ts",
      "src/core/OutputCaptureBuffer.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
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
      // All enabled recommended rules are clean after the accessibility phases,
      // so keep them as errors. Rules that the plugin itself disables remain off.
      ...jsxA11yRecommendedRules,
      // Allow autoFocus for form inputs in controlled UI flows
      "jsx-a11y/no-autofocus": "off",
      // label-has-for is deprecated (replaced by label-has-associated-control).
      // It was accidentally enabled by the rule-mapping above; turn it off explicitly.
      "jsx-a11y/label-has-for": "off",
      // Restore control-has-associated-label with the recommended options so that
      // standard form elements (<input>, <textarea>, etc.) are not flagged when they
      // are already associated with a <label> via htmlFor/id.
      "jsx-a11y/control-has-associated-label": [
        "error",
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
  // All codicons in React markup must go through Icon so decorative glyphs
  // stay hidden from the accessibility tree and their class shape is shared.
  {
    files: ["src/ui/webview-react/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.name=/^(i|span)$/] > JSXAttribute[name.name='className'][value.type='Literal'][value.value=/codicon/]",
          message:
            "Use components/shared/Icon.tsx instead of raw codicon JSX elements.",
        },
        {
          selector:
            "JSXOpeningElement[name.name=/^(i|span)$/] > JSXAttribute[name.name='className'] JSXExpressionContainer TemplateLiteral TemplateElement[value.raw=/codicon/]",
          message:
            "Use components/shared/Icon.tsx instead of raw codicon JSX elements.",
        },
        {
          selector:
            "JSXOpeningElement[name.name=/^(i|span)$/] > JSXAttribute[name.name='className'] JSXExpressionContainer > Literal[value=/codicon/]",
          message:
            "Use components/shared/Icon.tsx instead of raw codicon JSX elements.",
        },
      ],
    },
  },
  // Icon is the one intentional raw codicon primitive.
  {
    files: ["src/ui/webview-react/components/shared/Icon.tsx"],
    rules: {
      "no-restricted-syntax": "off",
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
  // `recommended` is a single flat config; re-scope it, then override below.
  {
    ...tailwindcss.configs.recommended,
    files: ["src/ui/webview-react/**/*.{ts,tsx}"],
  },
  {
    files: ["src/ui/webview-react/**/*.{ts,tsx}"],
    settings: {
      tailwindcss: { cssConfigPath: TAILWIND_CSS_CONFIG },
    },
    rules: {
      // classnames-order: off — ordering churn with no prettier-plugin-tailwindcss
      // to keep it fixed on save.
      "tailwindcss/classnames-order": "off",
      // no-custom-classname: off — `cy-*` component classes, codicons, and
      // structural marker classes are not Tailwind utilities by design.
      "tailwindcss/no-custom-classname": "off",
      // Keep v3 spellings (flex-shrink-0, bg-[var(--x)], !important prefix)
      // from creeping back in: both autofix to the Tailwind 4 form.
      "tailwindcss/enforces-canonical-classname": "error",
      "tailwindcss/important-modifier-suffix": "error",
      // Off for now: both rewrite working classes into equivalent shorter
      // ones (`w-4 h-4` → `size-4`, `w-[32px]` → `w-8`) across hundreds of
      // call sites — a style pass, not something Tailwind 4 requires.
      "tailwindcss/enforces-shorthand": "off",
      "tailwindcss/no-unnecessary-arbitrary-value": "off",
      // no-contradicting-classname: matches VS Code Tailwind IntelliSense cssConflict
      "tailwindcss/no-contradicting-classname": "warn",
    },
  },
  // Prettier config must be last to override other configs
  prettierConfig,
];
