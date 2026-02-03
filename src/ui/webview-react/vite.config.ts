import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    // Copy static assets that React build needs
    viteStaticCopy({
      targets: [
        // Copy dictionaries for Typo.js spell checking
        {
          src: "../webview/dictionaries/**/*",
          dest: "dictionaries",
        },
        // Copy typo.js for spell checking
        {
          src: "../webview/typo.js",
          dest: ".",
        },
        // NOTE: Codicons and custom-icons.css are loaded via <link> tags in index.html
        // with URLs injected by the VS Code extension at runtime. The extension copies
        // these files during build (see esbuild.js copyWebviewPlugin).
      ],
    }),
  ],

  root: path.resolve(__dirname),

  build: {
    outDir: path.resolve(__dirname, "../../../out/ui/webview-react"),
    emptyOutDir: true,
    minify: "esbuild",
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
        // Disable code splitting - bundle everything into single file
        manualChunks: undefined,
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
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },
});
