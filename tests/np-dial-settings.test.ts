/**
 * What a Now Playing dial does before anyone configures it, and what user JSON can do to it.
 *
 * These defaults are the dial's whole premise — it is the one dial that must work the
 * moment it is dropped on a deck, because its job is the display rather than the command.
 * They are also where a real defect sat: the press parameter defaulted only while the
 * press *command* was untouched, so choosing a command silently disarmed the press while
 * the Property Inspector went on showing "Toggle (TG)". Nothing could test it, because it
 * lived in a class that imports the Stream Deck SDK; the logic is out here now.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_SCRIM, MAX_SCRIM } from "../src/actions/cover-image.ts";
import {
	DEFAULT_ACTION_SECONDS,
	MAX_ACTION_SECONDS,
	MIN_ACTION_SECONDS,
	npDialConfig,
	readoutEnabled,
	readoutKeepsCover,
	readoutSeconds,
	scrimFor,
	type NowPlayingDialSettings,
} from "../src/actions/np-dial-settings.ts";

describe("what an unconfigured Now Playing dial does", () => {
	it("turns the volume and mutes on a press", () => {
		const cfg = npDialConfig({});
		assert.equal(cfg.command, "MVL");
		assert.equal(cfg.upParam, "UP");
		assert.equal(cfg.downParam, "DOWN");
		assert.equal(cfg.pressCommand, "AMT");
		assert.equal(cfg.pressParam, "TG");
	});

	it("never returns undefined, unlike every other dial", () => {
		// The base stops a bind before it draws anything when the config is undefined.
		// For a dial whose job IS the drawing, that would be a permanently blank strip.
		for (const settings of [{}, { command: "" }, { command: undefined }] as NowPlayingDialSettings[]) {
			assert.ok(npDialConfig(settings).command, JSON.stringify(settings));
		}
	});

	it("keeps the press armed when only the press command is changed", () => {
		// The defect: `pressParam` used to default only while `pressCommand` was unset, so
		// choosing one left the parameter undefined. `onDialDown` then logged a warning and
		// did nothing, while the panel still read "Toggle (TG)" and the dial still flashed
		// its readout — a press that looked like it worked and did not.
		const cfg = npDialConfig({ pressCommand: "PWR" });
		assert.equal(cfg.pressCommand, "PWR");
		assert.equal(cfg.pressParam, "TG", "the panel promises TG, so TG is what is sent");
	});

	it("lets an explicit choice win over both defaults", () => {
		const cfg = npDialConfig({ pressCommand: "SLI", pressParam: "10" });
		assert.equal(cfg.pressCommand, "SLI");
		assert.equal(cfg.pressParam, "10");
	});

	it("honours the custom parameter fields", () => {
		const cfg = npDialConfig({
			upParam: "custom",
			customUpParam: "01",
			pressParam: "custom",
			customPressParam: "FF",
		});
		assert.equal(cfg.upParam, "01");
		assert.equal(cfg.pressParam, "FF");
	});
});

describe("settings that arrive as untyped JSON", () => {
	it("resolves nonsense durations rather than passing NaN to setTimeout", () => {
		// A setTimeout(NaN) fires immediately, so the readout would flicker instead of
		// showing — the same failure the track-change duration was hardened against.
		for (const bad of [undefined, null, "", "abc", NaN, Infinity, {}, []] as unknown[]) {
			const value = readoutSeconds({ seconds: bad } as NowPlayingDialSettings);
			assert.ok(Number.isInteger(value) && value >= MIN_ACTION_SECONDS, `${JSON.stringify(bad)} -> ${value}`);
		}
		assert.equal(readoutSeconds(undefined), DEFAULT_ACTION_SECONDS);
		assert.equal(readoutSeconds({}), DEFAULT_ACTION_SECONDS);
	});

	it("clamps a duration to the range the panel offers", () => {
		assert.equal(readoutSeconds({ seconds: -5 } as NowPlayingDialSettings), MIN_ACTION_SECONDS);
		assert.equal(readoutSeconds({ seconds: 9999 } as NowPlayingDialSettings), MAX_ACTION_SECONDS);
		assert.equal(readoutSeconds({ seconds: 3.4 } as NowPlayingDialSettings), 3);
	});

	it("clamps the scrim, and falls back rather than darkening to nothing", () => {
		assert.equal(scrimFor(undefined), DEFAULT_SCRIM);
		assert.equal(scrimFor({}), DEFAULT_SCRIM);
		assert.equal(scrimFor({ scrimOpacity: 5 } as NowPlayingDialSettings), MAX_SCRIM);
		assert.equal(scrimFor({ scrimOpacity: -1 } as NowPlayingDialSettings), 0);
		// 0 is a legitimate choice — an undimmed cover — and must survive the fallback.
		assert.equal(scrimFor({ scrimOpacity: 0 } as NowPlayingDialSettings), 0);
	});

	it("treats both switches as on until they are explicitly turned off", () => {
		// The Property Inspector declares default="true" and never writes the setting
		// until it is touched, so "absent" has to mean on in the code as well — the panel
		// showing a ticked box for something switched off would be the worse failure.
		for (const settings of [undefined, {}, { showActionFeedback: undefined }] as (NowPlayingDialSettings | undefined)[]) {
			assert.equal(readoutEnabled(settings), true, JSON.stringify(settings));
			assert.equal(readoutKeepsCover(settings), true, JSON.stringify(settings));
		}
		assert.equal(readoutEnabled({ showActionFeedback: false }), false);
		assert.equal(readoutKeepsCover({ actionOverCover: false }), false);
	});
});
