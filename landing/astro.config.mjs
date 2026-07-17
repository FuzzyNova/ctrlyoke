import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  // Allow importing the canonical legal docs (LICENSE.md, PRIVACY.md) from the repo root.
  vite: {
    plugins: [tailwindcss()],
    server: { fs: { allow: [".."] } },
  },
});
