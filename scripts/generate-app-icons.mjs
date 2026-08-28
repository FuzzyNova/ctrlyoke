#!/usr/bin/env node

/**
 * Generate every brand icon from ONE authored source (transparent background,
 * `currentColor` fg, `fill:none` keyface):
 *   images/ctrlyoke-icon.svg → the single "ctrl keycap → yoke Y" mark. It reads
 *   correctly at every size we need (VS Code sidebar/panel down to favicon), so
 *   there is no separate "simple" master.
 *
 * The master has 3 named paths:
 *   - id="keyface" → the keycap background shape. Authored as `fill:none` so the
 *     master renders correctly as-is in VS Code's CSS-cascade / alpha-mask contexts
 *     (transparent keyface, transparent canvas). Recolored to BG_COLOR for the
 *     baked-color outputs below.
 *   - id="keyyoke", id="ctrltext" → the yoke glyph + "CTRL" text, both authored as
 *     `currentColor`. Recolored to FG_COLOR (or a theme color) for baked outputs.
 *
 * Outputs:
 *   - images/ctrlyoke-app-icon.svg  → FG_COLOR fg on BG_COLOR bg (keyface + canvas rect
 *                                     both BG_COLOR); the user-customizable 2-token
 *                                     file (PWA app icon + settings preview).
 *   - images/icon.png (512)         → VS Code Marketplace / Extensions view icon
 *                                     (package.json "icon"). TRANSPARENT canvas — VS Code
 *                                     supports and recommends this so it reads correctly
 *                                     on both light and dark Marketplace backgrounds.
 *   - images/apple-touch-icon.png (180) → iOS home-screen fallback. Stays OPAQUE — unlike
 *                                     the Marketplace icon, iOS has never supported
 *                                     transparent home-screen icons.
 *   - images/ctrlyoke-icon-color.svg → FG_COLOR fg, BG_COLOR keyface, TRANSPARENT canvas
 *                                     (no rect) — the 2-token favicon SVG. Sits as a
 *                                     colored keycap glyph rather than a solid square.
 *   - images/ctrlyoke-icon-color.png (512) → static favicon PNG / notification badge.
 *                                     Also reused for images/icon.png above (same
 *                                     transparent-canvas render).
 *   - images/ls-logo.png (160)       → Lemon Squeezy store logo. Opaque BG_COLOR canvas
 *                                     with the logo inset to 120×120 for circular cropping.
 *   - images/ls-favicon.png (32)     → Lemon Squeezy favicon, the same transparent-canvas
 *                                     render as images/icon.png at 32×32.
 *   - landing/public/ctrlyoke-icon.svg + docs/public/ctrlyoke-icon.svg → web favicon +
 *                                     header logos for the marketing + docs sites.
 *                                     Loaded via <img>/<link rel=icon> (no CSS cascade),
 *                                     so they get the same baked-color favicon SVG.
 *   - images/ctrlyoke-icon-light.svg (#424242) / ctrlyoke-icon-dark.svg (#C5C5C5)
 *                                     → VS Code SCM-toolbar command icon (light/dark
 *                                       themes, rendered as <img>, no CSS cascade).
 *                                       Keyface stays transparent (silhouette only).
 *   - src/ui/icons/generate-commit-message.svg → verbatim copy of the master
 *                                     (currentColor; the custom-icons generator
 *                                     strips color for mask use).
 *
 * Also:
 *   - src/types/IconColorDefaults.ts → keeps BG/FG defaults in sync with the 2-token contract.
 *
 * The 2-token contract: the *-color SVGs contain exactly BG_COLOR + FG_COLOR as literals,
 * which ServerSection.tsx and the hosted server swap for user-chosen colors. Do not introduce a
 * third hardcoded color into the master, or the recolor will be partial.
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
const landingPublicDir = join(rootDir, "landing", "public");
const docsPublicDir = join(rootDir, "docs", "public");

const BG_COLOR = "#3994BC";
const FG_COLOR = "#051923";
const LIGHT_THEME_ICON_COLOR = "#424242";
const DARK_THEME_ICON_COLOR = "#C5C5C5";
const SVG_CANVAS_SIZE = 512;
const LS_LOGO_SIZE = 160;
const LS_LOGO_MARK_SIZE = 140;

/** Replace all `currentColor` occurrences (keyyoke + ctrltext) with the given color. */
function colorizeFg(svg, color) {
  return svg.replace(/currentColor/g, color);
}

/** Recolor the keyface path's `fill:none` to the given color. Keyface is matched by
 *  id, not by color, so this is robust to future re-exports reordering attributes. */
function colorizeKeyface(svg, color) {
  const re = /<path\b[^>]*\bid="keyface"[^>]*\/>/;
  const match = svg.match(re);
  if (!match)
    throw new Error('Could not find <path id="keyface"> in master SVG');
  if (!match[0].includes("fill:none")) {
    throw new Error(
      'keyface path does not have "fill:none" — master SVG authoring contract changed?'
    );
  }
  const replaced = match[0].replace("fill:none", `fill:${color}`);
  return (
    svg.slice(0, match.index) +
    replaced +
    svg.slice(match.index + match[0].length)
  );
}

/** Insert a solid background rect as the first child of <svg>. */
function addBackground(svg, color) {
  const match = svg.match(/<svg[\s\S]*?>/);
  if (!match) throw new Error("Could not find opening <svg> tag");
  const insertAt = match.index + match[0].length;
  const rect = `<rect width="${SVG_CANVAS_SIZE}" height="${SVG_CANVAS_SIZE}" fill="${color}"/>`;
  return svg.slice(0, insertAt) + rect + svg.slice(insertAt);
}

/** Scale the authored logo group into a centered inset while leaving the canvas intact. */
function insetLogo(svg, canvasSize, outputSize, markSize) {
  const match = svg.match(/<g\b[^>]*\bid="ctrlyoke-logo"[^>]*>/);
  if (!match)
    throw new Error('Could not find <g id="ctrlyoke-logo"> in master SVG');

  const scale = markSize / outputSize;
  const offset = (canvasSize - canvasSize * scale) / 2;
  const transform = ` transform="translate(${offset} ${offset}) scale(${scale})"`;
  const openingTag = match[0].slice(0, -1) + transform + ">";

  return (
    svg.slice(0, match.index) +
    openingTag +
    svg.slice(match.index + match[0].length)
  );
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

  // 2-token "solid" mark (app icon / marketplace tile / apple-touch-icon): keyface AND
  // the canvas rect are both BG_COLOR, so they blend into one seamless colored square.
  let appIcon = colorizeFg(masterSvg, FG_COLOR);
  appIcon = colorizeKeyface(appIcon, BG_COLOR);
  appIcon = addBackground(appIcon, BG_COLOR);

  writeFileSync(join(imagesDir, "ctrlyoke-app-icon.svg"), appIcon, "utf8");
  console.log("✓ images/ctrlyoke-app-icon.svg");

  // 2-token "favicon" mark: same colors as appIcon, but NO canvas rect — keyface alone
  // (a rounded keycap shape, not the full 512x512 square) carries BG_COLOR, so the icon
  // sits as a colored glyph on a transparent page/tab background.
  let favicon = colorizeFg(masterSvg, FG_COLOR);
  favicon = colorizeKeyface(favicon, BG_COLOR);

  writeFileSync(join(imagesDir, "ctrlyoke-icon-color.svg"), favicon, "utf8");
  console.log("✓ images/ctrlyoke-icon-color.svg");

  // Web favicons + header logos for the landing site and docs site. Same favicon-style
  // (transparent canvas) mark as above. Consumed via <link rel="icon"> and <img src> —
  // which render an SVG in isolation and IGNORE ancestor CSS color — so they must carry
  // BAKED colors, not currentColor (a currentColor mark renders black/invisible on the
  // dark sites). Single-sourced here so editing images/ctrlyoke-icon.svg propagates.
  for (const dest of [
    join(landingPublicDir, "ctrlyoke-icon.svg"),
    join(docsPublicDir, "ctrlyoke-icon.svg"),
  ]) {
    writeFileSync(dest, favicon, "utf8");
    console.log(`✓ ${dest.slice(rootDir.length + 1).replace(/\\/g, "/")}`);
  }

  // VS Code SCM toolbar icon variants — light/dark themes require hardcoded colors
  // because VS Code renders { light, dark } command icons as <img> (no CSS cascade).
  // Keyface stays untouched (still `fill:none`) so these read as a transparent-canvas
  // silhouette, not a filled block.
  writeFileSync(
    join(imagesDir, "ctrlyoke-icon-light.svg"),
    colorizeFg(masterSvg, LIGHT_THEME_ICON_COLOR),
    "utf8"
  );
  console.log("✓ images/ctrlyoke-icon-light.svg");

  writeFileSync(
    join(imagesDir, "ctrlyoke-icon-dark.svg"),
    colorizeFg(masterSvg, DARK_THEME_ICON_COLOR),
    "utf8"
  );
  console.log("✓ images/ctrlyoke-icon-dark.svg");

  // Keep src/ui/icons/generate-commit-message.svg in sync with the master (currentColor,
  // transparent keyface; the custom-icons generator strips color for mask use).
  writeFileSync(
    join(rootDir, "src", "ui", "icons", "generate-commit-message.svg"),
    masterSvg,
    "utf8"
  );
  console.log("✓ src/ui/icons/generate-commit-message.svg");

  // PNG exports via resvg-wasm
  console.log("\nRendering PNGs via resvg-wasm...");

  // VS Code Marketplace / Extensions view icon (package.json "icon"). Transparent canvas —
  // Microsoft's publishing docs recommend transparency here so the icon reads correctly
  // against both light and dark Marketplace/Extensions-view backgrounds. Uses the same
  // favicon-style render as ctrlyoke-icon-color.png.
  writeFileSync(join(imagesDir, "icon.png"), renderPng(favicon, 512));
  console.log("  ✓ images/icon.png (512×512)");

  // iOS apple-touch-icon PNG fallback — stays opaque. iOS has never supported transparent
  // home-screen icons (it always fills a solid backdrop), unlike the Marketplace icon above.
  writeFileSync(
    join(imagesDir, "apple-touch-icon.png"),
    renderPng(appIcon, 180)
  );
  console.log("  ✓ images/apple-touch-icon.png (180×180)");

  // Static favicon PNG (hosted-dashboard favicon fallback + notification badge).
  writeFileSync(
    join(imagesDir, "ctrlyoke-icon-color.png"),
    renderPng(favicon, 512)
  );
  console.log("  ✓ images/ctrlyoke-icon-color.png (512×512)");

  // Lemon Squeezy store logo — keep the opaque BG_COLOR canvas, but inset the mark so
  // Lemon Squeezy's circular crop does not cut off the outer edges of the logo.
  const lemonSqueezyLogo = insetLogo(
    appIcon,
    SVG_CANVAS_SIZE,
    LS_LOGO_SIZE,
    LS_LOGO_MARK_SIZE
  );
  writeFileSync(
    join(imagesDir, "ls-logo.png"),
    renderPng(lemonSqueezyLogo, LS_LOGO_SIZE)
  );
  console.log("  ✓ images/ls-logo.png (160×160; 120×120 mark)");

  // Lemon Squeezy favicon — same transparent-canvas artwork as icon.png, rendered at 32px.
  writeFileSync(join(imagesDir, "ls-favicon.png"), renderPng(favicon, 32));
  console.log("  ✓ images/ls-favicon.png (32×32)");

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
    "\n✅ All app icons generated successfully from ctrlyoke-icon.svg."
  );
} catch (err) {
  console.error("❌ Error:", err.message);
  process.exit(1);
}
