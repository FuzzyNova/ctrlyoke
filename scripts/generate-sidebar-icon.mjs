#!/usr/bin/env node

/**
 * Generate flightpath-sidebar-icon.svg from flightpath-icon.svg
 *
 * This script reads the main icon SVG and converts it for use in VS Code's sidebar:
 * - Ensures all fill/stroke attributes use currentColor for theme support
 * - Sets appropriate viewBox and dimensions for sidebar display (24x24)
 * - Writes the optimized version to images/flightpath-sidebar-icon.svg
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
const sourceIcon = join(rootDir, "images", "flightpath-icon.svg");
const sidebarIcon = join(rootDir, "images", "flightpath-sidebar-icon.svg");

console.log("📦 Generating sidebar icon from source...");

try {
  // Read source SVG
  let svg = readFileSync(sourceIcon, "utf8");

  // Replace all hardcoded colors with currentColor
  // Match both stroke and fill attributes with various color formats
  svg = svg
    // stroke:#RRGGBB or stroke:#RGB
    .replace(/stroke:#[0-9a-fA-F]{3,6}/g, "stroke:currentColor")
    // fill:#RRGGBB or fill:#RGB (but not fill:none)
    .replace(/fill:#[0-9a-fA-F]{3,6}/g, "fill:currentColor")
    // stroke="black", stroke="white", etc.
    .replace(
      /stroke="(?:black|white|#[0-9a-fA-F]{3,6})"/g,
      'stroke="currentColor"'
    )
    // fill="black", fill="white", etc. (but not fill="none")
    .replace(
      /fill="(?:black|white|#[0-9a-fA-F]{3,6})"/g,
      'fill="currentColor"'
    );

  // Update the opening <svg> tag to add appropriate dimensions for sidebar
  // Keep the viewBox="0 0 512 512" but add width/height for proper scaling
  svg = svg.replace(
    /<svg([^>]*?)>/,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="24" height="24">'
  );

  // Write sidebar icon
  writeFileSync(sidebarIcon, svg, "utf8");

  console.log("✅ Generated images/flightpath-sidebar-icon.svg");
  console.log("   - All colors replaced with currentColor");
  console.log("   - Dimensions set to 24x24 for sidebar display");
  console.log("   - ViewBox preserved from source icon");
} catch (error) {
  console.error("❌ Error generating sidebar icon:", error.message);
  process.exit(1);
}
