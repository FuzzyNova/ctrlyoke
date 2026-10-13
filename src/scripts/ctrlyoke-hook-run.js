#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");

const [envFile, hookId, shellName, encodedCommand] = process.argv.slice(2);
if (!envFile || !hookId || !shellName || !encodedCommand) {
  process.stderr.write("ctrlyoke-hook-run: missing hook arguments\n");
  process.exitCode = 2;
} else {
  try {
    const environments = JSON.parse(fs.readFileSync(envFile, "utf8"));
    const hookEntry = environments[hookId];
    if (
      !hookEntry ||
      typeof hookEntry !== "object" ||
      Array.isArray(hookEntry)
    ) {
      throw new Error(`No environment found for ${hookId}`);
    }
    const hookEnv = hookEntry.env;
    if (!hookEnv || typeof hookEnv !== "object" || Array.isArray(hookEnv)) {
      throw new Error(`No environment found for ${hookId}`);
    }
    const command = Buffer.from(encodedCommand, "base64").toString("utf8");
    const child = spawn(command, {
      cwd: process.cwd(),
      env: { ...process.env, ...hookEnv },
      shell: shellName === "default" ? true : shellName,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    let terminationRequested = false;
    let timeoutTimer;
    let parentPoll;
    const clearWatchers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (parentPoll) clearInterval(parentPoll);
    };
    const killChild = () => {
      terminationRequested = true;
      process.exitCode = 1;
      if (process.platform === "win32") {
        killWindowsProcessTree(child);
      } else {
        killPosixProcessTree(child, "SIGKILL");
      }
    };
    const forwardSignal = (signal) => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      if (process.platform === "win32") {
        killWindowsProcessTree(child);
      } else {
        killPosixProcessTree(child, signal);
      }
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(signal, forwardSignal);
    }
    if (typeof hookEntry.timeoutSec === "number") {
      timeoutTimer = setTimeout(
        killChild,
        Math.max(0, hookEntry.timeoutSec * 1000 - 250)
      );
    }
    parentPoll = setInterval(() => {
      try {
        process.kill(process.ppid, 0);
      } catch (error) {
        if (error.code === "ESRCH") killChild();
      }
    }, 500);
    parentPoll.unref();
    child.once("error", (error) => {
      process.stderr.write(`ctrlyoke-hook-run: ${error.message}\n`);
      process.exitCode = 1;
    });
    child.once("close", clearWatchers);
    child.once("exit", (code, signal) => {
      for (const forwardedSignal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
        process.removeListener(forwardedSignal, forwardSignal);
      }
      if (terminationRequested) {
        process.exitCode = 1;
      } else if (code !== null) {
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

function killWindowsProcessTree(child) {
  if (!child.pid) return;
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", () => child.kill("SIGKILL"));
}

function killPosixProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
