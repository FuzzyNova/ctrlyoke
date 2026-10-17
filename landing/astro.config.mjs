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
          assetFileNames: ({ name }) =>
            name === "hero-poster-1350x900.webp"
              ? "assets/hero-poster.webp"
              : "assets/[name].[hash][extname]",
        },
      },
    },
  },
});
