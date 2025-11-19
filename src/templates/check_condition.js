#!/usr/bin/env node
/**
 * FlightPath End Condition Script Example
 * This script checks if tests pass or some condition is met
 */
const { spawn } = require("child_process");
const fs = require("fs");

async function main() {
  try {
    // Example: Check if a file exists
    // if (fs.existsSync('some-generated-file.txt')) {
    //     console.log('true');
    //     process.exit(0);
    // }

    // Example: Run tests
    // const testResult = await runCommand('npm', ['test']);
    // console.log(testResult.success ? 'true' : 'false');
    // process.exit(testResult.success ? 0 : 1);

    // For demo purposes, always return true
    console.log("true");
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
