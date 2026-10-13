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

/**
 * Vitest already runs test files in parallel; what it cannot know is that
 * `npm test` runs this suite *alongside* the extension-host suite, which is
 * itself several VS Code instances. Left at the default (a worker per core)
 * both suites would claim the whole machine and then fight over it, so
 * `scripts/run-test-suites.mjs` -- the one place that knows the whole core
 * budget -- hands this suite its share. Unset means "run this suite alone",
 * which is exactly right for `npm run test:ui`.
 */
const uiWorkers = Number.parseInt(
  process.env.CTRLYOKE_UI_TEST_WORKERS ?? "",
  10
);

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

    // Reuse each worker's jsdom window across the files it runs instead of
    // building a fresh environment per file, which cost more CPU than running
    // the tests themselves. test/setup.ts restores per-file isolation for what
    // matters (module registry, web storage, rendered DOM); a test that leaves
    // global state behind — a timer or rAF loop, a patched window property,
    // a flag it toggled on — must undo it in its own afterEach.
    isolate: false,

    // Vitest's 5s default is too tight for this suite. The heavy jsdom
    // component tests (WorkflowPropertiesPanel, the output pane) legitimately
    // cost several hundred ms each in isolation, and running 200+ files across
    // every core inflates any single test several-fold when the pool is
    // oversubscribed — one WorkflowPropertiesPanel case measured 719ms alone,
    // 1.4s within its own file, and 5.1s under the full suite, where it
    // intermittently tripped the 5s limit and failed a run that had nothing
    // wrong with it. A 2-vCPU GitHub runner is slower still: whole files there
    // ran 5-10x their local time, and tests that took 14-19s routinely
    // brushed a 20s limit. These are wall-clock budgets for catching a genuine
    // hang, not assertions about performance, so give them enough headroom to
    // survive load; a real hang still fails, just later.
    testTimeout: 60000,
    hookTimeout: 60000,

    ...(Number.isFinite(uiWorkers) && uiWorkers > 0
      ? { maxWorkers: uiWorkers }
      : {}),

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
