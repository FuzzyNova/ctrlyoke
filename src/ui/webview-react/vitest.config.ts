import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Mirror the aliases from vite.config.ts exactly so tests resolve the same
// modules as the production build.
const aliases = {
  "@": path.resolve(__dirname),
  "@components": path.resolve(__dirname, "components"),
  "@hooks": path.resolve(__dirname, "hooks"),
  "@store": path.resolve(__dirname, "store"),
  "@utils": path.resolve(__dirname, "utils"),
  "@types": path.resolve(__dirname, "types"),
  "@root/types": path.resolve(__dirname, "../../types"),
  "@root/utils": path.resolve(__dirname, "../../utils"),
  "@root/completions": path.resolve(__dirname, "../../completions"),
  "@icons": path.resolve(__dirname, "../icons"),
};

export default defineConfig({
  plugins: [react()],

  resolve: { alias: aliases },

  test: {
    root: __dirname,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    alias: aliases,

    // globals: true required so @testing-library/jest-dom can call expect.extend()
    // in the setup file.  Test files still use explicit vitest imports.
    globals: true,

    // Vitest's 5s default is too tight for this suite. The heavy jsdom
    // component tests (WorkflowPropertiesPanel, the output pane) legitimately
    // cost several hundred ms each in isolation, and running 200+ files across
    // every core inflates any single test several-fold when the pool is
    // oversubscribed — one WorkflowPropertiesPanel case measured 719ms alone,
    // 1.4s within its own file, and 5.1s under the full suite, where it
    // intermittently tripped the 5s limit and failed a run that had nothing
    // wrong with it. These are wall-clock budgets for catching a genuine hang,
    // not assertions about performance, so give them enough headroom to
    // survive load; a real hang still fails, just later.
    testTimeout: 20000,
    hookTimeout: 20000,

    include: ["./test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["store/**", "hooks/**", "utils/**", "components/**"],
      exclude: ["test/**", "types/**"],
      // json-summary powers dev/backlog/TESTING_GAPS.md (scripts/generate-testing-gaps.mjs).
      reporter: ["text", "html", "clover", "json", "json-summary"],
    },
  },
});
