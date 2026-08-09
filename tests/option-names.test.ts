/**
 * The option-name editor's list.
 *
 * Imports only the SDK-free option-names.ts — no @elgato/streamdeck anywhere in the
 * chain, so this runs without the SDK's log-file side effects.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	buildOptionNames,
	effectiveOverride,
	specOptionCodes,
	type OptionOverride,
} from "../src/actions/dedicated/option-names.ts";

const empty = {
	seen: [] as string[],
	learned: new Map<string, string>(),
	overrides: new Map<string, OptionOverride>(),
	defaults: {} as Record<string, string>,
};

const rowFor = (list: ReturnType<typeof buildOptionNames>, code: string) =>
	list.rows.find((r) => r.code === code);

describe("option name rows", () => {
	it("lists every code with evidence, and nothing else", () => {
		const list = buildOptionNames(
			{
				seen: ["2B", "10"],
				learned: new Map([["10", "BD/DVD"]]),
				overrides: new Map([["29", { name: "Stick", use: true }]]),
				defaults: { "24": "FM" },
			},
			"SLI",
		);
		assert.deepEqual(
			list.rows.map((r) => r.code),
			["10", "24", "29", "2B"],
			"seen, learned, user-named and pre-filled codes, sorted",
		);
	});

	it("keeps the receiver's name beside the user's, never instead of it", () => {
		const list = buildOptionNames(
			{
				...empty,
				seen: ["2B"],
				learned: new Map([["2B", "NET"]]),
				overrides: new Map([["2B", { name: "Sonos", use: true }]]),
			},
			"SLI",
		);
		const row = rowFor(list, "2B")!;
		assert.equal(row.custom, "Sonos");
		assert.equal(row.learned, "NET", "the learned name has to stay visible to be switchable");
		assert.equal(row.use, true);
		assert.equal(row.seeded, false);
	});

	it("offers a pre-filled name as a ticked user name, with nothing stored", () => {
		const list = buildOptionNames({ ...empty, defaults: { "24": "FM", "33": "DAB" } }, "SLI");
		for (const [code, name] of [
			["24", "FM"],
			["33", "DAB"],
		]) {
			const row = rowFor(list, code!)!;
			assert.equal(row.custom, name);
			assert.equal(row.use, true);
			assert.equal(row.seeded, true, "seeded, so the panel can say where it came from");
		}
	});

	it("lets a stored entry override the pre-filled one, switched off included", () => {
		const list = buildOptionNames(
			{
				...empty,
				learned: new Map([["24", "FM 87.50MHz"]]),
				overrides: new Map([["24", { name: "FM", use: false }]]),
				defaults: { "24": "FM" },
			},
			"SLI",
		);
		const row = rowFor(list, "24")!;
		assert.equal(row.use, false, "the user said: show me what the receiver reports");
		assert.equal(row.custom, "FM", "and the text is kept, or switching back means retyping");
		assert.equal(row.seeded, false);
	});

	it("reports a code with no name at all as unnamed rather than omitting it", () => {
		// The whole reason `seen` is persisted: a tuner input shows its station, so it
		// never learns a name — and a row is the only way to give it one by hand.
		const list = buildOptionNames({ ...empty, seen: ["33"] }, "SLI");
		const row = rowFor(list, "33")!;
		assert.equal(row.learned, undefined);
		assert.equal(row.custom, undefined);
		assert.equal(row.use, false);
		assert.ok(row.spec, "the spec label is still offered as the placeholder");
	});

	it("ignores values that are not options a receiver can be in", () => {
		// The registry's value list mixes codes with steering aliases.
		const list = buildOptionNames({ ...empty, seen: ["UP", "DOWN", "N/A", "2B"] }, "SLI");
		assert.deepEqual(
			list.rows.map((r) => r.code),
			["2B"],
		);
		assert.ok(!specOptionCodes("LMD").includes("STEREO"));
		assert.ok(specOptionCodes("LMD").includes("00"));
	});

	it("offers the rest of the spec to add by hand, minus what is already listed", () => {
		const list = buildOptionNames({ ...empty, seen: ["2B"] }, "SLI");
		const codes = list.addable.map((a) => a.code);
		assert.ok(!codes.includes("2B"), "a listed code must not be addable twice");
		assert.ok(codes.includes("10"), "and everything else the spec knows is reachable");
		assert.equal(codes.length, specOptionCodes("SLI").length - 1);
	});
});

describe("which name is in force", () => {
	const defaults = { "24": "FM" };

	it("prefers a stored name that is switched on", () => {
		const overrides = new Map([["2B", { name: "Sonos", use: true }]]);
		assert.equal(effectiveOverride("2B", overrides, defaults), "Sonos");
	});

	it("yields to the learned name when the stored one is switched off", () => {
		const overrides = new Map([["2B", { name: "Sonos", use: false }]]);
		assert.equal(effectiveOverride("2B", overrides, defaults), undefined);
	});

	it("applies a pre-filled name with nothing stored", () => {
		assert.equal(effectiveOverride("24", new Map(), defaults), "FM");
	});

	it("lets a stored entry suppress the pre-filled one", () => {
		// Switching off a seeded slot is the only way back to the station name, so it
		// must not fall through to the default it is switching off.
		const overrides = new Map([["24", { name: "FM", use: false }]]);
		assert.equal(effectiveOverride("24", overrides, defaults), undefined);
	});
});
