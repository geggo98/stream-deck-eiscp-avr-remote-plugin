/**
 * Unit tests for the pure action logic in src/actions/eiscp-base.ts (SDK-free:
 * no @elgato/streamdeck in the import chain). parseTone's core cases live in
 * dial-catalog.test.ts; here only the gaps (case-insensitivity) are covered.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
	formatCommandValue,
	nextToggleValue,
	parseTone,
	presetLabel,
	resolveDeviceIp,
	resolveParam,
	setCachedGlobalSettings,
	toneFeedback,
} from "../src/actions/eiscp-base.ts";

describe("resolveDeviceIp", () => {
	afterEach(() => setCachedGlobalSettings(undefined));

	it("prefers the per-action deviceIp over customIp and global settings", () => {
		setCachedGlobalSettings({ deviceIp: "3.3.3.3" });
		assert.equal(resolveDeviceIp({ deviceIp: "1.1.1.1", customIp: "2.2.2.2" }), "1.1.1.1");
	});

	it("uses customIp when deviceIp is 'custom'", () => {
		assert.equal(resolveDeviceIp({ deviceIp: "custom", customIp: "2.2.2.2" }), "2.2.2.2");
	});

	it("uses customIp when no deviceIp is set", () => {
		assert.equal(resolveDeviceIp({ customIp: "2.2.2.2" }), "2.2.2.2");
	});

	it("falls back to the plugin-wide global deviceIp", () => {
		setCachedGlobalSettings({ deviceIp: "3.3.3.3" });
		assert.equal(resolveDeviceIp({}), "3.3.3.3");
		assert.equal(resolveDeviceIp({ deviceIp: "custom" }), "3.3.3.3");
	});

	it("returns undefined when nothing is configured anywhere", () => {
		assert.equal(resolveDeviceIp({}), undefined);
		setCachedGlobalSettings({ deviceIp: "" });
		assert.equal(resolveDeviceIp({}), undefined);
	});

	it("rejects hostnames, so a setting cannot make the plugin resolve arbitrary names", () => {
		assert.equal(resolveDeviceIp({ deviceIp: "receiver.local" }), undefined);
		assert.equal(resolveDeviceIp({ customIp: "attacker.example.com" }), undefined);
		setCachedGlobalSettings({ deviceIp: "evil.example" });
		assert.equal(resolveDeviceIp({}), undefined);
	});

	it("rejects non-string values from the untyped PI JSON", () => {
		// `deviceIp?: string` is a compile-time fiction: the index signature is
		// JsonValue and these arrive as untyped JSON at runtime.
		for (const value of [42, true, { host: "1.1.1.1" }, ["1.1.1.1"], null]) {
			assert.equal(
				resolveDeviceIp({ deviceIp: value as never }),
				undefined,
				`${JSON.stringify(value)} must not resolve`,
			);
		}
	});

	it("rejects malformed and whitespace-only addresses", () => {
		for (const value of ["   ", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1.1.1.1 ; rm -rf /", "::gg"]) {
			assert.equal(resolveDeviceIp({ deviceIp: value }), undefined, `${value} must not resolve`);
		}
	});

	it("accepts IPv4 and IPv6 literals, trimming surrounding whitespace", () => {
		assert.equal(resolveDeviceIp({ deviceIp: " 10.2.0.32 " }), "10.2.0.32");
		assert.equal(resolveDeviceIp({ deviceIp: "fe80::1" }), "fe80::1");
		assert.equal(resolveDeviceIp({ deviceIp: "::1" }), "::1");
	});

	it("does not fall back to the global IP when an explicit device is invalid", () => {
		// Silently retargeting to a different receiver than the action names would
		// be worse than degrading to "No IP".
		setCachedGlobalSettings({ deviceIp: "3.3.3.3" });
		assert.equal(resolveDeviceIp({ deviceIp: "not-an-ip" }), undefined);
		assert.equal(resolveDeviceIp({ deviceIp: "custom", customIp: "also-not-an-ip" }), undefined);
	});
});

describe("resolveParam", () => {
	it("returns the value when one is set", () => {
		assert.equal(resolveParam("X", "Y", "F"), "X");
	});

	it("returns the custom value for 'custom'", () => {
		assert.equal(resolveParam("custom", "Y", "F"), "Y");
	});

	it("falls back when the custom value is empty or missing", () => {
		assert.equal(resolveParam("custom", "", "F"), "F");
		assert.equal(resolveParam("custom", undefined, "F"), "F");
	});

	it("falls back when no value is set", () => {
		assert.equal(resolveParam(undefined, "Y", "F"), "F");
		assert.equal(resolveParam("", undefined, "F"), "F");
	});

	it("returns undefined when neither value nor fallback exist", () => {
		assert.equal(resolveParam(undefined, undefined, undefined), undefined);
	});
});

describe("formatCommandValue", () => {
	it("uses the registry name when the value is known", () => {
		assert.equal(formatCommandValue("PWR", "01"), "on");
		assert.equal(formatCommandValue("AMT", "TG"), "toggle");
	});

	it("converts stepper hex values to decimal", () => {
		assert.equal(formatCommandValue("MVL", "0E"), "14");
		assert.equal(formatCommandValue("MVL", "1E"), "30");
	});

	it("passes unknown values through unchanged", () => {
		assert.equal(formatCommandValue("ZZZ", "whatever"), "whatever");
		assert.equal(formatCommandValue("MVL", "QSTN"), "QSTN"); // stepper, but not hex
		assert.equal(formatCommandValue("PWR", "77"), "77"); // toggle without a matching value
	});
});

describe("parseTone (gaps beyond dial-catalog.test.ts)", () => {
	it("matches case-insensitively, including a lowercase hex nibble", () => {
		assert.deepEqual(parseTone("b+3t-2"), { bass: 3, treble: -2 });
		assert.deepEqual(parseTone("B+aT-a"), { bass: 10, treble: -10 });
	});

	it("mixes the zero token with signed tokens", () => {
		assert.deepEqual(parseTone("B00T+5"), { bass: 0, treble: 5 });
		assert.deepEqual(parseTone("B-7T00"), { bass: -7, treble: 0 });
	});
});

describe("toneFeedback", () => {
	it("maps −10..+10 onto a 0..100 percent bar", () => {
		assert.deepEqual(toneFeedback("B+AT-A", "bass"), { percent: 100, display: "+10" });
		assert.deepEqual(toneFeedback("B+AT-A", "treble"), { percent: 0, display: "-10" });
		assert.deepEqual(toneFeedback("B00T00", "bass"), { percent: 50, display: "0" });
		assert.deepEqual(toneFeedback("B+2T-1", "treble"), { percent: 45, display: "-1" });
		assert.deepEqual(toneFeedback("B+2T-1", "bass"), { percent: 60, display: "+2" });
	});

	it("renders an em dash at the neutral bar position for non-tone input", () => {
		assert.deepEqual(toneFeedback("garbage", "bass"), { percent: 0, display: "—" });
		assert.deepEqual(toneFeedback("", "treble"), { percent: 0, display: "—" });
	});
});

describe("presetLabel", () => {
	it("shows the hex preset number as P<decimal>", () => {
		assert.equal(presetLabel("01"), "P1");
		assert.equal(presetLabel("0E"), "P14");
		assert.equal(presetLabel("28"), "P40");
	});

	it("keeps unparseable raw values as-is", () => {
		assert.equal(presetLabel("XY"), "XY");
		assert.equal(presetLabel(""), "");
	});
});

describe("nextToggleValue", () => {
	const cfg = { onValue: "01", offValue: "00" };

	it("turns off when the current value reads on (power key switches off while on)", () => {
		assert.equal(nextToggleValue("01", cfg), "00");
	});

	it("turns on when the current value reads off", () => {
		assert.equal(nextToggleValue("00", cfg), "01");
	});

	it("turns on for any other (unknown/transitional) value", () => {
		assert.equal(nextToggleValue("77", cfg), "01");
		assert.equal(nextToggleValue("", cfg), "01");
	});
});
