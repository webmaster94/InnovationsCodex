import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const stage = path.join(release, "innovations-codex");

async function runBuildScript(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", script)], {
      cwd: root,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${script} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

await runBuildScript("build.mjs");
await runBuildScript("build-packs.mjs");

await rm(release, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

for (const entry of ["module.json", "README.md", "CHANGELOG.md", "dist", "packs", "styles", "templates"]) {
  await cp(path.join(root, entry), path.join(stage, entry), { recursive: true });
}

const zip = new AdmZip();
zip.addLocalFolder(stage);
zip.writeZip(path.join(release, "innovations-codex.zip"));
await writeFile(path.join(release, "module.json"), await readFile(path.join(root, "module.json")));
