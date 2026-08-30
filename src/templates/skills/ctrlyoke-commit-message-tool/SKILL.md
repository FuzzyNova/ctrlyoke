---
name: ctrlyoke-commit-message-tool
description: Use when MCP config is disabled by policy and you need to submit a generated commit message to ctrlyoke.
---

# ctrlyoke commit-message tool

ctrlyoke uses a structured tool submission to capture the complete commit message without parsing the harness response as prose. When MCP configuration is disabled by policy, run the commit-message tool through ctrlyoke's CLI entrypoint.

Pass the commit output path as an explicit `--commit-output` argument. Do not rely on environment inheritance into the spawned process.
