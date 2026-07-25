/**
 * Tests for the persistent name store (FLD-based name learning for LMD + SLI).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decodeDisplayText } from "../src/actions/eiscp-base.ts";
import { load, nameFor, noteChange, noteFld, recordSli, serialize } from "../src/actions/dedicated/name-store.ts";

// Hex-ASCII helpers for FLD payloads.
const hex = (s: string) => Buffer.from(s, "ascii").toString("hex");
const DTS_X = hex("DTS Neural:X"); // mode name (no trailing digits)
const CD_VOL = hex("CD          14"); // input + volume readout

describe("decodeDisplayText", () => {
	it("decodes hex-encoded ASCII", () => {
		assert.equal(decodeDisplayText(DTS_X), "DTS Neural:X");
		assert.equal(decodeDisplayText(CD_VOL), "CD          14");
	});
	it("returns empty string for invalid hex", () => {
		assert.equal(decodeDisplayText("zzzz"), "");
	});
});

describe("name-store learning", () => {
	it("learns a listening-mode name from an FLD that follows an LMD change", () => {
		const host = "ns-lmd";
		noteChange(host, "LMD", "82");
		assert.equal(noteFld(host, DTS_X), true);
		assert.equal(nameFor(host, "LMD", "82"), "DTS Neural:X");
	});

	it("pairs the input+volume readout with the SLI code (code-then-name)", () => {
		const host = "ns-sli-abs";
		noteChange(host, "SLI", "23"); // absolute switch: code first
		assert.equal(noteFld(host, CD_VOL), true); // then the input+volume FLD
		assert.equal(nameFor(host, "SLI", "23"), "CD");
	});

	it("pairs the input name with a later SLI code (name-then-code, like UP)", () => {
		const host = "ns-sli-up";
		assert.equal(noteFld(host, CD_VOL), false); // FLD name arrives first (no code yet)
		noteChange(host, "SLI", "23"); // code arrives ~1s later -> pairs
		assert.equal(nameFor(host, "SLI", "23"), "CD");
	});

	it("does not learn a mode name when no LMD change preceded it", () => {
		const host = "ns-nowindow";
		assert.equal(noteFld(host, DTS_X), false);
	});

	it("does not misroute the input+volume readout to a pending LMD change", () => {
		const host = "ns-route";
		noteChange(host, "LMD", "00");
		noteChange(host, "SLI", "23");
		// An input+volume FLD must be attributed to SLI, never to LMD.
		noteFld(host, CD_VOL);
		assert.equal(nameFor(host, "SLI", "23"), "CD");
		assert.equal(nameFor(host, "LMD", "00"), "stereo"); // registry fallback, not "CD"
	});

	it("recordSli cleans the fixed-width readout (padding, volume, scroll dashes)", () => {
		const host = "ns-record";
		recordSli(host, "10", hex("BD/DVD      14"));
		recordSli(host, "24", hex("FM 87.50MHz --"));
		recordSli(host, "33", hex("TEDDY       --"));
		assert.equal(nameFor(host, "SLI", "10"), "BD/DVD");
		assert.equal(nameFor(host, "SLI", "24"), "FM 87.50MHz");
		assert.equal(nameFor(host, "SLI", "33"), "TEDDY");
	});

	it("renders the LMD N/A sentinel as 'Not Available'", () => {
		assert.equal(nameFor("ns-any", "LMD", "N/A"), "Not Available");
	});

	it("falls back to the registry name when nothing is learned", () => {
		assert.equal(nameFor("ns-fresh", "LMD", "82"), "neo-6-cinema");
		assert.equal(nameFor("ns-fresh", "SLI", "23"), "cd");
	});
});

describe("name-store persistence", () => {
	it("serializes learned names and round-trips through load()", () => {
		const host = "ns-persist";
		noteChange(host, "LMD", "82");
		noteFld(host, DTS_X);
		noteChange(host, "SLI", "23");
		noteFld(host, CD_VOL);

		const snapshot = serialize();
		assert.equal(snapshot[host]!.LMD!["82"], "DTS Neural:X");
		assert.equal(snapshot[host]!.SLI!["23"], "CD");

		// Loading into a fresh host key restores the names.
		load({ "ns-loaded": { LMD: { "11": "Pure Audio" }, SLI: { "24": "FM" } } });
		assert.equal(nameFor("ns-loaded", "LMD", "11"), "Pure Audio");
		assert.equal(nameFor("ns-loaded", "SLI", "24"), "FM");
	});

	it("load() does not overwrite a runtime-learned name", () => {
		const host = "ns-nooverwrite";
		noteChange(host, "LMD", "82");
		noteFld(host, DTS_X); // runtime: "DTS Neural:X"
		load({ [host]: { LMD: { "82": "stale-name" } } });
		assert.equal(nameFor(host, "LMD", "82"), "DTS Neural:X");
	});
});

// Everything the store learns is device-supplied: it is persisted into Stream
// Deck's global settings and rendered as button titles, so a hostile or
// malfunctioning receiver must not be able to grow it without limit.
describe("name-store input hardening", () => {
	it("caps a long learned name", () => {
		const host = "ns-longname";
		noteChange(host, "LMD", "82");
		noteFld(host, hex("N".repeat(500)));
		const learned = nameFor(host, "LMD", "82");
		assert.ok(learned, "an over-long name should still be learned, just clamped");
		assert.ok(learned.length <= 48, `name length ${learned.length} should be clamped`);
	});

	it("strips control characters from learned names", () => {
		const host = "ns-ctrl";
		noteChange(host, "LMD", "82");
		// ASCII decoding masks the high bit rather than rejecting, so control bytes
		// genuinely reach the store; an ANSI escape would otherwise be persisted
		// and rendered.
		noteFld(host, hex("Pure\x1b[31m\x00Audio"));
		const learned = nameFor(host, "LMD", "82");
		assert.equal(learned, "Pure[31mAudio");
		assert.ok(!/[\x00-\x1f\x7f]/.test(learned!), "no control characters may survive");
	});

	it("bounds the decoded display text regardless of parameter length", () => {
		// The FLD parameter is unbounded network data; decoding must not allocate
		// proportionally to it.
		const decoded = decodeDisplayText(hex("A".repeat(100_000)));
		assert.ok(decoded.length <= 128, `decoded length ${decoded.length} should be bounded`);
	});

	it("caps distinct codes per command but keeps updating known ones", () => {
		const host = "ns-cap";
		// A device reporting ever-changing SLI codes would otherwise add an entry
		// forever. 128 is the cap.
		for (let i = 0; i < 300; i++) {
			recordSli(host, `C${i}`, hex(`Input ${i}`));
		}
		const stored = serialize()[host]?.SLI ?? {};
		assert.equal(Object.keys(stored).length, 128);

		// A code already tracked must still accept a new name.
		const known = Object.keys(stored)[0]!;
		assert.equal(recordSli(host, known, hex("Renamed")), true);
		assert.equal(nameFor(host, "SLI", known), "Renamed");
	});

	it("rejects empty names and codes", () => {
		const host = "ns-empty";
		assert.equal(recordSli(host, "", hex("Something")), false);
		assert.equal(recordSli(host, "10", hex("")), false);
		assert.equal(recordSli(host, "10", hex("   ")), false);
		assert.equal(recordSli(host, "10", hex("\x00\x01")), false);
	});

	it("load() applies the same validation to previously persisted data", () => {
		// Data persisted by an earlier version had no caps at all, and it is
		// device-supplied either way — round-tripping through global settings does
		// not make it trusted.
		// Asserted against serialize() rather than nameFor, which would mask a
		// rejected entry behind its registry-name / raw-code display fallback.
		load({
			"ns-loadhard": {
				LMD: { Z1: "x".repeat(500), Z2: "Pure\x00Audio", Z3: "" },
			},
		});
		const stored = serialize()["ns-loadhard"]!.LMD!;
		assert.ok(stored["Z1"]!.length <= 48, "over-long persisted name should be clamped");
		assert.equal(stored["Z2"], "PureAudio");
		assert.equal("Z3" in stored, false, "empty persisted name should not be stored");
	});

	it("load() ignores non-string persisted names", () => {
		load({ "ns-loadtype": { LMD: { Z1: 42 as never, Z2: "Fine" } } });
		const stored = serialize()["ns-loadtype"]!.LMD!;
		assert.equal("Z1" in stored, false, "non-string persisted name should be ignored");
		assert.equal(stored["Z2"], "Fine");
	});
});
