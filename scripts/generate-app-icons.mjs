#!/usr/bin/env node

/**
 * Generate every brand icon from TWO authored sources (both transparent background,
 * all shapes `currentColor`):
 *   images/ctrlyoke-icon.svg         → the full "standard" mark (ctrl keycap → yoke "Y").
 *   images/ctrlyoke-icon-simple.svg  → a dedicated "simple" mark for tiny contexts. At
 *                                      favicon / SCM-toolbar size the yoke is visually lost
 *                                      in the standard mark, so small spots use this instead.
 *
 * Outputs from the STANDARD master (bigger contexts):
 *   - images/ctrlyoke-app-icon.svg  → #ffffff fill on #072c45 background; the
 *                                     user-customizable 2-token file (PWA app icon + settings preview).
 *   - images/icon.png (512)         → VS Code Marketplace icon + manifest app icon.
 *   - images/apple-touch-icon.png (180)
 *
 * Outputs from the SIMPLE master (tiny contexts):
 *   - images/ctrlyoke-icon-light.svg (#424242) / ctrlyoke-icon-dark.svg (#C5C5C5)
 *                                     → VS Code SCM-toolbar command icon (light/dark themes,
 *                                       rendered as <img>, no CSS cascade).
 *   - src/ui/icons/generate-commit-message.svg → copy of the simple master (currentColor) for inline mask use.
 *   - images/ctrlyoke-icon-simple-color.svg → #ffffff on #072c45, 2-token; the hosted-dashboard favicon SVG.
 *   - images/ctrlyoke-icon-simple-color.png (512) → static favicon PNG / notification badge.
 *
 * Also:
 *   - src/types/IconColorDefaults.ts → keeps BG/FG defaults in sync with the 2-token contract.
 *
 * The 2-token contract: the *-color SVGs contain exactly BG_COLOR + FG_COLOR as literals,
 * which ServerSection.tsx and the hosted server swap for user-chosen colors. Do not introduce a
 * third hardcoded color into either master, or the recolor will be partial.
 *
 * Uses @resvg/resvg-wasm for PNG rendering — no native tools (Inkscape, etc.) required.
 *
 * Usage: node scripts/generate-app-icons.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const imagesDir = join(rootDir, "images");

const BG_COLOR = "#072c45";
const FG_COLOR = "#ffffff";
const LIGHT_THEME_ICON_COLOR = "#424242";
const DARK_THEME_ICON_COLOR = "#C5C5C5";

/** Replace all theme-relative and hardcoded colors with the given color. */
function colorize(svg, color = FG_COLOR) {
  return svg
    .replace(/currentColor/g, color)
    .replace(/stroke:#[0-9a-fA-F]{3,6}/g, `stroke:${color}`)
    .replace(/fill:#[0-9a-fA-F]{3,6}/g, `fill:${color}`);
}

/** Insert a solid background rect as the first child of <svg>. */
function addBackground(svg, color) {
  const match = svg.match(/<svg[\s\S]*?>/);
  if (!match) throw new Error("Could not find opening <svg> tag");
  const insertAt = match.index + match[0].length;
  const rect = `<rect width="512" height="512" fill="${color}"/>`;
  return svg.slice(0, insertAt) + rect + svg.slice(insertAt);
}

function applyColors(svg) {
  return addBackground(colorize(svg, FG_COLOR), BG_COLOR);
}

/** Render an SVG string to PNG at the given width (square) using resvg-wasm. */
function renderPng(svgString, width) {
  const resvg = new Resvg(svgString, {
    fitTo: { mode: "width", value: width },
  });
  const rendered = resvg.render();
  const png = Buffer.from(rendered.asPng());
  rendered.free();
  resvg.free();
  return png;
}

const wasmPath = join(
  rootDir,
  "node_modules",
  "@resvg",
  "resvg-wasm",
  "index_bg.wasm"
);
await initWasm(readFileSync(wasmPath));

try {
  const masterSvg = readFileSync(join(imagesDir, "ctrlyoke-icon.svg"), "utf8");
  const simpleSvg = readFileSync(
    join(imagesDir, "ctrlyoke-icon-simple.svg"),
    "utf8"
  );

  const colored = applyColors(masterSvg);
  const coloredSimple = applyColors(simpleSvg);

  // 2-token customizable SVG (PWA app icon + settings live-preview) — full standard mark.
  writeFileSync(join(imagesDir, "ctrlyoke-app-icon.svg"), colored, "utf8");
  console.log("✓ images/ctrlyoke-app-icon.svg");

  // 2-token customizable SIMPLE SVG — the hosted-dashboard favicon. The ctrl→yoke "Y" is
  // visually lost at favicon size, so small contexts use the dedicated simple mark.
  writeFileSync(
    join(imagesDir, "ctrlyoke-icon-simple-color.svg"),
    coloredSimple,
    "utf8"
  );
  console.log("✓ images/ctrlyoke-icon-simple-color.svg");

  // VS Code SCM toolbar icon variants — light/dark themes require hardcoded colors
  // because VS Code renders { light, dark } command icons as <img> (no CSS cascade).
  // Generated from the SIMPLE mark: the commit-message toolbar icon is tiny.
  writeFileSync(
    join(imagesDir, "ctrlyoke-icon-light.svg"),
    colorize(simpleSvg, LIGHT_THEME_ICON_COLOR),
    "utf8"
  );
  console.log("✓ images/ctrlyoke-icon-light.svg");

  writeFileSync(
    join(imagesDir, "ctrlyoke-icon-dark.svg"),
    colorize(simpleSvg, DARK_THEME_ICON_COLOR),
    "utf8"
  );
  console.log("✓ images/ctrlyoke-icon-dark.svg");

  // Keep src/ui/icons/generate-commit-message.svg in sync with the SIMPLE master (currentColor;
  // the custom-icons generator strips color for mask use). The inline commit-message icon is small.
  writeFileSync(
    join(rootDir, "src", "ui", "icons", "generate-commit-message.svg"),
    simpleSvg,
    "utf8"
  );
  console.log("✓ src/ui/icons/generate-commit-message.svg");

  // PNG exports via resvg-wasm
  console.log("\nRendering PNGs via resvg-wasm...");

  writeFileSync(join(imagesDir, "icon.png"), renderPng(colored, 512));
  console.log("  ✓ images/icon.png (512×512)");

  writeFileSync(
    join(imagesDir, "apple-touch-icon.png"),
    renderPng(colored, 180)
  );
  console.log("  ✓ images/apple-touch-icon.png (180×180)");

  // Static favicon PNG (hosted-dashboard favicon fallback + notification badge) — simple mark.
  writeFileSync(
    join(imagesDir, "ctrlyoke-icon-simple-color.png"),
    renderPng(coloredSimple, 512)
  );
  console.log("  ✓ images/ctrlyoke-icon-simple-color.png (512×512)");

  // Keep the TypeScript constants file in sync with BG_COLOR / FG_COLOR so every
  // spot in the codebase that references the default icon colors stays correct.
  const iconDefaultsPath = join(
    rootDir,
    "src",
    "types",
    "IconColorDefaults.ts"
  );
  const iconDefaultsContent =
    `/** @generated by scripts/generate-app-icons.mjs — do not edit manually */\n` +
    `export const ICON_BG_COLOR_DEFAULT = "${BG_COLOR}";\n` +
    `export const ICON_FG_COLOR_DEFAULT = "${FG_COLOR}";\n`;
  writeFileSync(iconDefaultsPath, iconDefaultsContent, "utf8");
  console.log("✓ src/types/IconColorDefaults.ts");

  console.log(
    "\n✅ All app icons generated successfully from ctrlyoke-icon.svg + ctrlyoke-icon-simple.svg."
  );
} catch (err) {
  console.error("❌ Error:", err.message);
  process.exit(1);
}
