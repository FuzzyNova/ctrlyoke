#!/usr/bin/env node

/**
 * Generate ctrlyoke-sidebar-icon.svg from ctrlyoke-icon.svg
 *
 * The master SVG is already currentColor-native (keyyoke/ctrltext use `currentColor`,
 * keyface is `fill:none`), so this script only resizes the outer <svg> tag for VS
 * Code's sidebar (24x24) — it does not recolor anything.
 *
 * VS Code alpha-masks this icon to a single theme color, so it must read as a
 * transparent-background silhouette — never add a background rect or fill keyface here,
 * or it will paint over the yoke's negative space.
 *
 * Usage: node scripts/generate-sidebar-icon.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

// Paths
const sourceIcon = join(rootDir, "images", "ctrlyoke-icon.svg");
const sidebarIcon = join(rootDir, "images", "ctrlyoke-sidebar-icon.svg");

console.log("📦 Generating sidebar icon from source...");

try {
  // Read source SVG
  let svg = readFileSync(sourceIcon, "utf8");

  // Update the opening <svg> tag to add appropriate dimensions for sidebar
  // Keep the viewBox="0 0 512 512" but add width/height for proper scaling
  svg = svg.replace(
    /<svg([^>]*?)>/,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="24" height="24">'
  );

  // Write sidebar icon
  writeFileSync(sidebarIcon, svg, "utf8");

  console.log("✅ Generated images/ctrlyoke-sidebar-icon.svg");
  console.log("   - Dimensions set to 24x24 for sidebar display");
  console.log("   - ViewBox preserved from source icon");
} catch (error) {
  console.error("❌ Error generating sidebar icon:", error.message);
  process.exit(1);
}
