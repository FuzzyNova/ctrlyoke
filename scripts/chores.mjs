#!/usr/bin/env node

/**
 * FlightPath Developer Chores Automation
 *
 * Automates common maintenance tasks for FlightPath development.
 *
 * Usage:
 *   npm run chores                    # Interactive mode
 *   npm run chores -- --task all      # Run all automated chores
 *   npm run chores -- --task update-deps
 *   npm run chores -- --help
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logHeader(message) {
  console.log();
  log(`${"=".repeat(60)}`, colors.cyan);
  log(`${message}`, colors.bright + colors.cyan);
  log(`${"=".repeat(60)}`, colors.cyan);
  console.log();
}

function logSuccess(message) {
  log(`✓ ${message}`, colors.green);
}

function logError(message) {
  log(`✗ ${message}`, colors.red);
}

function logWarning(message) {
  log(`⚠ ${message}`, colors.yellow);
}

function logInfo(message) {
  log(`ℹ ${message}`, colors.blue);
}

/**
 * Run a command and return a promise
 */
function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: "inherit",
      shell: true,
      ...options,
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

/**
 * Check if CLI tool is installed
 */
async function checkCliInstalled(command, name) {
  try {
    await runCommand(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    logWarning(`${name} CLI not installed`);
    return false;
  }
}

/**
 * Task: Update dependencies
 */
async function updateDependencies() {
  logHeader("Updating Dependencies");

  try {
    logInfo("Checking for outdated packages...");
    await runCommand("npm", ["outdated"]).catch(() => {
      // npm outdated returns non-zero if packages are outdated, that's fine
    });

    console.log();
    logInfo("Updating packages...");
    await runCommand("npm", ["update"]);

    console.log();
    logInfo("Running security audit...");
    await runCommand("npm", ["audit"]).catch(() => {
      // npm audit returns non-zero if vulnerabilities found
    });

    console.log();
    logInfo("Attempting to fix vulnerabilities...");
    await runCommand("npm", ["audit", "fix"]).catch(() => {
      logWarning("Some vulnerabilities could not be auto-fixed");
    });

    console.log();
    logSuccess("Dependencies updated");
    logInfo("Don't forget to test: npm run compile && npm test");
  } catch (error) {
    logError(`Failed to update dependencies: ${error.message}`);
    throw error;
  }
}

/**
 * Task: Check for CLI updates
 */
async function checkCliUpdates() {
  logHeader("Checking CLI Tool Versions");

  const clis = [
    { command: "copilot", name: "GitHub Copilot CLI" },
    { command: "claude", name: "Claude Code CLI" },
    { command: "codex", name: "Codex CLI" },
  ];

  for (const cli of clis) {
    const installed = await checkCliInstalled(cli.command, cli.name);
    if (installed) {
      logSuccess(`${cli.name} is installed`);
      try {
        await runCommand(cli.command, ["--version"]);
      } catch {
        // Ignore errors
      }
    }
  }

  console.log();
  logInfo("To update CLIs, see CHORES.md section 1");
  logWarning(
    "CLI updates must be done manually (requires different package managers)"
  );
}

/**
 * Task: Sync models
 */
async function syncModels() {
  logHeader("Syncing Model Registry");

  try {
    const discoveredModelsPath = path.join(
      ROOT_DIR,
      "scripts",
      "discovered-models.json"
    );

    if (!fs.existsSync(discoveredModelsPath)) {
      logWarning("No discovered-models.json found");
      logInfo(
        "Run 'FlightPath: Export Discovered Models' command in VS Code first"
      );
      logInfo("See CHORES.md section 2 for full workflow");
      return;
    }

    logInfo("Importing models to ModelConstants.ts...");
    await runCommand("npm", ["run", "sync-models:import"]);

    console.log();
    logInfo("Syncing models to package.json and schema...");
    await runCommand("npm", ["run", "sync-models"]);

    console.log();
    logSuccess("Model registry synced");
    logInfo("Files updated:");
    logInfo("  - src/utils/ModelConstants.ts");
    logInfo("  - package.json");
    logInfo("  - schemas/prompt-schema.json");
    console.log();
    logInfo("Note: YAML schema will be auto-generated on next compile");
  } catch (error) {
    logError(`Failed to sync models: ${error.message}`);
    throw error;
  }
}

/**
 * Task: Run all checks (lint, format, test)
 */
async function runAllChecks() {
  logHeader("Running All Checks");

  try {
    logInfo("Checking TypeScript types...");
    await runCommand("npm", ["run", "check-types"]);

    console.log();
    logInfo("Running linter...");
    await runCommand("npm", ["run", "lint"]);

    console.log();
    logInfo("Checking code formatting...");
    await runCommand("npm", ["run", "format:check"]);

    console.log();
    logInfo("Compiling extension...");
    await runCommand("npm", ["run", "compile"]);

    console.log();
    logInfo("Running tests...");
    await runCommand("npm", ["test"]);

    console.log();
    logSuccess("All checks passed!");
  } catch (error) {
    logError(`Checks failed: ${error.message}`);
    throw error;
  }
}

/**
 * Display help
 */
function showHelp() {
  console.log(`
${colors.bright}FlightPath Developer Chores${colors.reset}

${colors.cyan}Usage:${colors.reset}
  npm run chores                    Interactive mode (coming soon)
  npm run chores -- --task <name>   Run specific task
  npm run chores -- --help          Show this help

${colors.cyan}Available Tasks:${colors.reset}
  ${colors.green}update-deps${colors.reset}     Update dependencies and run npm audit
  ${colors.green}check-clis${colors.reset}      Check installed CLI tool versions
  ${colors.green}sync-models${colors.reset}     Sync model registry (requires exported models)
  ${colors.green}check-all${colors.reset}       Run all checks (lint, format, tests)
  ${colors.green}all${colors.reset}             Run all automated chores

${colors.cyan}Examples:${colors.reset}
  npm run chores -- --task update-deps
  npm run chores -- --task sync-models
  npm run chores -- --task all

${colors.cyan}Manual Tasks:${colors.reset}
  Some tasks require manual steps. See ${colors.blue}CHORES.md${colors.reset} for details:
  - Updating CLI tools (section 1)
  - Exporting discovered models (section 2)
  - Updating VS Code commands (section 3)

${colors.cyan}Documentation:${colors.reset}
  See ${colors.blue}CHORES.md${colors.reset} for complete maintenance guide
`);
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }

  const taskIndex = args.indexOf("--task");
  const task = taskIndex !== -1 ? args[taskIndex + 1] : null;

  if (!task) {
    logError("No task specified");
    console.log();
    showHelp();
    process.exit(1);
  }

  try {
    switch (task) {
      case "update-deps":
        await updateDependencies();
        break;

      case "check-clis":
        await checkCliUpdates();
        break;

      case "sync-models":
        await syncModels();
        break;

      case "check-all":
        await runAllChecks();
        break;

      case "all":
        logHeader("Running All Automated Chores");
        await checkCliUpdates();
        await runAllChecks();
        logHeader("All Automated Chores Complete");
        logInfo("Manual tasks remaining:");
        logInfo("  1. Update CLI tools (see CHORES.md section 1)");
        logInfo("  2. Update models (see CHORES.md section 2)");
        logInfo("  3. Update VS Code commands (see CHORES.md section 3)");
        break;

      default:
        logError(`Unknown task: ${task}`);
        console.log();
        showHelp();
        process.exit(1);
    }

    console.log();
    logSuccess("Task completed successfully!");
  } catch (error) {
    console.log();
    logError("Task failed!");
    process.exit(1);
  }
}

main();
