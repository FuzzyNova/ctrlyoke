#!/usr/bin/env node

import { rm } from "node:fs/promises";

await rm("out/test", { recursive: true, force: true });
