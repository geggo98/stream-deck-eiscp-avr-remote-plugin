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
 * `npm run build` already removes the flag via sync-manifest-version.ts. This
 * script is the backstop for the two ways it could still escape: someone
 * committing a manifest left over from `npm run watch`, and `npm run pack`
 * being run without a preceding build. Wired into `pack`, into CI, and into a
 * pre-commit hook (devenv.nix).
 *
 * The release state is the key being **absent**. It is not `"disabled"`: Stream
 * Deck refuses to launch a plugin with `Nodejs.Debug: "disabled"` — the process
 * exits with code 1 before any JS runs, so the plugin simply never appears and
 * its own log stays empty. `streamdeck pack` strips the key for the same reason.
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

if (manifest.Nodejs && "Debug" in manifest.Nodejs) {
	console.error(
		`ERROR: manifest has Nodejs.Debug: ${JSON.stringify(manifest.Nodejs.Debug)}; it must be absent.\n` +
			'"enabled" opens an inspector port in production and logs settings and LAN IPs\n' +
			'at TRACE. "disabled" is worse than useless: Stream Deck then refuses to launch\n' +
			"the plugin at all (exit code 1 before any JS runs).\n" +
			"Run `npm run build` to remove the key, then retry.",
	);
	process.exit(1);
}

console.log("manifest has no Nodejs.Debug key — safe to release.");
