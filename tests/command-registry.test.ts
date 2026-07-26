/**
 * Unit tests for the command registry
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
	COMMAND_REGISTRY,
	getCommandDef,
	getCommandsByType,
	getValueName,
} from "../src/adapter/eiscp/command-registry.ts";
import { matchesSpecValue, specValueLabels } from "../src/adapter/eiscp/spec-labels.ts";

describe("command registry", () => {
	describe("structure validation", () => {
		it("should have commands in the registry", () => {
			const commands = Object.keys(COMMAND_REGISTRY);
			assert.ok(commands.length > 0, "Registry should not be empty");
		});

		it("should have required fields for every command", () => {
			for (const [code, cmd] of Object.entries(COMMAND_REGISTRY)) {
				assert.equal(cmd.code, code, `Code should match key for ${code}`);
				assert.ok(cmd.name, `${code} should have a name`);
				assert.ok(cmd.description, `${code} should have a description`);
				assert.ok(
					["toggle", "stepper", "selector"].includes(cmd.actionType),
					`${code} should have valid actionType, got ${cmd.actionType}`,
				);
				assert.ok(Array.isArray(cmd.values), `${code} values should be an array`);
				assert.equal(typeof cmd.hasQuery, "boolean", `${code} hasQuery should be boolean`);
				assert.equal(typeof cmd.hasUpDown, "boolean", `${code} hasUpDown should be boolean`);
			}
		});

		it("should have valid value definitions", () => {
			for (const [code, cmd] of Object.entries(COMMAND_REGISTRY)) {
				for (const val of cmd.values) {
					assert.ok(typeof val.param === "string", `${code} value param should be string`);
					assert.ok(typeof val.name === "string", `${code} value name should be string`);
					assert.ok(typeof val.description === "string", `${code} value description should be string`);
				}
			}
		});
	});

	describe("classification", () => {
		it("should classify PWR as toggle", () => {
			const cmd = COMMAND_REGISTRY.PWR;
			assert.ok(cmd);
			assert.ok(cmd.actionType === "toggle");
			assert.equal(cmd.onValue, "01");
			assert.equal(cmd.offValue, "00");
		});

		it("should classify AMT as toggle with TG", () => {
			const cmd = COMMAND_REGISTRY.AMT;
			assert.ok(cmd);
			assert.ok(cmd.actionType === "toggle");
			assert.equal(cmd.toggleValue, "TG");
		});

		it("should classify MVL as stepper", () => {
			const cmd = COMMAND_REGISTRY.MVL;
			assert.ok(cmd);
			assert.equal(cmd.actionType, "stepper");
			assert.ok(cmd.hasUpDown);
			assert.ok(cmd.values.some((v) => v.param === "UP"));
			assert.ok(cmd.values.some((v) => v.param === "DOWN"));
		});

		it("should classify SLI as selector", () => {
			const cmd = COMMAND_REGISTRY.SLI;
			assert.ok(cmd);
			assert.equal(cmd.actionType, "selector");
			assert.ok(cmd.values.length > 10, "SLI should have many values");
		});

		it("should classify LMD as selector", () => {
			const cmd = COMMAND_REGISTRY.LMD;
			assert.ok(cmd);
			assert.equal(cmd.actionType, "selector");
			assert.ok(cmd.values.length > 10, "LMD should have many values");
		});

		it("should classify DIR as toggle", () => {
			const cmd = COMMAND_REGISTRY.DIR;
			assert.ok(cmd);
			assert.ok(cmd.actionType === "toggle");
			assert.equal(cmd.toggleValue, "TG");
		});

		it("should classify TFR (tone) as selector with bass/treble steps", () => {
			const cmd = COMMAND_REGISTRY.TFR;
			assert.ok(cmd);
			assert.equal(cmd.actionType, "selector");
			const params = cmd.values.map((v) => v.param);
			assert.deepEqual(params, ["BUP", "BDOWN", "TUP", "TDOWN"]);
		});

		it("should classify NTC (transport) as selector with transport keys", () => {
			const cmd = COMMAND_REGISTRY.NTC;
			assert.ok(cmd);
			assert.equal(cmd.actionType, "selector");
			const params = cmd.values.map((v) => v.param);
			for (const p of ["PLAY", "STOP", "PAUSE", "P/P", "TRUP", "TRDN"]) {
				assert.ok(params.includes(p), `NTC should have ${p}`);
			}
		});

		it("should classify ZPW as toggle and ZMT as toggle with TG", () => {
			const zpw = COMMAND_REGISTRY.ZPW;
			assert.ok(zpw);
			assert.ok(zpw.actionType === "toggle");
			assert.equal(zpw.onValue, "01");
			assert.equal(zpw.offValue, "00");
			const zmt = COMMAND_REGISTRY.ZMT;
			assert.ok(zmt);
			assert.ok(zmt.actionType === "toggle");
			assert.equal(zmt.toggleValue, "TG");
		});

		it("should classify ZVL (zone2 volume) as stepper", () => {
			const cmd = COMMAND_REGISTRY.ZVL;
			assert.ok(cmd);
			assert.equal(cmd.actionType, "stepper");
			assert.ok(cmd.hasUpDown);
		});
	});

	describe("value normalization", () => {
		it("should preserve 2-char hex input codes (regression: decimal->hex bug)", () => {
			// Previously normalizeParam turned '23' into '17' (decimal 23 -> hex).
			assert.equal(getValueName("SLI", "23"), "cd");
			assert.equal(getValueName("SLI", "24"), "fm");
			assert.equal(getValueName("SLI", "10"), "dvd");
			assert.equal(getValueName("SLI", "2B"), "network");
		});

		it("should keep NTC numeric keys as literal digits, not hex-padded", () => {
			const params = COMMAND_REGISTRY.NTC!.values.map((v) => v.param);
			assert.ok(params.includes("0"), "NTC should have literal '0'");
			assert.ok(!params.includes("00"), "NTC should NOT hex-pad to '00'");
		});

		it("should not leak range or template keys as values", () => {
			for (const [code, cmd] of Object.entries(COMMAND_REGISTRY)) {
				for (const v of cmd.values) {
					assert.ok(!/[[\]{}]/.test(v.param), `${code} leaked a range/template param: ${v.param}`);
					assert.ok(!/^\d+\s*,\s*\d+$/.test(v.param), `${code} leaked a range param: ${v.param}`);
				}
			}
		});
	});

	describe("metadata", () => {
		it("every command should have a category", () => {
			for (const [code, cmd] of Object.entries(COMMAND_REGISTRY)) {
				assert.ok(cmd.category, `${code} should have a category`);
			}
		});
	});

	describe("helper functions", () => {
		it("getCommandDef should return a command by code", () => {
			const cmd = getCommandDef("PWR");
			assert.ok(cmd);
			assert.equal(cmd.code, "PWR");
		});

		it("getCommandDef should return undefined for unknown code", () => {
			const cmd = getCommandDef("XXX");
			assert.equal(cmd, undefined);
		});

		it("getCommandsByType should filter by type", () => {
			const toggles = getCommandsByType("toggle");
			assert.ok(toggles.length > 0);
			assert.ok(toggles.every((c) => c.actionType === "toggle"));

			const steppers = getCommandsByType("stepper");
			assert.ok(steppers.length > 0);
			assert.ok(steppers.every((c) => c.actionType === "stepper"));
		});

		it("getValueName should return value name", () => {
			assert.equal(getValueName("PWR", "01"), "on");
			assert.equal(getValueName("PWR", "00"), "standby");
		});

		it("getValueName should be case-insensitive", () => {
			assert.equal(getValueName("MVL", "up"), "level-up");
			assert.equal(getValueName("MVL", "UP"), "level-up");
		});

		it("getValueName should return undefined for unknown", () => {
			assert.equal(getValueName("XXX", "01"), undefined);
			assert.equal(getValueName("PWR", "ZZ"), undefined);
		});
	});

	describe("toggle commands", () => {
		it("all toggles should have onValue and offValue", () => {
			const toggles = getCommandsByType("toggle");
			for (const cmd of toggles) {
				assert.equal(cmd.actionType, "toggle");
				if (cmd.actionType !== "toggle") continue; // narrow the union
				assert.ok(cmd.onValue, `${cmd.code} toggle should have onValue`);
				assert.ok(cmd.offValue, `${cmd.code} toggle should have offValue`);
			}
		});
	});

	describe("stepper commands", () => {
		it("all steppers should have hasUpDown=true", () => {
			const steppers = getCommandsByType("stepper");
			for (const cmd of steppers) {
				assert.ok(cmd.hasUpDown, `${cmd.code} stepper should have hasUpDown=true`);
			}
		});
	});
});

describe("spec labels for a value", () => {
	it("takes the labels out of the spec description, not just the short name", () => {
		// SLI 10 is name "dvd" but description "sets DVD, BD/DVD" — and "BD/DVD" is
		// what the receiver actually displays, so the description is the useful part.
		const labels = specValueLabels("SLI", "10");
		assert.ok(labels.includes("BDDVD"), `expected BD/DVD among ${labels.join(",")}`);
		assert.ok(labels.includes("DVD"));
	});

	it("accepts the labels a real VSX-S520D displays", () => {
		// Measured against the receiver: these nine are the ones the spec covers.
		const accepted: Record<string, string> = {
			"10": "BD/DVD",
			"11": "STRM BOX",
			"12": "TV",
			"22": "PHONO",
			"23": "CD",
			"24": "FM 87.50MHz", // the tuner appends its frequency; "FM" still matches
			"29": "USB",
			"01": "CBL/SAT", // spec: "VIDEO2, CBL/SAT"
			"02": "GAME", // spec: "VIDEO3, GAME/TV, GAME, GAME1"
			"2B": "NET",
		};
		for (const [param, label] of Object.entries(accepted)) {
			assert.equal(matchesSpecValue("SLI", param, label), true, `${param} "${label}" should match`);
		}
	});

	it("flags a corrupted name — the reason this exists", () => {
		// A tone readout that was learned as the name of the DVD input.
		assert.equal(matchesSpecValue("SLI", "10", "Bass : +"), false);
		assert.equal(matchesSpecValue("SLI", "10", "Volume"), false);
	});

	it("also flags honest relabels, which is why it must never veto", () => {
		// The receiver calls 2E "BT AUDIO" where the spec says "BLUETOOTH", and shows
		// a station name for the DAB input. Both are real and must survive; they are
		// only worth a second reading (see runSweep).
		assert.equal(matchesSpecValue("SLI", "2E", "BT AUDIO"), false);
		assert.equal(matchesSpecValue("SLI", "33", "TEDDY"), false);
	});

	it("says nothing about a value the spec does not know", () => {
		assert.deepEqual(specValueLabels("SLI", "ZZ"), []);
		assert.equal(matchesSpecValue("SLI", "ZZ", "anything"), false);
		assert.equal(matchesSpecValue("NOPE", "10", "anything"), false);
		assert.equal(matchesSpecValue("SLI", "10", ""), false);
	});

	it("compares case- and punctuation-insensitively", () => {
		assert.equal(matchesSpecValue("SLI", "10", "bd/dvd"), true);
		assert.equal(matchesSpecValue("SLI", "10", "BD-DVD"), true);
		assert.equal(matchesSpecValue("SLI", "11", "strm box"), true);
	});
});

describe("the generated registry stays generated", () => {
	it("exports exactly what the generator emits, and nothing hand-written", () => {
		// This guard exists because the opposite happened: `specValueLabels` and
		// `matchesSpecValue` — 52 lines of hand-written logic — had been appended to the
		// end of the generated file. The next `npm run generate` deleted them without a
		// word, and it only surfaced because the build then failed on a missing export.
		// They now live in spec-labels.ts. Anything hand-written that lands here again
		// is on borrowed time, so fail loudly instead.
		const source = readFileSync(new URL("../src/adapter/eiscp/command-registry.ts", import.meta.url), "utf-8");
		assert.match(source.split("\n")[0]!, /Auto-generated/, "the generated header must stay at the top");

		const exported = [...source.matchAll(/^export (?:function|const|interface|type) (\w+)/gm)].map((m) => m[1]);
		assert.deepEqual(
			[...exported].sort(),
			[
				"COMMAND_REGISTRY",
				"CommandActionType",
				"CommandDef",
				"CommandValueDef",
				"SelectorCommandDef",
				"StepperCommandDef",
				"ToggleCommandDef",
				"getCommandDef",
				"getCommandsByType",
				"getValueName",
			],
			"an unexpected export in a generated file means someone edited it by hand",
		);
	});
});
