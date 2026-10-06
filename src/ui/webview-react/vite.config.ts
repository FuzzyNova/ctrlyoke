import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { staticCopyPlugin } from "./build/staticCopyPlugin";
import { BUILD_MODES, HOSTED_ICON_FILES } from "../../types/DashboardConstants";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // Tailwind 4: theme, sources, and variants all live in styles/globals.css.
    tailwindcss(),
    // Copy static assets that React build needs. A file lands in `dest` under its
    // own name; a directory's contents are copied into `dest` with subfolders kept.
    staticCopyPlugin([
      // Dictionaries for Typo.js spell checking (keeps the en_US/ locale subfolder)
      { src: "static/dictionaries", dest: "dictionaries" },
      // typo.js for spell checking from npm package (typo-js)
      { src: "../../../node_modules/typo-js/typo.js", dest: "." },
      // Codicon CSS and font from @vscode/codicons package
      {
        src: "../../../node_modules/@vscode/codicons/dist/codicon.css",
        dest: "codicons",
      },
      {
        src: "../../../node_modules/@vscode/codicons/dist/codicon.ttf",
        dest: "codicons",
      },
      // Generated custom-icons.css (produced by generate-custom-icons script)
      { src: "static/custom-icons.css", dest: "." },
      // Extension logo for browser-hosted dashboard background
      { src: "../../../images/ctrlyoke-icon.svg", dest: "." },
      // Hosted dashboard favicon/PWA assets. Both APP_ICON_* and FAVICON_* are the
      // same mark; FAVICON_* just renders with a transparent canvas (see ctrlyoke-icon.svg).
      { src: `../../../images/${HOSTED_ICON_FILES.APP_ICON_PNG}`, dest: "." },
      { src: `../../../images/${HOSTED_ICON_FILES.APP_ICON_SVG}`, dest: "." },
      { src: `../../../images/${HOSTED_ICON_FILES.FAVICON_PNG}`, dest: "." },
      { src: `../../../images/${HOSTED_ICON_FILES.FAVICON_SVG}`, dest: "." },
      // 180x180 PNG served at /apple-touch-icon.png for iOS "Add to Home Screen"
      {
        src: `../../../images/${HOSTED_ICON_FILES.APPLE_TOUCH_ICON_PNG}`,
        dest: ".",
      },
    ]),
  ],

  root: path.resolve(__dirname),

  // Explicit build-time flags so dead-code elimination works correctly.
  // import.meta.env.DEV is unreliable in Vite 8 build mode — use these instead.
  define: {
    __WEBVIEW_DEV_MODE__: mode !== BUILD_MODES.PRODUCTION ? "true" : "false",
    // `vite build` forces process.env.NODE_ENV='production' regardless of --mode,
    // making React use its minified build (no full error messages). Override for react-debug.
    ...(mode === "react-debug"
      ? { "process.env.NODE_ENV": '"development"' }
      : {}),
  },

  build: {
    outDir: path.resolve(__dirname, "../../../out/ui/webview-react"),
    emptyOutDir: true,
    minify: mode === BUILD_MODES.PRODUCTION ? "esbuild" : false,
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
      "@root/completions": path.resolve(__dirname, "../../completions"),
      "@icons": path.resolve(__dirname, "../icons"),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },
}));
