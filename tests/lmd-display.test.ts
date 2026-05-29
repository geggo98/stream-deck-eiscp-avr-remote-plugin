/**
 * Tests for FLD-based listening-mode name learning.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decodeDisplayText } from "../src/actions/eiscp-base.ts";
import { lmdDisplayName, noteFld, noteLmd } from "../src/actions/dedicated/lmd-display.ts";

describe("decodeDisplayText", () => {
	it("decodes hex-encoded ASCII display text", () => {
		assert.equal(decodeDisplayText("20445453204E657572616C3A5820"), "DTS Neural:X");
		assert.equal(decodeDisplayText("42442F4456442020202020203134"), "BD/DVD      14");
	});
	it("returns empty string for invalid hex", () => {
		assert.equal(decodeDisplayText("zzzz"), "");
	});
});

describe("lmd-display name learning", () => {
	it("learns the receiver's name from an FLD that follows an LMD change", () => {
		const host = "lmd-test-learn";
		noteLmd(host, "82");
		const learned = noteFld(host, "20445453204E657572616C3A5820"); // "DTS Neural:X"
		assert.equal(learned, true);
		assert.equal(lmdDisplayName(host, "82"), "DTS Neural:X");
	});

	it("ignores the at-rest input+volume readout", () => {
		const host = "lmd-test-ignore";
		noteLmd(host, "00");
		const learned = noteFld(host, "42442F4456442020202020203134"); // "BD/DVD      14"
		assert.equal(learned, false);
		assert.equal(lmdDisplayName(host, "00"), "stereo"); // registry fallback
	});

	it("renders the LMD N/A sentinel as 'Not Available'", () => {
		assert.equal(lmdDisplayName("lmd-test-any", "N/A"), "Not Available");
	});

	it("falls back to the registry name when nothing has been learned", () => {
		assert.equal(lmdDisplayName("lmd-test-fresh", "82"), "neo-6-cinema");
	});

	it("does not learn an FLD that arrives without a preceding LMD change", () => {
		const host = "lmd-test-nowindow";
		const learned = noteFld(host, "20445453204E657572616C3A5820");
		assert.equal(learned, false);
	});
});
