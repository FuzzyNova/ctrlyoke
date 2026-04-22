#!/usr/bin/env node
// Usage: node forward.js <stdout> <stderr> <exit>
const [, , stdout = "", stderr = "", exit = "0"] = process.argv;

if (stdout) process.stdout.write(stdout + "\n");
if (stderr) process.stderr.write(stderr + "\n");
process.exit(Number(exit));
