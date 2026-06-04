#!/usr/bin/env tsx
/**
 * Derive the manifest's 4-part Version from package.json's SemVer.
 *
 * package.json (3-part SemVer, e.g. "0.2.0") is the single source of truth and
 * is bumped by release-please. The Stream Deck CLI, however, requires the
 * manifest's `Version` in {major}.{minor}.{patch}.{build} form — so we mirror
 * package.json into the manifest as "{major}.{minor}.{patch}.0" on every build.
 * Any pre-release suffix (e.g. "-rc.1") is dropped, since the manifest format
 * has no place for it.
 *
 * Runs as the first step of `npm run build` (chained directly, so a global
 * `ignore-scripts` can't silently skip it); also available as `npm run sync:version`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = resolve(
	PROJECT_ROOT,
	"de.schwetschke.sd.eiscp-avr-remote.sdPlugin/manifest.json",
);

const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8"));
const [major, minor, patch] = String(pkg.version).split(/[.+-]/);
const manifestVersion = `${major}.${minor}.${patch}.0`;

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
if (manifest.Version === manifestVersion) {
	console.log(`manifest Version already ${manifestVersion} (package.json ${pkg.version}).`);
} else {
	manifest.Version = manifestVersion;
	writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
	console.log(`Synced manifest Version → ${manifestVersion} (from package.json ${pkg.version}).`);
}
