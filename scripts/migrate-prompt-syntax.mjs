#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { glob } from "glob";
import { resolve } from "path";

/**
 * One-time migration script: #file:path → @path (full files only)
 * Keeps #file:path:10-20 unchanged (line ranges)
 *
 * Usage:
 *   node scripts/migrate-prompt-syntax.mjs
 *
 * This script is throw-away (not included in extension).
 */

const cwd = resolve(process.cwd());

// Find all JSON and MD files in manual-test and templates
const patterns = [
  "manual-test/**/*.{json,md}",
  "src/templates/**/*.{json,md}",
  ".flightpath/**/*.{json,md}",
];

let totalFiles = 0;
let totalReplacements = 0;

for (const pattern of patterns) {
  const files = glob.sync(pattern, {
    cwd,
    absolute: true,
  });

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf-8");

    // Replace #file:path BUT NOT #file:path:10-20
    // Strategy: Match #file:path and check if it's followed by :digits-digits pattern
    // Use a function to inspect each match
    // Note: Exclude backticks and other delimiters from the path capture
    const newContent = content.replace(
      /#file:([^\s`"')\]}>]+)/g,
      (match, pathWithPossibleRange) => {
        // Check if path ends with :digits-digits (line range pattern)
        if (/:\d+-\d+$/.test(pathWithPossibleRange)) {
          return match; // Keep #file:path:10-20 unchanged
        }
        // Replace #file:path with @path
        return `@${pathWithPossibleRange}`;
      }
    );

    if (newContent !== content) {
      writeFileSync(filePath, newContent, "utf-8");
      totalFiles++;

      // Count replacements by comparing occurrences
      const oldMatches = content.match(/#file:([^\s]+)/g) || [];
      const newMatches = newContent.match(/#file:([^\s]+)/g) || [];
      totalReplacements += oldMatches.length - newMatches.length;

      // Show relative path for cleaner output
      const relativePath = filePath
        .replace(cwd + "/", "")
        .replace(cwd + "\\", "");
      console.log(`✅ ${relativePath}`);
    }
  }
}

console.log(`\n📊 Migration complete:`);
console.log(`   Files updated: ${totalFiles}`);
console.log(`   Replacements: ${totalReplacements}`);

if (totalFiles === 0) {
  console.log(`\n✨ No files needed migration (already using @path syntax)`);
} else {
  console.log(`\n⚠️  Please review the changes before committing.`);
}
