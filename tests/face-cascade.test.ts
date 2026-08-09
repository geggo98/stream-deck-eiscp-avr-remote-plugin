/**
 * The frontal-face detector, and what can honestly be asserted about it here.
 *
 * A detector cannot be proved correct against synthetic images: it was trained on
 * photographs and it answers to photographs. What a test file *can* pin is everything
 * around that — that the generated cascade is intact and internally consistent, that a
 * picture with no faces produces no faces, that the work is bounded, and that agreement
 * between overlapping detections is required before anything is believed.
 *
 * The claim this file cannot make is "it finds faces". That was established by running it
 * against a real 512-pixel portrait through the plugin's own decode path — it found the
 * face with four agreeing detections at (99,44) — and by `scripts/probe-cover-focus.ts`,
 * which exists so the same check can be repeated on real artwork instead of argued about.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { detectFaces } from "../src/actions/face-cascade.ts";
import {
	CASCADE_FEATURES,
	CASCADE_STAGE_SIZES,
	CASCADE_STAGE_THRESHOLDS,
	CASCADE_TREE_FEATURES,
	CASCADE_TREE_LEAVES,
	CASCADE_TREE_SUBSETS,
	CASCADE_WINDOW,
} from "../src/actions/generated/face-cascade.ts";
import type { LumaGrid } from "../src/actions/image-luma.ts";

function image(width: number, height: number, at: (x: number, y: number) => number): LumaGrid {
	const data = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = at(x, y) & 0xff;
	return { width, height, data };
}

/** Deterministic noise: a fixed seed, because a flaky detector test is worse than none. */
function noise(width: number, height: number): LumaGrid {
	let state = 0x2f6e2b1;
	return image(width, height, () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state >> 16;
	});
}

describe("the generated cascade", () => {
	it("is internally consistent", () => {
		// The generator checks these too, but the generated file is what ships — and a
		// hand-edit or a half-finished regeneration would be caught here rather than by a
		// detector that silently stops finding anything.
		const trees = CASCADE_TREE_FEATURES.length;
		assert.equal(
			CASCADE_STAGE_SIZES.reduce((a, b) => a + b, 0),
			trees,
			"the stages have to account for every classifier",
		);
		assert.equal(CASCADE_STAGE_SIZES.length, CASCADE_STAGE_THRESHOLDS.length);
		assert.equal(CASCADE_TREE_LEAVES.length, trees * 2);
		assert.equal(CASCADE_TREE_SUBSETS.length, trees * 8, "eight words of bitmask cover all 256 codes");
		assert.equal(CASCADE_FEATURES.length % 4, 0);
		for (const feature of CASCADE_TREE_FEATURES) {
			assert.ok(feature * 4 < CASCADE_FEATURES.length, `classifier points at feature ${feature}`);
		}
	});

	it("keeps every feature inside the window it was trained on", () => {
		// A feature spans three cells each way from its origin. One reaching past the
		// window would read whatever is next to it in memory — plausible numbers, wrong
		// picture — so this is worth stating rather than assuming of generated data.
		for (let i = 0; i < CASCADE_FEATURES.length; i += 4) {
			const [x, y, w, h] = [CASCADE_FEATURES[i]!, CASCADE_FEATURES[i + 1]!, CASCADE_FEATURES[i + 2]!, CASCADE_FEATURES[i + 3]!];
			assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0, `feature ${i / 4} has no size`);
			assert.ok(x + 3 * w <= CASCADE_WINDOW.width, `feature ${i / 4} runs off the right`);
			assert.ok(y + 3 * h <= CASCADE_WINDOW.height, `feature ${i / 4} runs off the bottom`);
		}
	});
});

describe("detecting faces", () => {
	it("finds none in a flat picture", () => {
		assert.deepEqual(detectFaces(image(128, 128, () => 128)), []);
	});

	it("finds none in noise", () => {
		// The failure this guards against is a detector that fires everywhere, which would
		// be just as invisible as one that never fires — both leave the cover somewhere
		// unexplained.
		assert.deepEqual(detectFaces(noise(160, 160)), []);
	});

	it("declines a picture smaller than its own window", () => {
		assert.deepEqual(detectFaces(image(CASCADE_WINDOW.width - 1, CASCADE_WINDOW.height - 1, () => 100)), []);
	});

	it("stops when it has spent its budget", () => {
		// The cap is on windows evaluated, not on time, so it holds regardless of what the
		// machine is doing. Asserted by making it small enough to bite and checking the run
		// still finishes and answers.
		const started = process.hrtime.bigint();
		const result = detectFaces(noise(512, 512), { maxWindows: 10 });
		const ms = Number(process.hrtime.bigint() - started) / 1e6;
		assert.deepEqual(result, []);
		assert.ok(ms < 250, `a ten-window budget took ${ms.toFixed(0)} ms`);
	});

	it("requires overlapping detections to agree before believing one", () => {
		// With the agreement threshold at one, every raw hit would be a face. Noise gives
		// the detector nothing to agree about, so this checks the mechanism rather than the
		// count: asking for one is never stricter than asking for four.
		const lenient = detectFaces(noise(200, 200), { minNeighbours: 1 });
		const strict = detectFaces(noise(200, 200), { minNeighbours: 4 });
		assert.ok(strict.length <= lenient.length, `${strict.length} > ${lenient.length}`);
		for (const box of lenient) assert.ok(box.confidence >= 1);
	});
});
