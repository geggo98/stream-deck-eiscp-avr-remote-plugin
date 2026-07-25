#!/usr/bin/env tsx
/**
 * Refuse to ship a manifest that has the Node inspector switched on.
 *
 * `Nodejs.Debug: "enabled"` makes Stream Deck launch the plugin with an open
 * inspector port — any local process that reaches it gets code execution inside
 * the plugin — and flips the SDK to TRACE logging, which writes every WebSocket
 * frame (complete settings objects, LAN IPs, the whole learned-name map) into
 * up to 10x50 MB of plaintext log files. It is useful in the dev loop and must
 * never reach a user.
 *
 * `npm run build` already resets the flag via sync-manifest-version.ts. This
 * script is the backstop for the two ways it could still escape: someone
 * committing a manifest left over from `npm run watch`, and `npm run pack`
 * being run without a preceding build. Wired into `pack`, into CI, and into a
 * pre-commit hook (devenv.nix).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = resolve(
	PROJECT_ROOT,
	"de.schwetschke.sd.eiscp-avr-remote.sdPlugin/manifest.json",
);

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const debugMode = manifest.Nodejs?.Debug;

if (debugMode !== "disabled") {
	console.error(
		`ERROR: manifest Nodejs.Debug is ${JSON.stringify(debugMode)}, expected "disabled".\n` +
			"An enabled Node debug mode opens an inspector port in production and logs\n" +
			"settings and LAN IPs at TRACE. Run `npm run build` to reset it, then retry.",
	);
	process.exit(1);
}

console.log('manifest Nodejs.Debug is "disabled" — safe to release.');
