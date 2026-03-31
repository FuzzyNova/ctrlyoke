#!/usr/bin/env node

/**
 * One-time script: Convert color SVG icons to monochrome for CSS mask-image usage.
 * Overwrites the source SVGs in place with simplified black-fill versions.
 *
 * Usage: node scripts/convert-icons-to-mono.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, "..", "src", "ui", "icons");

// ── Gemini ────────────────────────────────────────────────────────────────────
// The actual icon shape is the 4-pointed star path defined in the SVG's <mask>.
// We extract just that path and build a clean monochrome SVG from it.
function convertGemini(svgContent) {
  // The star path is the first <path d="M32.447 0 …" fill="…"> inside <mask id="maskme">
  const pathMatch = svgContent.match(
    /<mask id="maskme"[^>]*>[\s\S]*?<path\s+d="([^"]+)"/
  );
  if (!pathMatch)
    throw new Error("google-gemini.svg: could not find star path in mask");

  const starPath = pathMatch[1];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 65 65"><path d="${starPath}" fill="black"/></svg>`;
}

// ── OpenCode ──────────────────────────────────────────────────────────────────
// The icon is two overlapping rectangles forming an open-square / frame shape.
// Replace all fill values with black; drop defs, clip-path, and mask boilerplate.
function convertOpenCode(svgContent) {
  // Extract the two meaningful paths (the ones that draw the icon shape).
  // The clipping rect and white background mask are structural — we want only
  // the paths that actually draw visible pixels in the dark theme version.
  //
  // From the SVG:
  //   path 1 (inner square):  M180 240H60V120H180V240Z  fill=#4B4646
  //   path 2 (outer frame):   M180 60H60V240H180V60ZM240 300H0V0H240V300Z  fill=#F1ECEC
  //
  // The outer frame path creates the negative-space effect (frame with hole).
  // We want BOTH paths so the icon looks like a frame/bracket.
  const pathMatches = [
    ...svgContent.matchAll(/<path\s+d="([^"]+)"\s+fill='([^']+)'/g),
  ];
  if (pathMatches.length === 0)
    throw new Error("opencode-dark.svg: no paths found");

  // Use the even-odd rule so the inner square punches a hole in the outer frame.
  const paths = pathMatches
    .map((m) => `  <path d="${m[1]}" fill="black"/>`)
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 300" fill-rule="evenodd">\n${paths}\n</svg>`;
}

// ── Qwen ──────────────────────────────────────────────────────────────────────
// Replace gradient fill references and the white path fill with black.
// Drop the <defs> gradients entirely.
function convertQwen(svgContent) {
  let out = svgContent;

  // Replace fill="url(#...)" → fill="black"
  out = out.replace(/fill="url\([^)]+\)"/g, 'fill="black"');
  // Replace fill="white" → fill="black"
  out = out.replace(/fill="white"/g, 'fill="black"');
  // Drop the <defs>…</defs> block (gradients no longer needed)
  out = out.replace(/<defs>[\s\S]*?<\/defs>/g, "");

  return out.trim();
}

// ── Main ─────────────────────────────────────────────────────────────────────

const conversions = [
  { file: "google-gemini.svg", convert: convertGemini },
  { file: "opencode-dark.svg", convert: convertOpenCode },
  { file: "qwen.svg", convert: convertQwen },
];

let ok = 0;
let fail = 0;

for (const { file, convert } of conversions) {
  const filePath = path.join(ICONS_DIR, file);
  try {
    const original = fs.readFileSync(filePath, "utf-8");
    const mono = convert(original);
    fs.writeFileSync(filePath, mono, "utf-8");
    console.log(`✓ ${file}`);
    ok++;
  } catch (err) {
    console.error(`✗ ${file}: ${err.message}`);
    fail++;
  }
}

console.log(`\n${ok} converted, ${fail} failed.`);
if (fail > 0) process.exit(1);
console.log("\nNext step: npm run generate-icons");
