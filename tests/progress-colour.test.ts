/**
 * Choosing the progress colour from the artwork underneath it.
 *
 * The rule is "pick the candidate whose worst section is least bad", so the tests are
 * about the three ways that can be got wrong: sampling the wrong part of the picture,
 * forgetting that the cover is darkened before the progress is drawn on it, and letting
 * a single average speak for a cover that has two halves.
 *
 * The guarantee worth stating out loud, and asserted below: on an even cover the chosen
 * colour is never less than 0.5 apart from it. That is what the earlier three-band
 * version could not promise — a bright sleeve at the default scrim landed on light grey,
 * 0.17 away, which on the device reads as no ring at all.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { LumaGrid } from "../src/actions/image-luma.ts";
import { PROGRESS_BLACK, PROGRESS_GREY, PROGRESS_WHITE, progressColour } from "../src/actions/progress-colour.ts";

/** A 64x64 grid — what a 512x512 cover decodes to — filled by a function of position. */
function grid(fill: (x: number, y: number) => number, size = 64): LumaGrid {
	const data = new Uint8Array(size * size);
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = fill(x, y);
	return { width: size, height: size, data };
}

const flat = (value: number): LumaGrid => grid(() => value);

/** Brightness of a chosen colour, for the contrast assertions. */
const lumaOf: Record<string, number> = { [PROGRESS_WHITE]: 1, [PROGRESS_GREY]: 0x80 / 255, [PROGRESS_BLACK]: 0 };

describe("picking a colour for the progress", () => {
	it("puts white on a dark cover and black on a bright one", () => {
		assert.equal(progressColour(flat(10), "ring", 0), PROGRESS_WHITE);
		assert.equal(progressColour(flat(250), "ring", 0), PROGRESS_BLACK);
	});

	it("never settles for less than half the range on an even cover", () => {
		// The property, over the whole range rather than at a few points. Grey can only
		// ever manage 0.5 at its very best and usually far less, so this is also the
		// assertion that keeps it from being chosen where an extreme would do.
		for (let value = 0; value <= 255; value += 5) {
			for (const scrim of [0, 0.45, 0.8]) {
				const backdrop = (value / 255) * (1 - scrim);
				const chosen = progressColour(flat(value), "ring", scrim);
				const contrast = Math.abs(lumaOf[chosen]! - backdrop);
				assert.ok(contrast >= 0.5, `${value} at scrim ${scrim} chose ${chosen}, only ${contrast.toFixed(2)} apart`);
			}
		}
	});

	it("answers white when there is nothing to look at", () => {
		// No cover, an unreadable one, or an empty grid: white is a real answer here, not
		// a shrug — the placeholder backdrop is nearly black.
		assert.equal(progressColour(undefined, "ring", 0.45), PROGRESS_WHITE);
		assert.equal(progressColour({ width: 0, height: 0, data: new Uint8Array(0) }, "ring", 0), PROGRESS_WHITE);
	});
});

describe("counting the darkening that is already there", () => {
	it("flips a bright cover back to white once it is darkened hard", () => {
		// The progress sits on the *scrimmed* cover, so how bright the sleeve is on its
		// own is not the question.
		assert.equal(progressColour(flat(255), "ring", 0), PROGRESS_BLACK, "undarkened it really is bright");
		assert.equal(progressColour(flat(255), "ring", 0.8), PROGRESS_WHITE);
	});

	it("keeps a bright cover on a readable colour at the default scrim", () => {
		// Measured against the real receiver's own artwork: a bright sleeve lands near
		// 0.53 after the default darkening. The earlier rule answered that with light
		// grey, 0.17 away, which is invisible.
		const chosen = progressColour(flat(245), "ring", 0.45);
		const backdrop = (245 / 255) * 0.55;
		assert.ok(Math.abs(lumaOf[chosen]! - backdrop) >= 0.5, `${chosen} against ${backdrop.toFixed(2)}`);
	});

	it("survives a nonsense scrim rather than producing a colour from NaN", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 5]) {
			const colour = progressColour(flat(10), "ring", bad);
			assert.ok([PROGRESS_WHITE, PROGRESS_GREY, PROGRESS_BLACK].includes(colour), `${bad} gave ${colour}`);
		}
	});
});

describe("a cover with no single answer", () => {
	it("goes grey when the top and the bottom disagree", () => {
		// The case that started this: white above, black below. Either extreme is perfect
		// on one side and gone on the other, and grey is the only one that survives both.
		const split = grid((_x, y) => (y < 32 ? 255 : 0));
		assert.equal(progressColour(split, "ring", 0), PROGRESS_GREY);
	});

	it("goes grey where the average alone would have said black", () => {
		// This cover averages out bright, so an average-only rule would pick black — and
		// black is what disappears against its dark half.
		const uneven = grid((_x, y) => (y < 32 ? 255 : 60));
		assert.ok((255 + 60) / 2 / 255 > 0.6, "the premise: on its average this cover is bright");
		assert.equal(progressColour(uneven, "ring", 0), PROGRESS_GREY);
	});

	it("still takes an even cover at its brightness, however extreme", () => {
		// Grey must not creep in where one of the extremes plainly works.
		assert.equal(progressColour(flat(255), "ring", 0), PROGRESS_BLACK);
		assert.equal(progressColour(flat(0), "ring", 0), PROGRESS_WHITE);
	});

	it("keeps an extreme where one still works on both halves", () => {
		// Bright and mid-bright: black is fine on both, so giving up on it would cost
		// contrast for nothing.
		const gentle = grid((_x, y) => (y < 32 ? 255 : 180));
		assert.equal(progressColour(gentle, "ring", 0), PROGRESS_BLACK);
	});

	it("is not swayed by a small bright mark on an otherwise even cover", () => {
		// Sections are averaged, not maximised — a logo in one corner is not a reason to
		// give up on a colour that works everywhere else.
		const speckled = grid((x, y) => (x < 4 && y < 4 ? 255 : 20));
		assert.equal(progressColour(speckled, "ring", 0), PROGRESS_WHITE);
	});
});

describe("looking only where the progress will be drawn", () => {
	it("ignores the middle of the picture entirely", () => {
		// A dark sleeve with a bright centre must still get white: the ring never
		// touches the middle.
		const bullseye = grid((x, y) => (x > 12 && x < 52 && y > 12 && y < 52 ? 255 : 15));
		assert.equal(progressColour(bullseye, "ring", 0), PROGRESS_WHITE);
	});

	it("gives the same cover different answers for the ring and the bar", () => {
		// A bright strip along the *top*: the ring runs through it and has to give up on a
		// single tone, while the bar never goes near it and can stay white. The two shapes
		// look at different parts of the picture, and this is what that means.
		const brightTop = grid((_x, y) => (y < 6 ? 255 : 20));
		assert.equal(progressColour(brightTop, "ring", 0), PROGRESS_GREY, "the ring crosses both");
		assert.equal(progressColour(brightTop, "bar", 0), PROGRESS_WHITE, "the bar only ever sees the dark end");
	});

	it("still decides something for a grid too small to have four sections", () => {
		// A tiny cover is not a reason to throw: the bands collapse onto each other and
		// whatever is left still has to produce a colour.
		for (const size of [1, 2, 3, 8]) {
			const tiny: LumaGrid = { width: size, height: size, data: new Uint8Array(size * size).fill(240) };
			for (const shape of ["ring", "bar"] as const) {
				const colour = progressColour(tiny, shape, 0);
				assert.ok([PROGRESS_WHITE, PROGRESS_GREY, PROGRESS_BLACK].includes(colour), `${size} ${shape}`);
			}
		}
	});
});
