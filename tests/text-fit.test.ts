/**
 * Fitting a track title into the space a touch strip really has.
 *
 * This is the constraint that matters for a now-playing display, and it is not the
 * cover: album art is square and fits into part of one 200x100 segment. Long titles
 * do not — beside a 92 px cover about eleven characters remain, and "Taylor Swift" is
 * twelve.
 *
 * The layout offers no font family (so the width estimate is an estimate and the tests
 * assert relationships rather than exact pixel counts) and no marquee, so a long
 * string either shrinks, gets split across segments, or gets cut.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	AVG_CHAR_WIDTH_RATIO,
	charBudget,
	fitText,
	FONT_SIZE_LADDER,
	splitTextAcross,
} from "../src/actions/text-fit.ts";

/** Widths the layout actually offers, from the plan's design. */
const BESIDE_COVER = 98;
const FULL_SEGMENT = 200;

describe("character budget", () => {
	it("gets smaller as the type gets bigger", () => {
		const big = charBudget(FULL_SEGMENT, 16);
		const small = charBudget(FULL_SEGMENT, 10);
		assert.ok(small > big, `${small} should beat ${big}`);
	});

	it("quantifies the squeeze beside a cover", () => {
		// The number that motivates the whole layout: a line next to the cover holds
		// about eleven characters at the default size.
		const beside = charBudget(BESIDE_COVER, 16);
		assert.ok(beside >= 10 && beside <= 12, `expected ~11 characters, got ${beside}`);
		// A full segment roughly doubles it, which is what an extra dial buys.
		assert.ok(charBudget(FULL_SEGMENT, 16) >= beside * 2 - 1);
	});

	it("returns nothing rather than NaN or Infinity for nonsense", () => {
		for (const [width, size] of [
			[Number.NaN, 16],
			[100, 0],
			[100, Number.NaN],
			[Number.POSITIVE_INFINITY, 16],
			[-50, 16],
		] as const) {
			const budget = charBudget(width, size);
			assert.ok(Number.isInteger(budget) && budget >= 0, `${width}/${size} -> ${budget}`);
		}
	});

	it("uses a pessimistic width estimate on purpose", () => {
		// Being wrong low means type is smaller than it needed to be; wrong high means
		// it gets clipped. The bias must stay toward the former.
		assert.ok(AVG_CHAR_WIDTH_RATIO >= 0.5 && AVG_CHAR_WIDTH_RATIO <= 0.6);
	});
});

describe("fitText", () => {
	it("keeps the largest size that fits", () => {
		const fitted = fitText("Lover", FULL_SEGMENT);
		assert.equal(fitted.text, "Lover");
		assert.equal(fitted.fontSize, FONT_SIZE_LADDER[0]);
		assert.equal(fitted.clipped, false);
	});

	it("shrinks before it clips", () => {
		// "Taylor Swift" does not fit beside a cover at 16 px but does at a smaller size,
		// and shrinking keeps the whole name — which is what a listener wants.
		const fitted = fitText("Taylor Swift", BESIDE_COVER);
		assert.equal(fitted.text, "Taylor Swift");
		assert.ok(fitted.fontSize < FONT_SIZE_LADDER[0]!, `expected a smaller size, got ${fitted.fontSize}`);
		assert.equal(fitted.clipped, false);
	});

	it("clips only when even the smallest size cannot hold it, and says so", () => {
		const long = "Goodbye Lullaby (Expanded Edition) Deluxe Remaster";
		const fitted = fitText(long, BESIDE_COVER);
		assert.equal(fitted.clipped, true, "the caller needs to know this happened");
		assert.equal(fitted.fontSize, FONT_SIZE_LADDER[FONT_SIZE_LADDER.length - 1]);
		assert.ok(fitted.text.endsWith("…"));
		assert.ok(fitted.text.length < long.length);
	});

	it("cuts on a word boundary when one is near the limit", () => {
		// A title cut mid-word reads as corruption — this repo already shipped
		// "...Baby One M" as a listening-mode name once.
		const fitted = fitText("Bohemian Rhapsody Live", BESIDE_COVER);
		assert.equal(fitted.clipped, true);
		assert.ok(!/\w…$/.test(fitted.text) || fitted.text.startsWith("Bohemian"), fitted.text);
	});

	it("gives a wider segment a bigger size for the same string", () => {
		// The whole point of spending an extra dial on a text line.
		const cramped = fitText("Taylor Swift", BESIDE_COVER);
		const roomy = fitText("Taylor Swift", FULL_SEGMENT);
		assert.ok(roomy.fontSize > cramped.fontSize, `${roomy.fontSize} should beat ${cramped.fontSize}`);
	});

	it("trims and survives an empty or absurd input", () => {
		assert.equal(fitText("   Lover  ", FULL_SEGMENT).text, "Lover");
		assert.equal(fitText("", FULL_SEGMENT).text, "");
		assert.equal(fitText("", FULL_SEGMENT).clipped, false);
		// No room at all: report the clip rather than emitting a stray ellipsis.
		const none = fitText("Cruel Summer", 0);
		assert.equal(none.text, "");
		assert.equal(none.clipped, true);
	});

	it("honours an explicit size ladder", () => {
		const fitted = fitText("Lover", FULL_SEGMENT, { sizes: [24] });
		assert.equal(fitted.fontSize, 24);
	});
});

describe("splitTextAcross", () => {
	it("returns the whole string for a single segment", () => {
		assert.deepEqual(splitTextAcross("Bohemian Rhapsody", 1), ["Bohemian Rhapsody"]);
	});

	it("splits on words, not on characters", () => {
		// "Bohemian" / "Rhapsody" reads; "Bohemian Rha" / "psody" does not.
		const parts = splitTextAcross("Bohemian Rhapsody", 2);
		assert.deepEqual(parts, ["Bohemian", "Rhapsody"]);
	});

	it("loses nothing: the parts rejoin to the original words", () => {
		// The property that matters — a split display must not drop a word.
		const title = "Everything Everything All At Once Forever";
		for (const count of [2, 3, 4]) {
			const parts = splitTextAcross(title, count);
			assert.equal(parts.length, count, `count ${count}`);
			assert.equal(parts.filter(Boolean).join(" "), title, `count ${count}`);
		}
	});

	it("balances the parts rather than filling the first one", () => {
		const parts = splitTextAcross("One Two Three Four Five Six", 2);
		const [a, b] = parts as [string, string];
		assert.ok(a.length > 0 && b.length > 0, `both parts must carry words: ${JSON.stringify(parts)}`);
		assert.ok(Math.abs(a.length - b.length) <= 6, `expected a balanced split, got ${a.length}/${b.length}`);
	});

	it("keeps a single word whole rather than chopping it", () => {
		const parts = splitTextAcross("Verklärte", 3);
		assert.deepEqual(parts, ["Verklärte", "", ""]);
	});

	it("returns the requested number of parts even with nothing to split", () => {
		assert.deepEqual(splitTextAcross("", 3), ["", "", ""]);
		assert.deepEqual(splitTextAcross("   ", 2), ["", ""]);
	});

	it("treats a nonsense count as one segment", () => {
		for (const count of [0, -3, Number.NaN]) {
			assert.deepEqual(splitTextAcross("Cruel Summer", count), ["Cruel Summer"], `count ${count}`);
		}
	});

	it("never returns more parts than asked for, however many words there are", () => {
		const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
		assert.equal(splitTextAcross(many, 3).length, 3);
	});
});
