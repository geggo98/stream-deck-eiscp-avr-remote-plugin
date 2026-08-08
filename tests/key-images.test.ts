/**
 * Every key image the plugin can ask for at runtime has to exist on disk.
 *
 * `setImage` takes a path; a name that does not resolve leaves the key blank with
 * nothing in any log. The generator (`npm run generate:icons`) and the runtime
 * (`keyImageFor`) share the naming rule via `keyImagePath`, and this checks that
 * the files behind it were actually generated and committed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	DEDICATED_SPECS,
	GENERIC_SPECS,
	type IconSpec,
	keyImagePath,
	onStateColor,
} from "../src/actions/dedicated/catalog.ts";
import { generateColoredBg, keyImageFor } from "../src/actions/eiscp-base.ts";

const PLUGIN_DIR = resolve(
	import.meta.dirname,
	"../de.schwetschke.sd.eiscp-avr-remote.sdPlugin",
);

const fileFor = (relative: string): string => resolve(PLUGIN_DIR, relative);
const fillOf = (svg: string): string => /fill="([^"]+)"/.exec(svg)?.[1] ?? "";

describe("key image variants", () => {
	it("ships a lit and a dim image for every action", () => {
		const missing: string[] = [];
		for (const spec of [...DEDICATED_SPECS, ...GENERIC_SPECS]) {
			for (const dim of [false, true]) {
				const path = keyImagePath(spec.id, false, dim);
				if (!existsSync(fileFor(path))) missing.push(path);
			}
		}
		assert.deepEqual(missing, [], "run npm run generate:icons");
	});

	it("ships both ON images for everything that shows a distinct ON look", () => {
		// Two-state keys need them for their manifest States. A dial has one manifest
		// state but can still put two looks on its touch strip — the Super Resolution
		// dial shows the receiver's upscaling state the way the 4K key does — and it
		// asks for the file by path at render time, so a missing one is a blank icon
		// rather than an error. Declaring `onPrimary` is the opt-in on both sides.
		// The generic actions paint their ON state with a generated background and
		// have no -on file at all, so they must not be asked for one.
		const missing: string[] = [];
		for (const spec of DEDICATED_SPECS) {
			const icon: IconSpec = spec.icon;
			if (spec.states !== 2 && !icon.onPrimary) continue;
			for (const dim of [false, true]) {
				const path = keyImagePath(spec.id, true, dim);
				if (!existsSync(fileFor(path))) missing.push(path);
			}
		}
		assert.deepEqual(missing, [], "run npm run generate:icons");
	});

	it("gives the Super Resolution dial the two looks its strip switches between", () => {
		// Guards the pair end to end: the catalog declares onPrimary, the generator
		// emits the ON files for a one-state action because of it, and buildFeedback
		// hands setFeedback these exact paths.
		const spec = DEDICATED_SPECS.find((s) => s.id === "super-res-dial");
		const icon: IconSpec | undefined = spec?.icon;
		assert.equal(icon?.primary, "monitor");
		assert.equal(icon?.onPrimary, "image-upscale");
		for (const on of [false, true]) {
			const path = keyImagePath("super-res-dial", on, false);
			assert.ok(existsSync(fileFor(path)), `missing ${path}`);
		}
	});

	it("resolves what keyImageFor actually returns", () => {
		// The end-to-end check: the runtime's path, for a real action UUID.
		const uuid = "de.schwetschke.sd.eiscp-avr-remote.volume-dial";
		const path = keyImageFor(uuid, "standby", "MVL", 0);
		assert.ok(path, "standby has a dim variant");
		assert.ok(existsSync(fileFor(path)), `${path} exists`);
	});

	it("dims a generated background exactly like the generated files", () => {
		// Two independent implementations of the same rule (scripts/generate-icons.ts
		// for the files, eiscp-base.ts for the runtime background). If they drift, a
		// dimmed generic toggle stops matching the dimmed dedicated keys next to it.
		const generated = readFileSync(fileFor(keyImagePath("mute", true, true)), "utf-8");
		const runtime = generateColoredBg(onStateColor("AMT"), "standby", "AMT");
		const runtimeSvg = Buffer.from(runtime.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf-8");
		assert.equal(fillOf(runtimeSvg), fillOf(generated));
	});
});
