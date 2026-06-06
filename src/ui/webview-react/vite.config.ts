import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";
import { HOSTED_ICON_FILES } from "../../types/DashboardConstants";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // Copy static assets that React build needs
    viteStaticCopy({
      targets: [
        // Copy dictionaries for Typo.js spell checking
        // stripBase:2 strips "static/dictionaries/" while preserving the locale subfolder (en_US/).
        {
          src: "static/dictionaries/**/*",
          dest: "dictionaries",
          rename: { stripBase: 2 },
        },
        // Copy typo.js for spell checking from npm package (typo-js)
        // stripBase:true strips the "typo-js/" directory prefix so the file lands at the output root as "typo.js".
        {
          src: "../../../node_modules/typo-js/typo.js",
          dest: ".",
          rename: { stripBase: true },
        },
        // Copy codicon CSS from @vscode/codicons package
        {
          src: "../../../node_modules/@vscode/codicons/dist/codicon.css",
          dest: "codicons",
          rename: { stripBase: true },
        },
        // Copy codicon font file
        {
          src: "../../../node_modules/@vscode/codicons/dist/codicon.ttf",
          dest: "codicons",
          rename: { stripBase: true },
        },
        // Copy generated custom-icons.css (produced by generate-custom-icons script)
        {
          src: "static/custom-icons.css",
          dest: ".",
          rename: { stripBase: true },
        },
        // Copy extension logo for browser-hosted dashboard background
        {
          src: "../../../images/flightpath-icon.svg",
          dest: ".",
          rename: { stripBase: true },
        },
        // Copy hosted dashboard favicon/PWA assets
        {
          src: `../../../images/${HOSTED_ICON_FILES.APP_ICON_PNG}`,
          dest: ".",
          rename: { stripBase: true },
        },
        {
          src: `../../../images/${HOSTED_ICON_FILES.APP_ICON_SVG}`,
          dest: ".",
          rename: { stripBase: true },
        },
        {
          src: `../../../images/${HOSTED_ICON_FILES.FAVICON_PNG}`,
          dest: ".",
          rename: { stripBase: true },
        },
        {
          src: `../../../images/${HOSTED_ICON_FILES.FAVICON_SVG}`,
          dest: ".",
          rename: { stripBase: true },
        },
        // 180x180 PNG served at /apple-touch-icon.png for iOS "Add to Home Screen"
        {
          src: `../../../images/${HOSTED_ICON_FILES.APPLE_TOUCH_ICON_PNG}`,
          dest: ".",
          rename: { stripBase: true },
        },
      ],
    }),
  ],

  root: path.resolve(__dirname),

  // Explicit build-time flags so dead-code elimination works correctly.
  // import.meta.env.DEV is unreliable in Vite 8 build mode — use these instead.
  define: {
    __WEBVIEW_DEV_MODE__: mode !== "production" ? "true" : "false",
    // `vite build` forces process.env.NODE_ENV='production' regardless of --mode,
    // making React use its minified build (no full error messages). Override for react-debug.
    ...(mode === "react-debug"
      ? { "process.env.NODE_ENV": '"development"' }
      : {}),
  },

  build: {
    outDir: path.resolve(__dirname, "../../../out/ui/webview-react"),
    emptyOutDir: true,
    minify: mode === "production" ? "esbuild" : false,
    sourcemap: true,
    // Webview requirements: single bundle, predictable names (no hashes)
    cssCodeSplit: false,
    // CodeMirror bundle is large - this is intentional for webview
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        // Predictable names for extension to reference
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
        // Name the main dashboard chunk explicitly; without this Rollup picks
        // "mermaid" from refractor's language grammar modules inside the bundle.
        manualChunks: (id) => {
          if (id.includes("/webview-react/App.")) return "dashboard";
        },
      },
    },
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "@components": path.resolve(__dirname, "components"),
      "@hooks": path.resolve(__dirname, "hooks"),
      "@store": path.resolve(__dirname, "store"),
      "@utils": path.resolve(__dirname, "utils"),
      "@types": path.resolve(__dirname, "types"),
      // Allow importing from extension-side src/types and src/utils for shared definitions
      "@root/types": path.resolve(__dirname, "../../types"),
      "@root/utils": path.resolve(__dirname, "../../utils"),
      "@icons": path.resolve(__dirname, "../icons"),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },
}));
