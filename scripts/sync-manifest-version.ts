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
 * loop; `npm run watch` does. Plain `npm run build` removes it again, and
 * `npm run verify:manifest` fails the build if a release artifact still has it.
 *
 * Note the off state is the key being **absent**, not `"disabled"`: Stream Deck
 * refuses to launch a plugin whose `Nodejs.Debug` is `"disabled"` (it exits
 * immediately with code 1, before any JS runs, so nothing is logged), and
 * `streamdeck pack` likewise strips the key rather than writing a value.
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

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const changes: string[] = [];

if (manifest.Version !== manifestVersion) {
	manifest.Version = manifestVersion;
	changes.push(`Version → ${manifestVersion} (from package.json ${pkg.version})`);
}

manifest.Nodejs ??= {};
if (debugRequested) {
	if (manifest.Nodejs.Debug !== "enabled") {
		manifest.Nodejs.Debug = "enabled";
		changes.push('Nodejs.Debug → "enabled"');
	}
} else if ("Debug" in manifest.Nodejs) {
	// Remove rather than set "disabled": Stream Deck refuses to launch a plugin
	// whose Nodejs.Debug is "disabled" (the process exits with code 1 before any
	// JS runs, so nothing appears in the plugin's own log — it just looks dead).
	delete manifest.Nodejs.Debug;
	changes.push("Nodejs.Debug removed");
}

if (changes.length === 0) {
	console.log(
		`manifest already in sync (Version ${manifestVersion}, Nodejs.Debug ${debugRequested ? '"enabled"' : "absent"}).`,
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
