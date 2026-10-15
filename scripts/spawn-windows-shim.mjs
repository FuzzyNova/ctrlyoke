#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";

const WINDOWS_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(value) {
  return String(value).replace(WINDOWS_META_CHARS, "^$1");
}

function escapeArgument(value) {
  let argument = String(value);
  argument = argument.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  argument = argument.replace(/(?=(\\+?)?)\1$/g, "$1$1");
  return `"${argument}"`.replace(WINDOWS_META_CHARS, "^$1");
}

export function buildWindowsCommandLine(command, args = []) {
  return [escapeCommand(command), ...args.map(escapeArgument)].join(" ");
}

function buildSpawnInvocation(command, args, options) {
  if (process.platform !== "win32") {
    return { command, args, options: { ...options, shell: false } };
  }

  const commandLine = buildWindowsCommandLine(command, args);
  return {
    command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    options: { ...options, shell: false, windowsVerbatimArguments: true },
  };
}

export function spawnShim(command, args = [], options = {}) {
  const invocation = buildSpawnInvocation(command, args, options);
  return spawn(invocation.command, invocation.args, invocation.options);
}

export function spawnShimSync(command, args = [], options = {}) {
  const invocation = buildSpawnInvocation(command, args, options);
  return spawnSync(invocation.command, invocation.args, invocation.options);
}
