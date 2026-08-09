/**
 * Choosing where to crop a cover so a face survives it.
 *
 * The covers here are encoded by the suite (`tests/helpers/tiny-jpeg.ts`), so "there is a
 * head at the top of this picture" is a fact about the fixture rather than something read
 * off an image nobody can vary. What cannot be settled this way is whether the rule finds
 * heads on *real* artwork — that is what `scripts/probe-cover-focus.ts` is for, and no
 * assertion in this file should be read as a claim about it.
 *
 * The three rules are tested as three separate claims, because the second one exists only
 * to stop the first from cheating: without it, "do not cut this face" is satisfied by
 * shoving the face out of frame.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ArtImage } from "../src/adapter/eiscp/jacket-art.ts";
import { coverFocus, faceRegions, SKIN_WEIGHT, visibleShare } from "../src/actions/face-crop.ts";
import { STRIP_HEIGHT, STRIP_SEGMENT_WIDTH } from "../src/actions/cover-image.ts";
import { type FacePatch, faceCoverBytes, toneCoverBmp } from "./helpers/face-cover.ts";
import { tinyJpeg } from "./helpers/tiny-jpeg.ts";

/** The box the Now Playing dial actually composes into. */
const STRIP = { width: STRIP_SEGMENT_WIDTH, height: STRIP_HEIGHT };

let hashCounter = 0;

function cover(cells: number, patches: readonly FacePatch[]): ArtImage {
	return { type: "jpeg", bytes: faceCoverBytes(cells, patches), frames: 1, hash: `focus${hashCounter++}` };
}

describe("finding the regions of a cover worth not cutting", () => {
	it("finds a head-shaped patch of skin", () => {
		const regions = faceRegions(cover(32, [{ top: 4, bottom: 10, left: 12, right: 18 }]));
		assert.equal(regions.length, 1);
		const [region] = regions;
		assert.ok(region);
		assert.equal(region.weight, SKIN_WEIGHT, "colour alone is not full confidence");
		// The patch is chroma cells 4…10, i.e. luminance rows 8…20, extended upward for
		// hair by 40 % of its height.
		assert.equal(region.bottom, 20);
		assert.ok(region.top < 8 && region.top >= 3, `expected headroom above row 8, got ${region.top}`);
	});

	it("refuses a flat expanse of the same colour", () => {
		// Wood, sand and a sepia wash all sit inside the skin box. What they do not have is
		// anything going on inside them.
		assert.deepEqual(faceRegions(cover(32, [{ top: 4, bottom: 10, left: 12, right: 18, flat: true }])), []);
	});

	it("refuses a patch too wide to be a head", () => {
		assert.deepEqual(faceRegions(cover(32, [{ top: 4, bottom: 8, left: 2, right: 30 }])), []);
	});

	it("refuses one too small to be worth moving the picture for", () => {
		assert.deepEqual(faceRegions(cover(32, [{ top: 4, bottom: 5, left: 12, right: 13 }])), []);
	});

	it("recognises a range of skin tones, not one", () => {
		// The single most important property of the chrominance test, and the one this
		// feature would be worth withdrawing without: the box is stated in chroma alone
		// precisely because what differs most between skin tones is *brightness*, and
		// brightness is not part of it. Measured sRGB values across the Fitzpatrick range,
		// down to one that only just clears the lower luminance bound.
		//
		// The bound is where the honest limit sits: below it a photograph's chroma has
		// collapsed towards neutral and the box would start accepting things that are not
		// skin. Deeper than this — or the same person in shadow — is found by nothing here,
		// and the answer for that cover is the centred crop it already had.
		const tones: [string, [number, number, number]][] = [
			["I", [245, 224, 208]],
			["II", [232, 198, 170]],
			["III", [223, 173, 138]],
			["IV", [188, 129, 91]],
			["V", [140, 85, 55]],
			["VI", [85, 50, 35]],
			["VI, deeper", [60, 35, 25]],
		];
		for (const [name, rgb] of tones) {
			const art: ArtImage = { type: "bmp", bytes: toneCoverBmp(rgb), frames: 1, hash: `tone${name}` };
			assert.equal(faceRegions(art).length, 1, `no region found for skin tone ${name} (${rgb.join(",")})`);
		}
	});

	it("computes the regions of a cover once, not once per repaint", () => {
		// The permanent display repaints every second; this is the only expensive part.
		const art = cover(32, [{ top: 4, bottom: 10, left: 12, right: 18 }]);
		assert.equal(faceRegions(art), faceRegions(art));
	});
});

describe("placing the crop window", () => {
	it("shows only half a square cover on the strip, which is what makes this necessary", () => {
		// The premise, asserted rather than assumed: if this ever stopped being true the
		// rest of the file would be testing a problem that no longer exists.
		assert.equal(visibleShare({ width: 512, height: 512 }, STRIP, "cover"), 0.5);
		assert.equal(visibleShare({ width: 512, height: 512 }, { width: 144, height: 144 }, "cover"), undefined);
		assert.equal(visibleShare({ width: 512, height: 512 }, STRIP, "contain"), undefined);
	});

	it("moves up for a face the centred window would cut", () => {
		// Chroma rows 4…12 are luminance rows 8…24; the centred window is rows 16…48, so
		// it slices this one in half.
		const focus = coverFocus(cover(32, [{ top: 4, bottom: 12, left: 12, right: 20 }]), STRIP);
		assert.equal(focus.reason, "shifted");
		assert.ok(focus.y < 0, `expected a shift towards the top, got ${focus.y}`);
		assert.equal(focus.cut, 0, "and the shift has to actually save it");
	});

	it("keeps a face that is already whole where it is", () => {
		// Chroma rows 12…18 are luminance rows 24…36, and the headroom above starts it at
		// 19 — comfortably inside the centred window of rows 16…48.
		const focus = coverFocus(cover(32, [{ top: 12, bottom: 18, left: 12, right: 18 }]), STRIP);
		assert.equal(focus.reason, "centred");
		assert.equal(focus.y, 0);
	});

	it("leaves the cover alone when it finds nothing", () => {
		const focus = coverFocus(cover(32, []), STRIP);
		assert.deepEqual({ y: focus.y, reason: focus.reason }, { y: 0, reason: "none" });
	});

	it("shows the larger face when no window holds both", () => {
		// One at the very top, one at the very bottom, and the window is half the picture,
		// so it cannot have both. Worth being exact about which rule settles it: **neither
		// face has to be cut**, because the window can simply be placed clear of one — so
		// the cost is nil either way and it is the "then show as much as possible" rule
		// that picks the big one. Rule one only ever arbitrates the case below.
		const focus = coverFocus(
			cover(32, [
				{ top: 1, bottom: 11, left: 10, right: 20 },
				{ top: 26, bottom: 31, left: 12, right: 17 },
			]),
			STRIP,
		);
		assert.equal(focus.cut, 0, "nothing needs to be cut here — one of them is simply left out");
		assert.ok(focus.y < 0, `the big face is at the top, so the window must go up: ${focus.y}`);
	});

	it("fills the window with as much of a too-tall face as it can", () => {
		// A portrait taller than half the cover cannot be shown whole from anywhere, so
		// "cut as little as possible" and "show as much as possible" say the same thing —
		// and it is the second rule that delivers it, because the first deliberately
		// ignores regions it cannot rescue. Asserted as geometry rather than as a cost,
		// since the cost of an unsaveable region is no longer counted at all.
		const tall = cover(32, [{ top: 4, bottom: 26, left: 10, right: 22 }]);
		const regions = faceRegions(tall);
		assert.equal(regions.length, 1);
		const region = regions[0]!;
		const focus = coverFocus(tall, STRIP);
		const span = 64 - 32;
		const top = ((focus.y + 1) / 2) * span;
		assert.ok(
			region.top <= top && region.bottom >= top + 32,
			`the window ${top}…${top + 32} should be entirely face, but the face is ${region.top}…${region.bottom}`,
		);
	});

	it("does not let a region it cannot save decide where the window goes", () => {
		// Found on a real photograph, and it moved the crop the wrong way. Beside the face
		// there was a tall run of skin — a hand and the desk below it — reaching the bottom
		// edge of the frame. No window could show it whole, so every position paid for
		// cutting it, and because it was three times the face's area those unavoidable
		// costs decided the argument: the crop moved *away* from the face to lose slightly
		// less of the desk.
		const focus = coverFocus(
			cover(32, [
				{ top: 3, bottom: 11, left: 12, right: 20 },
				{ top: 14, bottom: 32, left: 3, right: 14 },
			]),
			STRIP,
		);
		assert.ok(focus.y < 0, `the window has to go to the face at the top, not away from it: ${focus.y}`);
	});

	it("pulls a face into frame rather than pushing it out", () => {
		// The rule that stops the first rule cheating. A face straddling the top edge can be
		// "saved" either by including it or by excluding it — both leave nothing cut — and
		// only one of those is what anybody meant.
		const focus = coverFocus(cover(32, [{ top: 2, bottom: 10, left: 12, right: 20 }]), STRIP);
		assert.equal(focus.cut, 0);
		assert.ok(focus.y < 0, `expected the window at the top, got ${focus.y}`);
		// -1 is the topmost window, which is where the face is; +1 would also cut nothing.
		assert.ok(focus.y <= -0.9, `the face has to be shown, not merely uncut: ${focus.y}`);
	});

	it("never asks for a window outside the picture", () => {
		for (const top of [0, 1, 2, 20, 26, 28]) {
			const focus = coverFocus(cover(32, [{ top, bottom: top + 5, left: 12, right: 17 }]), STRIP);
			assert.ok(focus.y >= -1 && focus.y <= 1, `y=${focus.y} for a face at row ${top}`);
		}
	});

	it("says so plainly when there is nothing to decide", () => {
		const art = cover(32, [{ top: 4, bottom: 12, left: 12, right: 20 }]);
		assert.equal(coverFocus(art, { width: 144, height: 144 }).reason, "uncropped");
		assert.equal(coverFocus(art, STRIP, "contain").reason, "uncropped");
		assert.equal(coverFocus(art, STRIP, "contain").y, 0);
	});

	it("still examines a black-and-white cover instead of giving up on it", () => {
		// This used to answer "no colour" and stop, which meant a monochrome sleeve got no
		// face detection at all — while the cascade, which is the *entire* answer for
		// monochrome, reads brightness and never wanted chroma. The test asserted that
		// behaviour, so the bug was pinned rather than caught; it surfaced only when the
		// corpus first contained a real single-component JPEG, and a 1946 photograph went
		// from "no opinion" to a correct upward shift.
		//
		// This fixture has no face in it, so "nothing found" is still the right answer. What
		// changed is which answer: one about the picture, not about the file's format.
		const bytes = tinyJpeg({ width: 512, height: 512, luma: (col, row) => ((col + row) % 3) * 90 });
		const focus = coverFocus({ type: "jpeg", bytes, frames: 1, hash: "mono" }, STRIP);
		assert.deepEqual({ y: focus.y, reason: focus.reason }, { y: 0, reason: "none" });
	});

	it("has no opinion about a cover it cannot read", () => {
		const focus = coverFocus({ type: "jpeg", bytes: Buffer.alloc(64, 0x41), frames: 1, hash: "junk" }, STRIP);
		assert.deepEqual({ y: focus.y, reason: focus.reason }, { y: 0, reason: "unreadable" });
	});
});
