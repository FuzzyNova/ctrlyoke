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
        // Copy codicon CSS from @vscode/codicons package
        {
          src: "../../../node_modules/@vscode/codicons/dist/codicon.css",
          dest: "codicons",
        },
        // Copy codicon font file
        {
          src: "../../../node_modules/@vscode/codicons/dist/codicon.ttf",
          dest: "codicons",
        },
        // Copy generated custom-icons.css (produced by generate-custom-icons script)
        {
          src: "../webview/custom-icons.css",
          dest: ".",
        },
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
