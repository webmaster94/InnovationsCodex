import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "module.json"), "utf8"));

const MODULE_ID = "innovations-codex";
const MANIFEST_URL = "https://github.com/webmaster94/InnovationsCodex/releases/latest/download/module.json";
const RELEASE_ROOT_FILES = new Set(["module.json", "README.md", "CHANGELOG.md"]);
const RELEASE_DIRECTORIES = new Set(["dist", "packs", "styles", "templates"]);
const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".github",
  "__tests__",
  "internal",
  "node_modules",
  "notes",
  "pack-src",
  "scripts",
  "src",
  "test",
  "tests"
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeArchivePath(entryName) {
  return entryName.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function assertAllowedArchiveEntry(entry) {
  const entryPath = normalizeArchivePath(entry.entryName);
  const segments = entryPath.split("/").filter(Boolean);
  assert(segments.length > 0, "The release ZIP contains an empty path.");
  assert(!entryPath.startsWith("/"), `The release ZIP contains an absolute path: ${entryPath}`);
  assert(!segments.includes(".."), `The release ZIP contains a parent traversal: ${entryPath}`);

  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const forbiddenSegment = lowerSegments.find((segment) => FORBIDDEN_SEGMENTS.has(segment));
  assert(!forbiddenSegment, `The release ZIP contains a forbidden path: ${entryPath}`);

  const basename = lowerSegments.at(-1);
  assert(
    !/(^|[._-])(internal|notes?|spec|tests?)([._-]|$)/.test(basename),
    `The release ZIP contains a test or internal-note file: ${entryPath}`
  );

  const rootEntry = segments[0];
  if (segments.length === 1 && !entry.isDirectory) {
    assert(RELEASE_ROOT_FILES.has(rootEntry), `The release ZIP contains an unexpected root file: ${entryPath}`);
    return;
  }

  assert(RELEASE_DIRECTORIES.has(rootEntry), `The release ZIP contains an unexpected directory: ${entryPath}`);
  if (entry.isDirectory) return;

  const extensionRules = {
    dist: /\.js(?:\.map)?$/i,
    styles: /\.css$/i,
    templates: /\.(?:hbs|html)$/i
  };
  const rule = extensionRules[rootEntry];
  if (rule) assert(rule.test(entryPath), `The release ZIP contains an unexpected ${rootEntry} file: ${entryPath}`);

  if (rootEntry === "packs") {
    assert(!/\.(?:json|md|txt|ts|tsx)$/i.test(entryPath), `The release ZIP contains pack source or notes: ${entryPath}`);
  }
}

assert(manifest.id === MODULE_ID, "Unexpected module id.");
assert(manifest.manifest === MANIFEST_URL, "The manifest URL does not point to the latest GitHub release asset.");
assert(
  manifest.download === `https://github.com/webmaster94/InnovationsCodex/releases/download/v${manifest.version}/innovations-codex.zip`,
  "The download URL does not match the manifest version."
);
assert(
  manifest.compatibility?.minimum === "13.347" && manifest.compatibility?.maximum === "14",
  "Foundry compatibility must cover only the supported v13/v14 range."
);
assert(manifest.compatibility?.verified === "14", "Foundry verified compatibility must be v14.");

const dnd5e = manifest.relationships?.systems?.find((system) => system.id === "dnd5e");
assert(dnd5e?.compatibility?.minimum === "5.2.5", "dnd5e minimum must be 5.2.5.");
assert(dnd5e?.compatibility?.verified === "5.3.3", "dnd5e verified compatibility must be 5.3.3.");

if (process.env.GITHUB_REF_TYPE === "tag") {
  assert(process.env.GITHUB_REF_NAME === `v${manifest.version}`, "The Git tag does not match the manifest version.");
}

for (const file of [...manifest.esmodules, ...manifest.styles.map((style) => style.src ?? style)]) {
  await access(path.join(root, file));
}
await access(path.join(root, "templates", "innovations-codex.hbs"));
for (const pack of manifest.packs ?? []) await access(path.join(root, pack.path, "CURRENT"));

if (process.argv.includes("--release")) {
  const releaseDirectory = path.join(root, "release");
  const zipPath = path.join(releaseDirectory, `${MODULE_ID}.zip`);
  const releaseManifestPath = path.join(releaseDirectory, "module.json");
  const releaseManifestText = await readFile(releaseManifestPath, "utf8");
  const releaseManifest = JSON.parse(releaseManifestText);
  assert(JSON.stringify(releaseManifest) === JSON.stringify(manifest), "The release manifest differs from the source manifest.");

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  assert(entries.length > 0, "The release ZIP is empty.");
  for (const entry of entries) assertAllowedArchiveEntry(entry);

  const archivePaths = new Set(entries.map((entry) => normalizeArchivePath(entry.entryName)));
  for (const requiredFile of RELEASE_ROOT_FILES) {
    assert(archivePaths.has(requiredFile), `The release ZIP is missing ${requiredFile}.`);
  }
  for (const file of manifest.esmodules) {
    assert(archivePaths.has(file), `The release ZIP is missing ${file}.`);
  }
  for (const style of manifest.styles.map((value) => value.src ?? value)) {
    assert(archivePaths.has(style), `The release ZIP is missing ${style}.`);
  }
  for (const pack of manifest.packs ?? []) {
    assert(archivePaths.has(`${pack.path}/CURRENT`), `The release ZIP is missing ${pack.path}/CURRENT.`);
  }

  const archiveManifest = JSON.parse(zip.readAsText("module.json"));
  assert(JSON.stringify(archiveManifest) === JSON.stringify(manifest), "The manifest inside the ZIP differs from the source manifest.");
}
