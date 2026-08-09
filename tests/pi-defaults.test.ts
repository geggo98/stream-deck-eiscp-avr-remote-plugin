/**
 * Property Inspector controls must agree with the code's own defaults.
 *
 * A panel that shows one number while the plugin renders another is worse than a wrong
 * default: the user reads the value, changes nothing, and the key still looks different
 * from what the slider claims. The Now Playing key had exactly that — the darkening
 * slider declared `0.4` on a `0.1` grid while `DEFAULT_SCRIM` is `0.45`, so the panel
 * was wrong *and* the value it described could not even be selected. Touching the
 * slider then visibly changed a picture the user had not meant to change.
 *
 * Checked by reading the shipped HTML rather than by convention, because the two live in
 * different languages and nothing else connects them.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DEFAULT_SCRIM, MAX_SCRIM, MIN_SCRIM } from "../src/actions/cover-image.ts";
import { keepFacesWhole, readoutEnabled, readoutKeepsCover } from "../src/actions/np-dial-settings.ts";

const UI_DIR = fileURLToPath(new URL("../de.schwetschke.sd.eiscp-avr-remote.sdPlugin/ui/", import.meta.url));

interface RangeControl {
	file: string;
	setting: string;
	min: number;
	max: number;
	step: number;
	default: number;
}

/** Every `<sdpi-range>` in every Property Inspector, with its numeric attributes. */
function rangeControls(): RangeControl[] {
	const out: RangeControl[] = [];
	for (const file of readdirSync(UI_DIR).filter((f) => f.endsWith(".html"))) {
		const html = readFileSync(`${UI_DIR}${file}`, "utf8");
		for (const tag of html.matchAll(/<sdpi-range\b[^>]*>/g)) {
			const attr = (name: string): string | undefined =>
				new RegExp(`${name}="([^"]*)"`).exec(tag[0])?.[1];
			const setting = attr("setting");
			if (!setting) continue;
			out.push({
				file,
				setting,
				min: Number(attr("min")),
				max: Number(attr("max")),
				step: Number(attr("step")),
				default: Number(attr("default")),
			});
		}
	}
	return out;
}

/** Every `<sdpi-checkbox>` in every Property Inspector, with the default it declares. */
function checkboxControls(): { file: string; setting: string; default: boolean }[] {
	const out: { file: string; setting: string; default: boolean }[] = [];
	for (const file of readdirSync(UI_DIR).filter((f) => f.endsWith(".html"))) {
		const html = readFileSync(`${UI_DIR}${file}`, "utf8");
		// The tag is written across two lines in these panels, so the match has to span
		// newlines — a single-line pattern would find nothing and quietly pass.
		for (const tag of html.matchAll(/<sdpi-checkbox\b[^>]*>/gs)) {
			const setting = /setting="([^"]*)"/.exec(tag[0])?.[1];
			if (!setting) continue;
			out.push({ file, setting, default: /default="true"/.test(tag[0]) });
		}
	}
	return out;
}

const ranges = rangeControls();

describe("what a Property Inspector slider promises", () => {
	it("finds the sliders at all, so this cannot pass by scanning nothing", () => {
		assert.ok(ranges.length >= 3, `expected several sdpi-range controls, found ${ranges.length}`);
	});

	it("declares a default the slider can actually produce", () => {
		// A default off the step grid is a value the user can look at but never choose,
		// so the first drag of the handle is a change they did not ask for.
		for (const range of ranges) {
			const steps = (range.default - range.min) / range.step;
			assert.ok(
				Math.abs(steps - Math.round(steps)) < 1e-9,
				`${range.file}: ${range.setting} defaults to ${range.default}, which is not on a ${range.step} grid from ${range.min}`,
			);
			assert.ok(range.default >= range.min && range.default <= range.max, `${range.file}: ${range.setting}`);
		}
	});

	it("ticks the boxes the plugin behaves as though were ticked", () => {
		// A checkbox resolved with `!== false` is on for a freshly placed action, because
		// nothing is stored yet. If the panel showed it unticked, the user would see a
		// feature described as off while it was running — and ticking it to "turn it on"
		// would change nothing, which reads as a broken control.
		const resolvers: Record<string, (settings: undefined) => boolean> = {
			showActionFeedback: readoutEnabled,
			actionOverCover: readoutKeepsCover,
			keepFacesWhole,
		};
		const boxes = checkboxControls().filter((box) => box.setting in resolvers);
		assert.equal(boxes.length, Object.keys(resolvers).length, `found ${boxes.map((b) => b.setting).join(", ")}`);
		for (const box of boxes) {
			assert.equal(
				box.default,
				resolvers[box.setting]!(undefined),
				`${box.file}: ${box.setting} defaults to ${box.default} in the panel`,
			);
		}
	});

	it("shows the darkening the plugin would apply on its own", () => {
		// `scrimFor` falls back to DEFAULT_SCRIM when nothing is stored — which is the
		// normal state of a freshly placed key — so that is the number the panel has to
		// show, not a rounder one.
		const scrims = ranges.filter((r) => r.setting === "scrimOpacity");
		assert.ok(scrims.length >= 2, "both the Now Playing key and dial offer it");
		for (const range of scrims) {
			assert.equal(range.default, DEFAULT_SCRIM, `${range.file} disagrees with DEFAULT_SCRIM`);
			assert.equal(range.min, MIN_SCRIM, `${range.file}`);
			assert.equal(range.max, MAX_SCRIM, `${range.file}`);
		}
	});
});
