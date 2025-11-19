#!/usr/bin/env node

/**
 * Validation script for validateEmail function testing
 *
 * This script:
 * 1. Checks if validateEmail.js exists
 * 2. Loads and executes the file
 * 3. Runs test cases and validates results
 * 4. Exits with code 0 always (validation failures trigger retry, not error)
 */

const fs = require("fs");
const path = require("path");

const targetFile = path.join(process.cwd(), "validateEmail.js");

// Check if file exists
if (!fs.existsSync(targetFile)) {
  console.log("file_not_found");
  console.log(
    "ERROR: validateEmail.js does not exist. Please create it first."
  );
  process.exit(0); // Exit cleanly for retry
}

try {
  // Load the file
  const code = fs.readFileSync(targetFile, "utf8");

  // Check for basic structure
  if (!code.includes("validateEmail")) {
    console.log("function_not_found");
    console.log("ERROR: validateEmail function not found in file.");
    process.exit(0);
  }

  // Execute the code to get the function
  // Note: In a real scenario, you'd want better isolation
  const validateEmail = eval(`
        ${code}
        validateEmail
    `);

  if (typeof validateEmail !== "function") {
    console.log("not_a_function");
    console.log("ERROR: validateEmail is not a function.");
    process.exit(0);
  }

  // Run test cases
  const tests = [
    { input: "test@example.com", expected: true, description: "Valid email" },
    { input: "invalid-email", expected: false, description: "No @ symbol" },
    { input: "test@domain", expected: false, description: "No . after @" },
    { input: "@example.com", expected: false, description: "Empty local part" },
    { input: "test@.com", expected: false, description: "Empty domain part" },
    { input: "test@domain.c", expected: false, description: "TLD too short" },
    {
      input: "user.name+tag@example.co.uk",
      expected: true,
      description: "Complex valid email",
    },
  ];

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const test of tests) {
    const result = validateEmail(test.input);
    if (result === test.expected) {
      passed++;
    } else {
      failed++;
      failures.push({
        input: test.input,
        expected: test.expected,
        actual: result,
        description: test.description,
      });
    }
  }

  // Report results
  if (failed === 0) {
    console.log("all_tests_passed");
    console.log(`✓ All ${passed} tests passed successfully!`);
    process.exit(0);
  } else {
    console.log("tests_failed");
    console.log(`✗ ${failed}/${tests.length} tests failed:\n`);

    failures.forEach((failure, idx) => {
      console.log(`${idx + 1}. ${failure.description}`);
      console.log(`   Input: "${failure.input}"`);
      console.log(`   Expected: ${failure.expected}`);
      console.log(`   Actual: ${failure.actual}`);
      console.log("");
    });

    console.log(`Passed: ${passed}/${tests.length}`);
    process.exit(0); // Exit cleanly - this is validation failure, triggers retry
  }
} catch (error) {
  console.log("execution_error");
  console.log(
    `ERROR: Failed to execute validateEmail function: ${error.message}`
  );
  console.log("");
  console.log("Stack trace:");
  console.log(error.stack);
  process.exit(0); // Exit cleanly for retry
}
