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
        // TODO: Copy codicons and custom icons once they're set up properly
        // For now, these will be loaded from the main webview directory
      ],
    }),
  ],

  root: path.resolve(__dirname),

  build: {
    outDir: path.resolve(__dirname, "../../../out/ui/webview-react"),
    emptyOutDir: true,
    minify: "esbuild",
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
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
