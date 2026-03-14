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

    include: ["./test/**/*.test.{ts,tsx}"],

    coverage: {
      provider: "v8",
      include: ["store/**", "hooks/**", "utils/**", "components/**"],
      exclude: ["test/**", "types/**"],
    },
  },
});
