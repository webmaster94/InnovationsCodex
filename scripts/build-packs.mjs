import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compilePack } from "@foundryvtt/foundryvtt-cli";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "pack-src", "college-of-innovation");
const output = path.join(root, "packs", "college-of-innovation");

await rm(output, { recursive: true, force: true });
await compilePack(source, output, { log: true, recursive: true });
