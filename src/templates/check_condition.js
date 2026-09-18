#!/usr/bin/env node
/**
 * ctrlyoke End Condition Script Example
 * This script checks if tests pass or some condition is met
 */
const { spawn } = require("child_process");
const fs = require("fs");

async function main() {
  try {
    // Example: Check if a file exists
    // process.exit(fs.existsSync('some-generated-file.txt') ? 0 : 1);

    // Example: Run tests
    // const testResult = await runCommand('npm', ['test']);
    // process.exit(testResult.success ? 0 : 1);

    // For demo purposes, always succeed. The exit code is the whole contract:
    // 0 passes, non-zero fails.
    process.exit(0);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args);
    child.on("close", (code) => {
      resolve({ success: code === 0 });
    });
  });
}

main();
