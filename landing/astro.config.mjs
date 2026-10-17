import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  site: "https://ctrlyoke.dev",
  integrations: [sitemap()],
  // Allow importing the canonical legal docs (LICENSE.md, PRIVACY.md) from the repo root.
  vite: {
    plugins: [tailwindcss()],
    server: { fs: { allow: [".."] } },
    build: {
      rollupOptions: {
        output: {
          // Unhashed so the docs' og:image (docs/.vitepress/config.mts) can name a stable URL.
          assetFileNames: ({ name }) =>
            name === "social-preview.png"
              ? "assets/social-preview.png"
              : "assets/[name].[hash][extname]",
        },
      },
    },
  },
});
