/**
 * Reading a setting's state off the front panel.
 *
 * The interesting half of this suite is negative, and it is data-driven: every
 * display text ever recorded from the reference unit is replayed through the
 * parser, and none of them may produce a state. That corpus is where the danger
 * actually lives — the same display carries input readouts, mode names, volume
 * changes and scrolling track titles, and reading state out of it carelessly is
 * how an input came to be called "Bass : +".
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseFldLevel,
	parseFldState,
	type FldLevelAnchor,
	type FldStateAnchor,
} from "../src/actions/dedicated/fld-state.ts";
import {
	DEDICATED_SPECS,
	type DedicatedSpec,
	type DialSpec,
	type ToggleSpec,
} from "../src/actions/dedicated/catalog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The anchor actually shipped, so the suite tests the product and not a fiction. */
const UPSCALING: FldStateAnchor = (DEDICATED_SPECS as readonly DedicatedSpec[])
	.filter((s): s is ToggleSpec => s.kind === "toggle")
	.find((s) => s.id === "upscale-4k")!.fldState!;

/** Every FLD payload in every recorded fixture, decoded the way the plugin does. */
function recordedDisplayTexts(): string[] {
	const dir = resolve(ROOT, "tests/fixtures");
	const texts = new Set<string>();
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		const raw = readFileSync(resolve(dir, file), "utf-8");
		for (const [, hex] of raw.matchAll(/!1FLD([0-9A-Fa-f]+)/g)) {
			if (!hex || hex.length % 2) continue;
			texts.add(Buffer.from(hex, "hex").toString("ascii").trim());
		}
	}
	return [...texts];
}

describe("parseFldState", () => {
	it("reads the two readouts the receiver actually prints", () => {
		// Measured on a VSX-S520D, 2026-08-08. "Off " carries a trailing space on the
		// wire; decodeDisplayText trims it before this sees it, so both forms are here.
		assert.equal(parseFldState("Upscaling:Auto", UPSCALING), "on");
		assert.equal(parseFldState("Upscaling:Off", UPSCALING), "off");
		assert.equal(parseFldState("Upscaling:Off ", UPSCALING), "off");
	});

	it("ignores the label's own padding and case", () => {
		// The panel right-pads inside the label: "Super Res   :2" is the measured shape.
		assert.equal(parseFldState("upscaling : auto", UPSCALING), "on");
		assert.equal(parseFldState("UPSCALING:OFF", UPSCALING), "off");
	});

	it("says nothing about a setting it was not asked about", () => {
		// The Super Resolution readout is the same shape and the same panel.
		assert.equal(parseFldState("Super Res   :2", UPSCALING), undefined);
		assert.equal(parseFldState("Direct:Off", UPSCALING), undefined);
		assert.equal(parseFldState("Music Optimizer:Off", UPSCALING), undefined);
	});

	it("refuses a matching label whose state word it does not know", () => {
		// The user's rule: only act when the state is actually shown. A firmware that
		// words it differently must leave the key exactly as it is, not guess.
		assert.equal(parseFldState("Upscaling:Ein bisschen", UPSCALING), undefined);
		assert.equal(parseFldState("Upscaling:", UPSCALING), undefined);
		assert.equal(parseFldState("Upscaling", UPSCALING), undefined);
	});

	it("takes on/off in either menu language, but only as whole words", () => {
		const anchor: FldStateAnchor = { label: "Thing" };
		assert.equal(parseFldState("Thing:On", anchor), "on");
		assert.equal(parseFldState("Thing:An", anchor), "on");
		assert.equal(parseFldState("Thing:Aus", anchor), "off");
		// "Auto" is not generically boolean — it means "on" only where a spec says so.
		assert.equal(parseFldState("Thing:Auto", anchor), undefined);
	});

	it("bounds both halves rather than working on whatever arrives", () => {
		assert.equal(parseFldState(`${"U".repeat(40)}:Off`, { label: "U".repeat(40) }), undefined);
		assert.equal(parseFldState(`Upscaling:${"f".repeat(40)}`, UPSCALING), undefined);
	});

	it("finds no state in any display text ever recorded from the receiver", () => {
		// The load-bearing one. Includes " DTS Neural:X " — the only recorded text with
		// a colon at all, and a listening-mode name rather than a setting.
		const texts = recordedDisplayTexts();
		assert.ok(texts.length > 20, `expected the recorded corpus, found ${texts.length} texts`);
		assert.ok(texts.some((t) => t.includes(":")), "corpus should contain the colon-bearing mode name");
		for (const text of texts) {
			assert.equal(parseFldState(text, UPSCALING), undefined, `misread ${JSON.stringify(text)} as a state`);
		}
	});
});

describe("parseFldLevel", () => {
	const SUPER_RES: FldLevelAnchor = (DEDICATED_SPECS as readonly DedicatedSpec[])
		.filter((s): s is DialSpec => s.kind === "dial")
		.find((s) => s.id === "super-res-dial")!.fldValue!;

	it("reads the level the receiver prints", () => {
		// Measured: "Super Res   :2", padding inside the label and all.
		assert.equal(parseFldLevel("Super Res   :2", SUPER_RES), 2);
		assert.equal(parseFldLevel("Super Res : 0", SUPER_RES), 0);
		assert.equal(parseFldLevel("Super Res:3", SUPER_RES), 3);
	});

	it("refuses a level outside the setting's own range rather than clamping", () => {
		assert.equal(parseFldLevel("Super Res   :4", SUPER_RES), undefined);
		assert.equal(parseFldLevel("Super Res   :99", SUPER_RES), undefined);
	});

	it("reads the receiver's two spellings of the same zero", () => {
		// Measured, and the discrepancy is the receiver's: `SPR 00` sent over the
		// protocol prints "Super Res   :0", while switching it off in the receiver's
		// own menu prints "Super Res   :Off". Four wire values for the menu's
		// Off/1/2/3 leaves no room for those to be different states.
		assert.equal(parseFldLevel("Super Res   :0", SUPER_RES), 0);
		assert.equal(parseFldLevel("Super Res   :Off", SUPER_RES), 0);
		assert.equal(parseFldLevel("Super Res :Aus", SUPER_RES), 0);
	});

	it("refuses anything that is neither a number nor an off word", () => {
		assert.equal(parseFldLevel("Super Res   :Auto", SUPER_RES), undefined);
		assert.equal(parseFldLevel("Super Res   :", SUPER_RES), undefined);
	});

	it("does not read a level out of another setting's readout", () => {
		// The trap this anchoring exists for: the input readout is a name beside a
		// NUMBER, and "CBL/SAT      2" means volume 2, not super resolution 2.
		assert.equal(parseFldLevel("CBL/SAT      2", SUPER_RES), undefined);
		assert.equal(parseFldLevel("Upscaling:Off", SUPER_RES), undefined);
	});

	it("finds no level in any display text ever recorded from the receiver", () => {
		for (const text of recordedDisplayTexts()) {
			assert.equal(parseFldLevel(text, SUPER_RES), undefined, `misread ${JSON.stringify(text)} as a level`);
		}
	});
});

describe("fldState anchors in the catalog", () => {
	const toggles = (DEDICATED_SPECS as readonly DedicatedSpec[]).filter((s): s is ToggleSpec => s.kind === "toggle");

	it("only carries one where the receiver refuses to report the state", () => {
		// PWR and AMT broadcast properly. A second source of truth for them could only
		// ever disagree with the first, so an anchor there would be a liability.
		const anchored = toggles.filter((s) => s.fldState).map((s) => s.id);
		assert.deepEqual(anchored, ["upscale-4k"]);
	});

	it("maps every anchor's states onto that toggle's own wire values", () => {
		for (const spec of toggles.filter((s) => s.fldState)) {
			assert.ok(spec.onValue, `${spec.id} has an anchor but no onValue`);
			assert.ok(spec.offValue, `${spec.id} has an anchor but no offValue`);
			assert.equal(parseFldState(`${spec.fldState!.label}:Off`, spec.fldState!), "off");
		}
	});
});
