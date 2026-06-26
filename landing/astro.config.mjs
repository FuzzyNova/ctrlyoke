import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  integrations: [tailwind()],
  output: "static",
  // Allow importing the canonical legal docs (LICENSE.md, PRIVACY.md) from the repo root.
  vite: {
    server: { fs: { allow: [".."] } },
  },
});
