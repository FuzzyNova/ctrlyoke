#!/usr/bin/env node
/**
 * Strip development-only commands from package.json for production builds
 *
 * This script removes commands with category "ctrlyoke Test" from package.json
 * before publishing. It's called during `vscode:prepublish`.
 *
 * Usage:
 *   node scripts/strip-dev-commands.mjs
 *   node scripts/strip-dev-commands.mjs --restore (to restore original)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.join(__dirname, "..", "package.json");
const backupPath = path.join(__dirname, "..", "package.json.backup");

const DEV_COMMAND_CATEGORIES = ["ctrlyoke Test"];

// List of dev command IDs to remove (as a fallback if category isn't used)
const DEV_COMMAND_IDS = [
  "ctrlyoke.listAllCommands",
  "ctrlyoke.showLanguageId",
  "ctrlyoke.dumpCssVars",
  "ctrlyoke.devMenu",
];

function stripDevCommands() {
  console.log("📦 Stripping dev commands from package.json...");

  // Read package.json
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  // Backup original
  fs.writeFileSync(backupPath, JSON.stringify(packageJson, null, 2) + "\n");
  console.log(`✅ Created backup at ${backupPath}`);

  // Filter out dev commands
  const removedCommandIds = new Set();

  if (packageJson.contributes?.commands) {
    const originalCount = packageJson.contributes.commands.length;

    packageJson.contributes.commands = packageJson.contributes.commands.filter(
      (cmd) => {
        // Remove if category matches dev categories
        if (
          cmd.category &&
          DEV_COMMAND_CATEGORIES.includes(cmd.category.trim())
        ) {
          console.log(`  ❌ Removing: ${cmd.command} (${cmd.category})`);
          removedCommandIds.add(cmd.command);
          return false;
        }

        // Remove if command ID is in dev list (fallback)
        if (DEV_COMMAND_IDS.includes(cmd.command)) {
          console.log(`  ❌ Removing: ${cmd.command} (dev command)`);
          removedCommandIds.add(cmd.command);
          return false;
        }

        return true;
      }
    );

    const removedCount =
      originalCount - packageJson.contributes.commands.length;
    console.log(
      `\n✅ Removed ${removedCount} dev commands (${packageJson.contributes.commands.length} remaining)`
    );
  }

  // Any menu contribution referencing a removed command would dangle
  // (undeclared command id) once contributes.commands no longer lists it.
  if (packageJson.contributes?.menus && removedCommandIds.size > 0) {
    for (const [menuId, entries] of Object.entries(
      packageJson.contributes.menus
    )) {
      packageJson.contributes.menus[menuId] = entries.filter((entry) => {
        if (removedCommandIds.has(entry.command)) {
          console.log(`  ❌ Removing menu entry: ${entry.command} (${menuId})`);
          return false;
        }
        return true;
      });
    }
  }

  // Write modified package.json
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n"
  );
  console.log(`✅ Updated package.json for production build\n`);
}

function restorePackageJson() {
  console.log("📦 Restoring original package.json...");

  if (!fs.existsSync(backupPath)) {
    console.error("❌ No backup found at", backupPath);
    process.exit(1);
  }

  fs.copyFileSync(backupPath, packageJsonPath);
  fs.unlinkSync(backupPath);

  console.log("✅ Restored original package.json\n");
}

// Main
const args = process.argv.slice(2);

if (args.includes("--restore")) {
  restorePackageJson();
} else {
  stripDevCommands();
}
