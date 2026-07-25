#!/usr/bin/env tsx
/**
 * Derive the manifest's 4-part Version from package.json's SemVer, and set the
 * Node debug mode for the build we are about to produce.
 *
 * package.json (3-part SemVer, e.g. "0.2.0") is the single source of truth and
 * is bumped by release-please. The Stream Deck CLI, however, requires the
 * manifest's `Version` in {major}.{minor}.{patch}.{build} form — so we mirror
 * package.json into the manifest as "{major}.{minor}.{patch}.0" on every build.
 * Any pre-release suffix (e.g. "-rc.1") is dropped, since the manifest format
 * has no place for it.
 *
 * `Nodejs.Debug: "enabled"` makes Stream Deck launch the plugin with an open
 * Node inspector port, which is a local code-execution path into the plugin
 * process, and it flips the SDK to TRACE logging (every WebSocket frame, i.e.
 * complete settings objects and LAN IPs, onto disk). It must therefore never
 * ship. Pass `--debug` (or set SD_DEBUG=1) to turn it on for the local dev
 * loop; `npm run watch` does. Plain `npm run build` always turns it off, and
 * `npm run verify:manifest` fails the build if a release artifact has it on.
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

// A CLI flag rather than only an env var, so `npm run watch` works the same on
// Windows cmd, where `SD_DEBUG=1 tsx …` is not valid syntax.
const debugRequested = process.argv.includes("--debug") || process.env.SD_DEBUG === "1";
const debugMode = debugRequested ? "enabled" : "disabled";

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const changes: string[] = [];

if (manifest.Version !== manifestVersion) {
	manifest.Version = manifestVersion;
	changes.push(`Version → ${manifestVersion} (from package.json ${pkg.version})`);
}

manifest.Nodejs ??= {};
if (manifest.Nodejs.Debug !== debugMode) {
	manifest.Nodejs.Debug = debugMode;
	changes.push(`Nodejs.Debug → ${debugMode}`);
}

if (changes.length === 0) {
	console.log(
		`manifest already in sync (Version ${manifestVersion}, Nodejs.Debug ${debugMode}).`,
	);
} else {
	writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
	console.log(`Synced manifest: ${changes.join(", ")}.`);
}

if (debugRequested) {
	console.warn(
		"WARNING: Nodejs.Debug is enabled — this opens a Node inspector port and " +
			"logs at TRACE. Do not commit or pack this manifest; `npm run build` resets it.",
	);
}
