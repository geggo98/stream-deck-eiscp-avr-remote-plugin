/**
 * Unit tests for the command registry
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	COMMAND_REGISTRY,
	getCommandDef,
	getCommandsByType,
	getValueName,
} from "../src/adapter/eiscp/command-registry.ts";

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
			assert.equal(cmd.actionType, "toggle");
			assert.equal(cmd.onValue, "01");
			assert.equal(cmd.offValue, "00");
		});

		it("should classify AMT as toggle with TG", () => {
			const cmd = COMMAND_REGISTRY.AMT;
			assert.equal(cmd.actionType, "toggle");
			assert.equal(cmd.toggleValue, "TG");
		});

		it("should classify MVL as stepper", () => {
			const cmd = COMMAND_REGISTRY.MVL;
			assert.equal(cmd.actionType, "stepper");
			assert.ok(cmd.hasUpDown);
			assert.ok(cmd.values.some((v) => v.param === "UP"));
			assert.ok(cmd.values.some((v) => v.param === "DOWN"));
		});

		it("should classify SLI as selector", () => {
			const cmd = COMMAND_REGISTRY.SLI;
			assert.equal(cmd.actionType, "selector");
			assert.ok(cmd.values.length > 10, "SLI should have many values");
		});

		it("should classify LMD as selector", () => {
			const cmd = COMMAND_REGISTRY.LMD;
			assert.equal(cmd.actionType, "selector");
			assert.ok(cmd.values.length > 10, "LMD should have many values");
		});

		it("should classify DIR as toggle", () => {
			const cmd = COMMAND_REGISTRY.DIR;
			assert.equal(cmd.actionType, "toggle");
			assert.equal(cmd.toggleValue, "TG");
		});

		it("should classify TFR (tone) as selector with bass/treble steps", () => {
			const cmd = COMMAND_REGISTRY.TFR;
			assert.equal(cmd.actionType, "selector");
			const params = cmd.values.map((v) => v.param);
			assert.deepEqual(params, ["BUP", "BDOWN", "TUP", "TDOWN"]);
		});

		it("should classify NTC (transport) as selector with transport keys", () => {
			const cmd = COMMAND_REGISTRY.NTC;
			assert.equal(cmd.actionType, "selector");
			const params = cmd.values.map((v) => v.param);
			for (const p of ["PLAY", "STOP", "PAUSE", "P/P", "TRUP", "TRDN"]) {
				assert.ok(params.includes(p), `NTC should have ${p}`);
			}
		});

		it("should classify ZPW as toggle and ZMT as toggle with TG", () => {
			assert.equal(COMMAND_REGISTRY.ZPW.actionType, "toggle");
			assert.equal(COMMAND_REGISTRY.ZPW.onValue, "01");
			assert.equal(COMMAND_REGISTRY.ZPW.offValue, "00");
			assert.equal(COMMAND_REGISTRY.ZMT.actionType, "toggle");
			assert.equal(COMMAND_REGISTRY.ZMT.toggleValue, "TG");
		});

		it("should classify ZVL (zone2 volume) as stepper", () => {
			const cmd = COMMAND_REGISTRY.ZVL;
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
			const params = COMMAND_REGISTRY.NTC.values.map((v) => v.param);
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
