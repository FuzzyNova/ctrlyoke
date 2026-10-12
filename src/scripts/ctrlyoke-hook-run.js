#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");

const [envFile, hookId, encodedCommand] = process.argv.slice(2);
if (!envFile || !hookId || !encodedCommand) {
  process.stderr.write("ctrlyoke-hook-run: missing hook arguments\n");
  process.exitCode = 2;
} else {
  try {
    const environments = JSON.parse(fs.readFileSync(envFile, "utf8"));
    const hookEnv = environments[hookId];
    if (!hookEnv || typeof hookEnv !== "object" || Array.isArray(hookEnv)) {
      throw new Error(`No environment found for ${hookId}`);
    }
    const command = Buffer.from(encodedCommand, "base64").toString("utf8");
    const child = spawn(command, {
      cwd: process.cwd(),
      env: { ...process.env, ...hookEnv },
      shell: true,
      stdio: "inherit",
    });
    child.once("error", (error) => {
      process.stderr.write(`ctrlyoke-hook-run: ${error.message}\n`);
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      if (code !== null) {
        process.exitCode = code;
      } else if (signal) {
        process.exitCode = 1;
      }
    });
  } catch (error) {
    process.stderr.write(`ctrlyoke-hook-run: ${error.message}\n`);
    process.exitCode = 1;
  }
}
