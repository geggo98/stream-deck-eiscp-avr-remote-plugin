/**
 * Tests for the dedicated dial catalog (Stream Deck Plus encoders) and the tone
 * parser they rely on. Pure data/logic only — no SDK import, no action classes.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEDICATED_SPECS,
	dedicatedPropertyInspector,
	type IconSpec,
	type ToggleSpec,
} from "../src/actions/dedicated/catalog.ts";
import { COMMAND_REGISTRY } from "../src/adapter/eiscp/command-registry.ts";
import {
	DIAL_PRESS_ACTIONS,
	parseTone,
	resolveDialPress,
	SUPER_RES_MAX,
	superResLevel,
} from "../src/actions/eiscp-base.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconFile = (name: string) => resolve(ROOT, "node_modules/lucide-static/icons", `${name}.svg`);
const dials = DEDICATED_SPECS.filter((s) => s.kind === "dial");
const paramsOf = (command: string) => new Set((COMMAND_REGISTRY[command]?.values ?? []).map((v) => v.param));

describe("dial catalog", () => {
	it("ships the expected set of dials", () => {
		// A deliberate inventory rather than a count: the checks below all iterate
		// `dials`, so they would pass vacuously if an entry went missing.
		const ids = dials.map((d) => d.id).sort();
		assert.deepEqual(ids, [
			"bass-dial",
			"input-dial",
			"mode-dial",
			"preset-dial",
			"super-res-dial",
			"treble-dial",
			"volume-dial",
		]);
	});

	it("every dial maps to a real command with valid up/down params", () => {
		for (const d of dials) {
			assert.ok(COMMAND_REGISTRY[d.command], `unknown command ${d.command} for ${d.id}`);
			const params = paramsOf(d.command);
			assert.ok(d.upParam && params.has(d.upParam), `${d.id}: up param ${d.upParam} missing from ${d.command}`);
			assert.ok(
				d.downParam && params.has(d.downParam),
				`${d.id}: down param ${d.downParam} missing from ${d.command}`,
			);
		}
	});

	it("every dial press command/param is valid", () => {
		for (const d of dials) {
			const cmd = COMMAND_REGISTRY[d.pressCommand];
			assert.ok(cmd, `unknown press command ${d.pressCommand} for ${d.id}`);
			const toggleValue = cmd.actionType === "toggle" ? cmd.toggleValue : undefined;
			const valid = d.pressParam && (paramsOf(d.pressCommand).has(d.pressParam) || d.pressParam === toggleValue);
			assert.ok(valid, `${d.id}: press param ${d.pressParam} not valid for ${d.pressCommand}`);
		}
	});

	it("uses progress-bar layout for tone, text layout for selectors", () => {
		const layout = (id: string) => dials.find((d) => d.id === id)?.encoderLayout;
		assert.equal(layout("bass-dial"), "$B1");
		assert.equal(layout("treble-dial"), "$B1");
		assert.equal(layout("input-dial"), "$A1");
		assert.equal(layout("mode-dial"), "$A1");
		assert.equal(layout("preset-dial"), "$A1");
	});

	it("has unique ids and existing Lucide icons", () => {
		const seen = new Set<string>();
		for (const s of DEDICATED_SPECS) {
			assert.ok(!seen.has(s.id), `duplicate id ${s.id}`);
			seen.add(s.id);
		}
		for (const d of dials) {
			const icon: IconSpec = d.icon;
			for (const name of [icon.primary, icon.badge, icon.onPrimary].filter(Boolean) as string[]) {
				assert.ok(existsSync(iconFile(name)), `missing Lucide icon "${name}" for ${d.id}`);
			}
		}
	});

	it("routes each dial to the right Property Inspector", () => {
		const pi = (id: string) => dedicatedPropertyInspector(DEDICATED_SPECS.find((s) => s.id === id)!);
		assert.equal(pi("input-dial"), "ui/dial-discover.html"); // discover + press dropdown
		assert.equal(pi("mode-dial"), "ui/dial-discover.html");
		assert.equal(pi("bass-dial"), "ui/dial-press.html"); // press dropdown
		assert.equal(pi("treble-dial"), "ui/dial-press.html");
		assert.equal(pi("preset-dial"), "ui/dedicated.html"); // fixed press (Tuner)
		// Key cyclers still use the plain discover PI (no press dropdown).
		assert.equal(pi("input-next"), "ui/discover.html");
		assert.equal(pi("mode-prev"), "ui/discover.html");
	});
});

describe("4K upscaling key", () => {
	const spec = DEDICATED_SPECS.find((s) => s.id === "upscale-4k");

	it("toggles the two values the receiver actually accepts, not the spec's 4K code", () => {
		assert.ok(spec);
		assert.equal(spec.kind, "toggle");
		// Widened to the interface, the way toggleCfg does it, so the optional
		// toggleValue is reachable on a literal that omits it.
		const toggle: ToggleSpec = spec as ToggleSpec;
		assert.equal(toggle.command, "RES");
		// Measured on a VSX-S520D (2026-08-08): RES 01 is the "1080p -> 4K Upscaling:
		// Auto" menu item (the front panel confirms it with "Upscaling:Auto") and RES
		// 00 is Off. The spec's own 4K value, RES 08, comes back as N/A on that unit
		// — so reading the enumeration and picking 08 gives a key that does nothing.
		assert.equal(toggle.onValue, "01");
		assert.equal(toggle.offValue, "00");
		// No TG in the RES value set, so the base class must take the soft-flip path.
		assert.equal(toggle.toggleValue, undefined);
	});

	it("names both wire values in the registry, so a PI can label them", () => {
		const params = COMMAND_REGISTRY.RES?.values.map((v) => v.param) ?? [];
		assert.ok(params.includes("01"), "RES 01 missing from the registry");
		assert.ok(params.includes("00"), "RES 00 missing from the registry");
	});
});

describe("Super Resolution dial", () => {
	const spec = dials.find((d) => d.id === "super-res-dial");

	it("is a 0-3 stepper with a progress bar, and the registry bounds it at 3", () => {
		assert.ok(spec);
		assert.equal(spec.command, "SPR");
		assert.equal(spec.encoderLayout, "$B1"); // a level, not a selector
		const cmd = COMMAND_REGISTRY.SPR;
		assert.ok(cmd);
		assert.equal(cmd.actionType, "stepper");
		// Without a STEPPER_MAX entry this inherits the default 24 and a 0-3 setting
		// would paint as a bar that never leaves the left eighth.
		assert.equal(cmd.actionType === "stepper" && cmd.maxValue, SUPER_RES_MAX);
	});

	it("presses to switch upscaling on, because that is what makes it work", () => {
		// Measured: with upscaling off, every SPR set comes back `!1SPRN/A`.
		assert.equal(spec?.pressCommand, "RES");
		assert.equal(spec?.pressParam, "01");
	});

	it("emits no concrete values, so nothing invents a spelling for them", () => {
		// The YAML key is the range [0, 3] with the shared name "no-0-3". extractValues
		// skips range keys, so only UP/DOWN survive — which is what keeps
		// formatCommandValue from rendering "no-0-3" as the level.
		const params = (COMMAND_REGISTRY.SPR?.values ?? []).map((v) => v.param).sort();
		assert.deepEqual(params, ["DOWN", "UP"]);
	});
});

describe("superResLevel", () => {
	it("reads the levels the receiver reports", () => {
		assert.equal(superResLevel("00"), 0);
		assert.equal(superResLevel("02"), 2);
		assert.equal(superResLevel("03"), SUPER_RES_MAX);
	});

	it("returns undefined for N/A, which is the receiver saying the setting is dead", () => {
		// Measured: `SPR UP` while 4K upscaling is off answers `!1SPRN/A` and the panel
		// writes "Not Available ". The dial has to show that, not a stale number.
		assert.equal(superResLevel("N/A"), undefined);
	});

	it("refuses values it does not understand rather than clamping them", () => {
		// parseInt would read "2x" as 2 and draw a confident bar for wire data that
		// makes no sense; out-of-range must not be silently pinned to the ends either.
		assert.equal(superResLevel("2x"), undefined);
		assert.equal(superResLevel("04"), undefined);
		assert.equal(superResLevel(""), undefined);
	});
});

describe("resolveDialPress", () => {
	it("maps press-action keys to valid registry commands/params and on-values", () => {
		for (const [key, press] of Object.entries(DIAL_PRESS_ACTIONS)) {
			assert.deepEqual(resolveDialPress(key), press, `roundtrip ${key}`);
			const cmd = COMMAND_REGISTRY[press.command];
			assert.ok(cmd, `unknown command ${press.command} for press "${key}"`);
			const params = new Set(cmd.values.map((v) => v.param));
			const toggleValue = cmd.actionType === "toggle" ? cmd.toggleValue : undefined;
			assert.ok(params.has(press.param) || press.param === toggleValue, `param ${press.param} invalid`);
			// The "on" value must be a real value the command can report.
			assert.ok(params.has(press.on), `on-value ${press.on} not a known ${press.command} value`);
		}
	});
	it("defaults unknown/undefined to mute", () => {
		assert.deepEqual(resolveDialPress(undefined), DIAL_PRESS_ACTIONS.mute);
		assert.deepEqual(resolveDialPress("bogus"), DIAL_PRESS_ACTIONS.mute);
	});
});

describe("parseTone", () => {
	it("parses signed bass/treble from a tone readout", () => {
		assert.deepEqual(parseTone("TFRB+2T-1"), { bass: 2, treble: -1 });
		assert.deepEqual(parseTone("B00T00"), { bass: 0, treble: 0 });
		assert.deepEqual(parseTone("B-AT+A"), { bass: -10, treble: 10 });
		assert.deepEqual(parseTone("B+0T-5"), { bass: 0, treble: -5 });
	});

	it("returns undefined for non-tone strings", () => {
		assert.equal(parseTone("garbage"), undefined);
		assert.equal(parseTone(""), undefined);
		assert.equal(parseTone("23"), undefined);
	});
});
