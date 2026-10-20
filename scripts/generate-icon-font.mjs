#!/usr/bin/env node

/**
 * Generate images/ctrlyoke-icons.woff from images/ctrlyoke-icon.svg
 *
 * VS Code status bar text can only show `$(name)` icons, and an extension adds
 * its own through package.json `contributes.icons`, which must point at a glyph
 * in an icon font. This script turns the master mark into that font, so the
 * status bar can show `$(ctrlyoke-logo)` instead of a codicon.
 *
 * A font glyph is a single filled silhouette drawn in the surrounding text
 * color, so:
 *   - the `fill:none` keyface is dropped. A font has no unfilled paths and would
 *     paint it solid over the yoke's negative space;
 *   - the glyph keeps the master's 512x512 viewBox as its advance and em box, so
 *     it has the same padding as the sidebar icon;
 *   - descent is 0, matching codicon.ttf, whose em sits entirely above the
 *     baseline, so the logo lines up with the codicons beside it.
 *
 * `fontCharacter` in package.json must match GLYPH_CODEPOINT below.
 *
 * Usage: node scripts/generate-icon-font.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { SVGIcons2SVGFontStream } from "svgicons2svgfont";
import svg2ttf from "svg2ttf";
import ttf2woff from "ttf2woff";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

// Paths
const sourceIcon = join(rootDir, "images", "ctrlyoke-icon.svg");
const fontFile = join(rootDir, "images", "ctrlyoke-icons.woff");

const FONT_NAME = "ctrlyoke-icons";
const GLYPH_NAME = "ctrlyoke-logo";
const GLYPH_CODEPOINT = 0xe001;

/** Remove the unfilled keyface path, which a font would render solid. */
function stripUnfilledPaths(svg) {
  return svg.replace(/<path\b(?:(?!\/>)[\s\S])*?fill:none[\s\S]*?\/>/g, "");
}

/** Build an SVG font holding the single logo glyph. */
function buildSvgFont(iconSvg) {
  return new Promise((resolve, reject) => {
    let font = "";
    const fontStream = new SVGIcons2SVGFontStream({
      fontName: FONT_NAME,
      descent: 0,
      log: () => {},
    });
    fontStream.on("data", (chunk) => (font += chunk));
    fontStream.on("end", () => resolve(font));
    fontStream.on("error", reject);

    const glyph = Readable.from([iconSvg]);
    glyph.metadata = {
      name: GLYPH_NAME,
      unicode: [String.fromCodePoint(GLYPH_CODEPOINT)],
    };
    fontStream.write(glyph);
    fontStream.end();
  });
}

console.log("📦 Generating icon font from source...");

try {
  const iconSvg = stripUnfilledPaths(readFileSync(sourceIcon, "utf8"));
  if (iconSvg.includes('id="keyface"')) {
    throw new Error("keyface path was not removed; check its fill:none style");
  }

  const svgFont = await buildSvgFont(iconSvg);
  // A fixed timestamp keeps the output byte-identical between runs.
  const ttf = svg2ttf(svgFont, { ts: 0 });
  const woff = ttf2woff(new Uint8Array(ttf.buffer));
  writeFileSync(fontFile, Buffer.from(woff.buffer));

  console.log("✅ Generated images/ctrlyoke-icons.woff");
  console.log(
    `   - ${GLYPH_NAME} at U+${GLYPH_CODEPOINT.toString(16).toUpperCase()}`
  );
} catch (error) {
  console.error("❌ Error generating icon font:", error.message);
  process.exit(1);
}
