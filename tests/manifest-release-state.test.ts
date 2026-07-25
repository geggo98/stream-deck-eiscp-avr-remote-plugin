/**
 * Guards the shipped manifest against the two states that break it.
 *
 * `Nodejs.Debug` is the field that made the plugin undebuggable-by-inspection:
 *
 *  - `"enabled"` makes Stream Deck launch the plugin with an open Node inspector
 *    port and flips the SDK to TRACE logging. It must not ship.
 *  - `"disabled"` is worse: Stream Deck refuses to launch the plugin at all. The
 *    process exits with code 1 *before any JavaScript runs*, so the plugin's own
 *    log stays empty and there is nothing to find — it just never appears.
 *
 * The release state is therefore the key being absent, which is also what
 * `streamdeck pack` produces. There is a pre-commit hook and a `pack` gate for
 * this, but both are easy to bypass or miss, and the symptom is expensive to
 * diagnose — so assert it in the normal suite too.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MANIFEST_URL = new URL(
	"../de.schwetschke.sd.eiscp-avr-remote.sdPlugin/manifest.json",
	import.meta.url,
);

const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf-8")) as {
	Nodejs?: { Debug?: unknown; Version?: string };
	CodePath?: string;
};

describe("shipped manifest", () => {
	it("has no Nodejs.Debug key", () => {
		const nodejs = manifest.Nodejs ?? {};
		assert.equal(
			"Debug" in nodejs,
			false,
			`Nodejs.Debug must be absent, found ${JSON.stringify((nodejs as { Debug?: unknown }).Debug)}. ` +
				'"enabled" ships an inspector port; "disabled" stops Stream Deck launching the ' +
				"plugin at all. Run `npm run build` to remove it.",
		);
	});

	it("still targets the Node runtime the code is built for", () => {
		assert.equal(manifest.Nodejs?.Version, "24");
	});

	it("points at the built bundle", () => {
		assert.equal(manifest.CodePath, "bin/plugin.js");
	});
});
