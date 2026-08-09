/**
 * The `NST` play field — the signal Auto-Discover uses to decide whether it may resume
 * playback after it has paused a source.
 *
 * The interesting cases are the ones that must NOT read as "playing", because the cost
 * of a false positive is music starting in someone's room after they pressed a
 * discovery button.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parsePlayStatus } from "../src/adapter/eiscp/play-status.ts";

describe("parsePlayStatus", () => {
	it("reads the transport state from the first field", () => {
		// `prs`: play, repeat, shuffle — measured values from the reference unit.
		assert.equal(parsePlayStatus("P--"), "play");
		assert.equal(parsePlayStatus("p--"), "pause");
		assert.equal(parsePlayStatus("S--"), "stop");
		assert.equal(parsePlayStatus("FRA"), "ff");
		assert.equal(parsePlayStatus("R--"), "rew");
		assert.equal(parsePlayStatus("E--"), "eof");
	});

	it("is case-sensitive, because P and p are different states", () => {
		assert.notEqual(parsePlayStatus("P--"), parsePlayStatus("p--"));
	});

	it("answers 'no evidence' rather than guessing", () => {
		// Never seen an NST frame, an empty parameter, and a value from a receiver that
		// reports something this does not know: all the same answer, and that answer must
		// not be "playing" — every caller treats undefined as "do not resume".
		assert.equal(parsePlayStatus(undefined), undefined);
		assert.equal(parsePlayStatus(""), undefined);
		assert.equal(parsePlayStatus("X--"), undefined);
		assert.equal(parsePlayStatus("N/A"), undefined);
	});
});
