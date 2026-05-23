#!/usr/bin/env node
import { register } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

register();

const here = dirname(fileURLToPath(import.meta.url));
await import(resolve(here, "../src/index.ts"));
